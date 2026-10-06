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
	const token = await authToken(c.env.PLAY_PIN);
	setCookie(c, AUTH_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	// The token is also returned for non-browser clients (the Roku channel).
	return c.json({ ok: true, token });
});

/**
 * Everything else under /api requires the auth token. Browsers send it as the
 * HttpOnly cookie; the Roku channel (whose Poster/Video nodes cannot set
 * headers) sends it as `Authorization: Bearer <token>` or `?auth=<token>`.
 */
app.use("/api/*", async (c, next) => {
	if (c.req.path === "/api/auth") return next();
	const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
	const presented = getCookie(c, AUTH_COOKIE) ?? bearer ?? c.req.query("auth");
	if (!presented || !timingSafeEqual(presented, await authToken(c.env.PLAY_PIN))) {
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
	/** Display title set in the web app (overrides the file name). */
	title?: string;
	/** Studio / collection set in the web app (overrides the name-based guess). */
	group?: string;
	/** Favorite level set in the web app. */
	fav?: FavLevel;
	/** Whether a pre-generated JPEG exists at `.thumbnails/<key>.jpg`. */
	hasThumb: boolean;
}

const THUMB_PREFIX = ".thumbnails/";
const THUMB_SUFFIX = ".jpg";

function thumbKeyFor(videoKey: string): string {
	return `${THUMB_PREFIX}${videoKey}${THUMB_SUFFIX}`;
}

/* ---------------- titles + groups ---------------- */

/** One KV value holds every per-video override, keyed by object key. */
const META_KV_KEY = "library-meta";
const META_FIELD_MAX = 200;

/** Favorite levels, best first. */
const FAV_LEVELS = ["gold", "silver", "bronze"] as const;
type FavLevel = (typeof FAV_LEVELS)[number];

function isFavLevel(v: unknown): v is FavLevel {
	return typeof v === "string" && (FAV_LEVELS as readonly string[]).includes(v);
}

/**
 * Each favorite is its own KV entry `fav:<video key>` (level also kept in the
 * entry's metadata so a list returns it). Separate entries mean quick clicks on
 * several videos can never overwrite each other, unlike the single
 * `library-meta` value.
 */
const FAV_PREFIX = "fav:";
/** KV keys are limited to 512 bytes. */
const KV_KEY_MAX_BYTES = 512;

async function readFavs(kv: KVNamespace): Promise<Map<string, FavLevel>> {
	const favs = new Map<string, FavLevel>();
	let cursor: string | undefined;
	do {
		const page = await kv.list<{ fav?: unknown }>({ prefix: FAV_PREFIX, cursor });
		for (const k of page.keys) {
			const level = k.metadata?.fav;
			if (isFavLevel(level)) favs.set(k.name.slice(FAV_PREFIX.length), level);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return favs;
}

interface VideoMeta {
	title?: string;
	group?: string;
}

async function readMeta(kv: KVNamespace): Promise<Record<string, VideoMeta>> {
	const raw = await kv.get(META_KV_KEY);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, VideoMeta>) : {};
	} catch {
		return {};
	}
}

function writeMeta(kv: KVNamespace, meta: Record<string, VideoMeta>): Promise<void> {
	return kv.put(META_KV_KEY, JSON.stringify(meta));
}

/** List every video object in the bucket (paginates through the full listing). */
app.get("/api/videos", async (c) => {
	const bucket = c.env.ENTERTAINMENTVIDEOS;
	const videos: VideoEntry[] = [];
	const thumbKeys = new Set<string>();
	let cursor: string | undefined;
	const metaPromise = readMeta(c.env.HASHES);
	const favsPromise = readFavs(c.env.HASHES).catch(() => new Map<string, FavLevel>());

	do {
		const page = await bucket.list({
			cursor,
			limit: 1000,
			include: ["httpMetadata"],
		});
		for (const obj of page.objects) {
			if (obj.key.startsWith(THUMB_PREFIX)) {
				if (obj.key.endsWith(THUMB_SUFFIX)) {
					thumbKeys.add(obj.key.slice(THUMB_PREFIX.length, -THUMB_SUFFIX.length));
				}
				continue;
			}
			if (!(extensionOf(obj.key) in VIDEO_EXTENSIONS)) continue;
			videos.push({
				key: obj.key,
				name: obj.key.split("/").pop() ?? obj.key,
				size: obj.size,
				uploaded: obj.uploaded.toISOString(),
				contentType: contentTypeFor(obj.key, obj.httpMetadata?.contentType),
				etag: obj.httpEtag,
				hasThumb: false,
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	for (const video of videos) video.hasThumb = thumbKeys.has(video.key);
	const meta = await metaPromise;
	for (const video of videos) {
		const m = meta[video.key];
		if (!m) continue;
		if (m.title) video.title = m.title;
		if (m.group) video.group = m.group;
	}
	const favs = await favsPromise;
	for (const video of videos) {
		const level = favs.get(video.key);
		if (level) video.fav = level;
	}

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

/**
 * Pre-generated JPEG thumbnail for a video, stored at `.thumbnails/<key>.jpg`.
 *
 * When no thumbnail exists the generic placeholder poster is served instead of
 * a 404, so image-only clients (the Roku PosterGrid) still get a tile. That
 * response is marked with `X-Thumb-Placeholder: 1` and cached only briefly so
 * a later-generated thumbnail shows up quickly.
 */
app.get("/api/thumb/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	const object = await c.env.ENTERTAINMENTVIDEOS.get(thumbKeyFor(key));
	if (!object) {
		const placeholder = await c.env.ASSETS.fetch(
			new URL("/thumb-placeholder.png", c.req.url),
		);
		if (!placeholder.ok) return c.notFound();
		return new Response(placeholder.body, {
			status: 200,
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=300",
				"X-Thumb-Placeholder": "1",
			},
		});
	}

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

/** 4 MB — the slice size the upload fingerprint uses on each end of a file. */
const FP_CHUNK = 4 * 1024 * 1024;

/**
 * Content fingerprint of a stored object, computed the same way the upload
 * page does it: SHA-256 of (first 4 MB + last 4 MB + decimal size), or of the
 * whole file plus size when it is 8 MB or smaller.
 */
async function fingerprintObject(bucket: R2Bucket, key: string, size: number): Promise<string | null> {
	const chunks: Uint8Array[] = [];
	if (size <= 2 * FP_CHUNK) {
		const whole = await bucket.get(key);
		if (!whole) return null;
		chunks.push(new Uint8Array(await whole.arrayBuffer()));
	} else {
		const [head, tail] = await Promise.all([
			bucket.get(key, { range: { offset: 0, length: FP_CHUNK } }),
			bucket.get(key, { range: { suffix: FP_CHUNK } }),
		]);
		if (!head || !tail) return null;
		chunks.push(new Uint8Array(await head.arrayBuffer()), new Uint8Array(await tail.arrayBuffer()));
	}
	chunks.push(new TextEncoder().encode(String(size)));
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const data = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		data.set(c, offset);
		offset += c.byteLength;
	}
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Set or clear the display title and group of a video. Send an empty string
 * (or omit the field) to clear it; the file in the bucket is never renamed.
 */
app.post("/api/videos/meta", async (c) => {
	const body = await c.req.json<{ key?: string; title?: string; group?: string }>().catch(() => null);
	const key = body?.key;
	if (!key || badKey(key)) return c.json({ error: "bad key" }, 400);
	const clean = (v: unknown): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim().replace(/\s+/g, " ");
		return t.length > 0 ? t.slice(0, META_FIELD_MAX) : undefined;
	};
	const head = await c.env.ENTERTAINMENTVIDEOS.head(key);
	if (!head) return c.json({ error: "not found" }, 404);

	const meta = await readMeta(c.env.HASHES);
	const entry: VideoMeta = {};
	const title = clean(body?.title);
	const group = clean(body?.group);
	if (title) entry.title = title;
	if (group) entry.group = group;
	if (Object.keys(entry).length > 0) meta[key] = entry;
	else delete meta[key];
	await writeMeta(c.env.HASHES, meta);
	return c.json({ ok: true, key, title: entry.title ?? null, group: entry.group ?? null });
});

/**
 * Set a video's favorite level ("gold", "silver" or "bronze"), or clear it
 * with `fav: null`. Title and group are left as they are.
 */
app.post("/api/videos/fav", async (c) => {
	const body = await c.req.json<{ key?: string; fav?: unknown }>().catch(() => null);
	const key = body?.key;
	if (!key || badKey(key)) return c.json({ error: "bad key" }, 400);
	const fav = body?.fav ?? null;
	if (fav !== null && !isFavLevel(fav)) return c.json({ error: "bad fav" }, 400);
	const favKey = `${FAV_PREFIX}${key}`;
	if (new TextEncoder().encode(favKey).byteLength > KV_KEY_MAX_BYTES) {
		return c.json({ error: "key too long to favorite" }, 400);
	}
	const head = await c.env.ENTERTAINMENTVIDEOS.head(key);
	if (!head) return c.json({ error: "not found" }, 404);

	if (fav) await c.env.HASHES.put(favKey, fav, { metadata: { fav } });
	else await c.env.HASHES.delete(favKey);
	return c.json({ ok: true, key, fav });
});

/**
 * Delete a video. Removes the object, its `.thumbnails/<key>.jpg`, and the
 * fingerprint index entry if it points at this key (so the same content can
 * be uploaded again later without being reported as a duplicate of a file
 * that no longer exists).
 */
app.delete("/api/videos/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	if (badKey(key) || key.startsWith(THUMB_PREFIX)) return c.json({ error: "bad key" }, 400);
	const bucket = c.env.ENTERTAINMENTVIDEOS;

	const head = await bucket.head(key);
	if (!head) return c.json({ error: "not found" }, 404);

	let fingerprintCleared = false;
	const fingerprint = await fingerprintObject(bucket, key, head.size).catch(() => null);
	if (fingerprint) {
		const fpKey = `${FP_PREFIX}${fingerprint}`;
		const hit = await c.env.HASHES.get(fpKey);
		if (hit) {
			let indexed: string | undefined;
			try {
				indexed = (JSON.parse(hit) as { key?: string }).key;
			} catch {
				indexed = hit;
			}
			if (indexed === key) {
				await c.env.HASHES.delete(fpKey);
				fingerprintCleared = true;
			}
		}
	}

	const thumbKey = `${THUMB_PREFIX}${key}.jpg`;
	await bucket.delete([key, thumbKey]);

	const meta = await readMeta(c.env.HASHES);
	if (meta[key]) {
		delete meta[key];
		await writeMeta(c.env.HASHES, meta);
	}
	await c.env.HASHES.delete(`${FAV_PREFIX}${key}`);
	return c.json({ ok: true, key, size: head.size, fingerprintCleared });
});

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
