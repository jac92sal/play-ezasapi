import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

type Bindings = Env & { PLAY_PIN: string };

const app = new Hono<{ Bindings: Bindings }>();

const AUTH_COOKIE = "play_auth";
const AUTH_MESSAGE = "play-ezasapi-auth-v1";

async function authToken(pin: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pin),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(AUTH_MESSAGE),
	);
	return [...new Uint8Array(sig)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** PIN login — issues an HttpOnly signed cookie. */
app.post("/api/auth", async (c) => {
	const body = await c.req.json<{ pin?: string }>().catch(() => ({ pin: undefined }));
	const pin = String(body.pin ?? "");
	if (!pin || !timingSafeEqual(pin, c.env.PLAY_PIN)) {
		// Slow down brute-force attempts.
		await new Promise((resolve) => setTimeout(resolve, 500));
		return c.json({ ok: false }, 401);
	}
	setCookie(c, AUTH_COOKIE, await authToken(c.env.PLAY_PIN), {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	return c.json({ ok: true });
});

/** Everything else under /api requires the auth cookie. */
app.use("/api/*", async (c, next) => {
	if (c.req.path === "/api/auth") return next();
	const cookie = getCookie(c, AUTH_COOKIE);
	if (!cookie || !timingSafeEqual(cookie, await authToken(c.env.PLAY_PIN))) {
		return c.json({ error: "unauthorized" }, 401);
	}
	return next();
});

const VIDEO_EXTENSIONS: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/x-m4v",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	ogv: "video/ogg",
};

function extensionOf(key: string): string {
	const dot = key.lastIndexOf(".");
	return dot === -1 ? "" : key.slice(dot + 1).toLowerCase();
}

function contentTypeFor(key: string, stored?: string): string {
	if (stored && stored !== "application/octet-stream") return stored;
	return VIDEO_EXTENSIONS[extensionOf(key)] ?? "application/octet-stream";
}

export interface VideoEntry {
	key: string;
	name: string;
	size: number;
	uploaded: string;
	contentType: string;
	etag: string;
}

/** List every video object in the bucket (paginates through the full listing). */
app.get("/api/videos", async (c) => {
	const bucket = c.env.ENTERTAINMENTVIDEOS;
	const videos: VideoEntry[] = [];
	let cursor: string | undefined;

	do {
		const page = await bucket.list({
			cursor,
			limit: 1000,
			include: ["httpMetadata"],
		});
		for (const obj of page.objects) {
			if (!(extensionOf(obj.key) in VIDEO_EXTENSIONS)) continue;
			videos.push({
				key: obj.key,
				name: obj.key.split("/").pop() ?? obj.key,
				size: obj.size,
				uploaded: obj.uploaded.toISOString(),
				contentType: contentTypeFor(obj.key, obj.httpMetadata?.contentType),
				etag: obj.httpEtag,
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return c.json(
		{ videos, count: videos.length },
		200,
		{ "Cache-Control": "no-cache" },
	);
});

/** Stream a video with full HTTP Range support so seeking works. */
app.on(["GET", "HEAD"], "/api/stream/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	const bucket = c.env.ENTERTAINMENTVIDEOS;

	if (c.req.method === "HEAD") {
		const head = await bucket.head(key);
		if (!head) return c.notFound();
		return c.body(null, 200, {
			"Content-Length": String(head.size),
			"Content-Type": contentTypeFor(key, head.httpMetadata?.contentType),
			"Accept-Ranges": "bytes",
			ETag: head.httpEtag,
		});
	}

	const rangeHeader = c.req.header("Range");
	const object = await bucket.get(key, {
		range: rangeHeader ? c.req.raw.headers : undefined,
	});
	if (!object) return c.notFound();

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("Content-Type", contentTypeFor(key, object.httpMetadata?.contentType));
	headers.set("Accept-Ranges", "bytes");
	headers.set("ETag", object.httpEtag);
	headers.set("Cache-Control", "public, max-age=3600");

	if (rangeHeader && object.range) {
		const range = object.range;
		let start: number;
		let end: number;
		const suffix = "suffix" in range ? range.suffix : undefined;
		const offset = "offset" in range ? range.offset : undefined;
		const length = "length" in range ? range.length : undefined;
		if (typeof suffix === "number") {
			start = object.size - suffix;
			end = object.size - 1;
		} else {
			start = offset ?? 0;
			end = typeof length === "number" ? start + length - 1 : object.size - 1;
		}
		headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
		headers.set("Content-Length", String(end - start + 1));
		return new Response(object.body, { status: 206, headers });
	}

	headers.set("Content-Length", String(object.size));
	return new Response(object.body, { status: 200, headers });
});

/** Pre-generated JPEG thumbnail for a video, stored at `.thumbnails/<key>.jpg`. */
app.get("/api/thumb/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	const object = await c.env.ENTERTAINMENTVIDEOS.get(`.thumbnails/${key}.jpg`);
	if (!object) return c.notFound();

	return new Response(object.body, {
		status: 200,
		headers: {
			"Content-Type": "image/jpeg",
			"Content-Length": String(object.size),
			ETag: object.httpEtag,
			"Cache-Control": "public, max-age=86400, s-maxage=604800",
		},
	});
});

/* ---------------- uploads ---------------- */

const FP_PREFIX = "fp:";

function badKey(key: string): boolean {
	return (
		key.length === 0 ||
		key.length > 900 ||
		key.startsWith("/") ||
		key.includes("..") ||
		key.includes("\\")
	);
}

/** Duplicate check: by filename and by content fingerprint. */
app.post("/api/upload/check", async (c) => {
	const { name, fingerprint } = await c.req.json<{
		name?: string;
		fingerprint?: string;
	}>();
	if (!name || badKey(name)) return c.json({ error: "bad name" }, 400);

	const [head, fpHit] = await Promise.all([
		c.env.ENTERTAINMENTVIDEOS.head(name),
		fingerprint
			? c.env.HASHES.get(`${FP_PREFIX}${fingerprint}`)
			: Promise.resolve(null),
	]);

	let contentDuplicateOf: string | null = null;
	if (fpHit) {
		try {
			contentDuplicateOf = (JSON.parse(fpHit) as { key: string }).key;
		} catch {
			contentDuplicateOf = fpHit;
		}
	}
	return c.json({ nameExists: head !== null, contentDuplicateOf });
});

/** Small files — single-request upload. */
app.put("/api/upload/direct/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	if (badKey(key)) return c.json({ error: "bad key" }, 400);
	const fingerprint = c.req.query("fingerprint");
	const contentType = c.req.header("Content-Type") ?? "application/octet-stream";

	const object = await c.env.ENTERTAINMENTVIDEOS.put(key, c.req.raw.body, {
		httpMetadata: { contentType },
	});
	if (fingerprint) {
		await c.env.HASHES.put(
			`${FP_PREFIX}${fingerprint}`,
			JSON.stringify({ key, size: object.size }),
		);
	}
	return c.json({ ok: true, key, size: object.size });
});

/** Large files — R2 multipart. */
app.post("/api/upload/init", async (c) => {
	const { key, contentType } = await c.req.json<{
		key?: string;
		contentType?: string;
	}>();
	if (!key || badKey(key)) return c.json({ error: "bad key" }, 400);
	const upload = await c.env.ENTERTAINMENTVIDEOS.createMultipartUpload(key, {
		httpMetadata: { contentType: contentType ?? "application/octet-stream" },
	});
	return c.json({ key: upload.key, uploadId: upload.uploadId });
});

app.put("/api/upload/part", async (c) => {
	const key = c.req.query("key");
	const uploadId = c.req.query("uploadId");
	const partNumber = Number(c.req.query("part"));
	if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
		return c.json({ error: "bad params" }, 400);
	}
	if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
	const upload = c.env.ENTERTAINMENTVIDEOS.resumeMultipartUpload(key, uploadId);
	try {
		const part = await upload.uploadPart(partNumber, c.req.raw.body);
		return c.json({ partNumber: part.partNumber, etag: part.etag });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : "part failed" }, 400);
	}
});

app.post("/api/upload/complete", async (c) => {
	const { key, uploadId, parts, fingerprint } = await c.req.json<{
		key?: string;
		uploadId?: string;
		parts?: { partNumber: number; etag: string }[];
		fingerprint?: string;
	}>();
	if (!key || !uploadId || !parts?.length) return c.json({ error: "bad params" }, 400);
	const upload = c.env.ENTERTAINMENTVIDEOS.resumeMultipartUpload(key, uploadId);
	try {
		const object = await upload.complete(parts);
		if (fingerprint) {
			await c.env.HASHES.put(
				`${FP_PREFIX}${fingerprint}`,
				JSON.stringify({ key, size: object.size }),
			);
		}
		return c.json({ ok: true, key, size: object.size });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : "complete failed" }, 400);
	}
});

/** Register a fingerprint for an object uploaded out-of-band (e.g. rclone sync). */
app.post("/api/upload/register", async (c) => {
	const { key, fingerprint } = await c.req.json<{
		key?: string;
		fingerprint?: string;
	}>();
	if (!key || badKey(key) || !fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) {
		return c.json({ error: "bad params" }, 400);
	}
	const head = await c.env.ENTERTAINMENTVIDEOS.head(key);
	if (!head) return c.json({ error: "object not found" }, 404);
	await c.env.HASHES.put(
		`${FP_PREFIX}${fingerprint}`,
		JSON.stringify({ key, size: head.size }),
	);
	return c.json({ ok: true, key, size: head.size });
});

app.post("/api/upload/abort", async (c) => {
	const { key, uploadId } = await c.req.json<{ key?: string; uploadId?: string }>();
	if (!key || !uploadId) return c.json({ error: "bad params" }, 400);
	const upload = c.env.ENTERTAINMENTVIDEOS.resumeMultipartUpload(key, uploadId);
	await upload.abort().catch(() => {});
	return c.json({ ok: true });
});

export default app;
