import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

type Bindings = Env & {
	/** Access PIN for the wall. */
	CAM_PIN: string;
	/** Public origin of the LAN bridge, e.g. https://bridge.ezasapi.com (no trailing slash). */
	BRIDGE_URL: string;
	/** Shared bearer token the bridge requires on every request. */
	BRIDGE_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const AUTH_COOKIE = "cam_auth";
const AUTH_MESSAGE = "cam-ezasapi-auth-v1";
const META_KEY = "roster:meta";

async function authToken(pin: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pin),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(AUTH_MESSAGE));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
	if (!pin || !timingSafeEqual(pin, c.env.CAM_PIN)) {
		// Slow down brute-force attempts.
		await new Promise((resolve) => setTimeout(resolve, 500));
		return c.json({ ok: false }, 401);
	}
	setCookie(c, AUTH_COOKIE, await authToken(c.env.CAM_PIN), {
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
	if (!cookie || !timingSafeEqual(cookie, await authToken(c.env.CAM_PIN))) {
		return c.json({ error: "unauthorized" }, 401);
	}
	return next();
});

/**
 * Call the bridge's MediaMTX control API. Camera credentials never leave the
 * bridge — this app only ever refers to cameras by their MediaMTX path name.
 */
async function bridgeApi(
	env: Bindings,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return fetch(`${env.BRIDGE_URL}/api${path}`, {
		...init,
		headers: {
			...(init?.headers as Record<string, string> | undefined),
			Authorization: `Bearer ${env.BRIDGE_TOKEN}`,
		},
	});
}

interface MediaMtxPath {
	name: string;
	ready: boolean;
	readyTime: string | null;
	tracks: string[];
	bytesReceived: number;
}

export interface Camera {
	id: string;
	name: string;
	ready: boolean;
	readyTime: string | null;
	tracks: string[];
	recording: boolean;
	order: number;
}

type Meta = Record<string, { name?: string; order?: number }>;

/**
 * Live camera roster: whatever the bridge currently has configured, decorated
 * with the display name and ordering we keep in KV.
 */
app.get("/api/cameras", async (c) => {
	const [pathsRes, confRes, metaRaw] = await Promise.all([
		bridgeApi(c.env, "/v3/paths/list?itemsPerPage=1000"),
		bridgeApi(c.env, "/v3/config/paths/list?itemsPerPage=1000"),
		c.env.CAMERAS.get(META_KEY),
	]);

	if (!pathsRes.ok) {
		return c.json({ error: "bridge unreachable", status: pathsRes.status }, 502);
	}

	const paths = (await pathsRes.json<{ items: MediaMtxPath[] }>()).items ?? [];
	// A path is "recording" when its running config has record enabled.
	const recording = new Set<string>();
	if (confRes.ok) {
		const conf = await confRes.json<{ items: { name: string; record?: boolean }[] }>();
		for (const item of conf.items ?? []) if (item.record) recording.add(item.name);
	}

	let meta: Meta = {};
	if (metaRaw) {
		try {
			meta = JSON.parse(metaRaw) as Meta;
		} catch {
			meta = {};
		}
	}

	const cameras: Camera[] = paths
		.filter((p) => !p.name.startsWith("~"))
		.map((p, i) => ({
			id: p.name,
			name: meta[p.name]?.name ?? p.name,
			ready: p.ready,
			readyTime: p.readyTime,
			tracks: p.tracks ?? [],
			recording: recording.has(p.name),
			order: meta[p.name]?.order ?? 1000 + i,
		}))
		.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

	return c.json({ cameras }, 200, { "Cache-Control": "no-store" });
});

/** Save display names / ordering. Never stores camera credentials. */
app.put("/api/cameras", async (c) => {
	const body = await c.req.json<{ cameras?: { id: string; name: string }[] }>();
	if (!Array.isArray(body.cameras)) return c.json({ error: "bad body" }, 400);

	const meta: Meta = {};
	body.cameras.forEach((cam, order) => {
		if (typeof cam.id !== "string" || !cam.id) return;
		meta[cam.id] = { name: String(cam.name ?? cam.id).slice(0, 80), order };
	});
	await c.env.CAMERAS.put(META_KEY, JSON.stringify(meta));
	return c.json({ ok: true });
});

function validPath(name: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

/**
 * Recording is done by the bridge, not the browser: it writes full-quality
 * fMP4 straight from the source with no re-encode, and keeps going after you
 * close the tab. The rclone sidecar syncs finished segments to R2.
 */
async function setRecording(env: Bindings, camera: string, record: boolean) {
	return bridgeApi(env, `/v3/config/paths/patch/${encodeURIComponent(camera)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ record }),
	});
}

app.post("/api/record/:action{start|stop}/:camera", async (c) => {
	const camera = c.req.param("camera");
	const record = c.req.param("action") === "start";
	if (!validPath(camera)) return c.json({ error: "bad camera" }, 400);

	const res = await setRecording(c.env, camera, record);
	if (!res.ok) {
		return c.json({ error: await res.text().catch(() => "bridge error") }, 502);
	}
	return c.json({ ok: true, camera, recording: record });
});

const RECORDINGS_PREFIX = "cam/";

export interface Recording {
	key: string;
	camera: string;
	name: string;
	size: number;
	uploaded: string;
}

/** Recordings already synced to R2. */
app.get("/api/recordings", async (c) => {
	const camera = c.req.query("camera");
	if (camera && !validPath(camera)) return c.json({ error: "bad camera" }, 400);

	const recordings: Recording[] = [];
	let cursor: string | undefined;
	do {
		const page = await c.env.RECORDINGS.list({
			prefix: camera ? `${RECORDINGS_PREFIX}${camera}/` : RECORDINGS_PREFIX,
			cursor,
			limit: 1000,
		});
		for (const obj of page.objects) {
			if (!obj.key.endsWith(".mp4")) continue;
			const rest = obj.key.slice(RECORDINGS_PREFIX.length);
			recordings.push({
				key: obj.key,
				camera: rest.split("/")[0] ?? "unknown",
				name: obj.key.split("/").pop() ?? obj.key,
				size: obj.size,
				uploaded: obj.uploaded.toISOString(),
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	recordings.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
	return c.json({ recordings }, 200, { "Cache-Control": "no-store" });
});

/** Play back a recording, with Range support so seeking works. */
app.on(["GET", "HEAD"], "/api/recordings/stream/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	if (!key.startsWith(RECORDINGS_PREFIX) || key.includes("..")) {
		return c.json({ error: "bad key" }, 400);
	}

	if (c.req.method === "HEAD") {
		const head = await c.env.RECORDINGS.head(key);
		if (!head) return c.notFound();
		return c.body(null, 200, {
			"Content-Length": String(head.size),
			"Content-Type": "video/mp4",
			"Accept-Ranges": "bytes",
			ETag: head.httpEtag,
		});
	}

	const range = c.req.header("Range");
	const object = await c.env.RECORDINGS.get(key, {
		range: range ? c.req.raw.headers : undefined,
	});
	if (!object) return c.notFound();

	const headers: Record<string, string> = {
		"Content-Type": "video/mp4",
		"Accept-Ranges": "bytes",
		ETag: object.httpEtag,
		"Cache-Control": "private, max-age=3600",
	};
	let status = 200;
	if (object.range && "offset" in object.range) {
		const offset = object.range.offset ?? 0;
		const length = object.range.length ?? object.size - offset;
		headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${object.size}`;
		headers["Content-Length"] = String(length);
		status = 206;
	} else {
		headers["Content-Length"] = String(object.size);
	}
	return c.body(object.body, status as 200 | 206, headers);
});

app.delete("/api/recordings/:key{.+}", async (c) => {
	const key = decodeURIComponent(c.req.param("key"));
	if (!key.startsWith(RECORDINGS_PREFIX) || key.includes("..")) {
		return c.json({ error: "bad key" }, 400);
	}
	await c.env.RECORDINGS.delete(key);
	return c.json({ ok: true });
});

/**
 * Authenticated pass-through to the bridge's HLS server. Keeping the bridge
 * behind this proxy means the tunnel hostname and its token are never exposed
 * to the browser, and relative playlist URIs still resolve.
 */
app.all("/api/bridge/*", async (c) => {
	const suffix = c.req.path.slice("/api/bridge".length);
	const url = new URL(c.req.url);
	const target = `${c.env.BRIDGE_URL}${suffix}${url.search}`;

	const headers = new Headers();
	const range = c.req.header("Range");
	if (range) headers.set("Range", range);
	headers.set("Authorization", `Bearer ${c.env.BRIDGE_TOKEN}`);

	const upstream = await fetch(target, {
		method: c.req.method,
		headers,
		body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
	});

	const out = new Headers(upstream.headers);
	// Live playlists and segments must never be cached by the edge.
	out.set("Cache-Control", "no-store");
	out.delete("set-cookie");
	return new Response(upstream.body, { status: upstream.status, headers: out });
});

export default app;
