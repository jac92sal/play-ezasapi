export interface Camera {
	id: string;
	name: string;
	ready: boolean;
	readyTime: string | null;
	tracks: string[];
	recording: boolean;
	order: number;
}

export interface Recording {
	key: string;
	camera: string;
	name: string;
	size: number;
	uploaded: string;
}

export class Unauthorized extends Error {}

async function json<T>(res: Response): Promise<T> {
	if (res.status === 401) throw new Unauthorized("unauthorized");
	if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
	return res.json() as Promise<T>;
}

export const api = {
	async login(pin: string): Promise<boolean> {
		const res = await fetch("/api/auth", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pin }),
		});
		return res.ok;
	},

	async cameras(): Promise<{ cameras: Camera[] }> {
		return json(await fetch("/api/cameras"));
	},

	async saveNames(cameras: { id: string; name: string }[]): Promise<{ ok: true }> {
		return json(
			await fetch("/api/cameras", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cameras }),
			}),
		);
	},

	async record(camera: string, on: boolean): Promise<{ recording: boolean }> {
		return json(
			await fetch(`/api/record/${on ? "start" : "stop"}/${encodeURIComponent(camera)}`, {
				method: "POST",
			}),
		);
	},

	async recordings(): Promise<{ recordings: Recording[] }> {
		return json(await fetch("/api/recordings"));
	},

	async deleteRecording(key: string): Promise<{ ok: true }> {
		return json(await fetch(`/api/recordings/${encodeURI(key)}`, { method: "DELETE" }));
	},
};

/** Live HLS playlist for a camera, proxied through the Worker. */
export function hlsUrl(cameraId: string): string {
	return `/api/bridge/${encodeURIComponent(cameraId)}/index.m3u8`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = n / 1024;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
