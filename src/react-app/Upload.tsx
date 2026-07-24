import { useCallback, useRef, useState } from "react";

const MB = 1024 * 1024;
const FP_CHUNK = 4 * MB;
const PART_SIZE = 48 * MB;
const PART_CONCURRENCY = 3;

type ItemStatus =
	| { kind: "pending" }
	| { kind: "hashing" }
	| { kind: "checking" }
	| { kind: "dup-content"; existingKey: string }
	| { kind: "dup-name" }
	| { kind: "uploading"; pct: number }
	| { kind: "done"; key: string }
	| { kind: "skipped" }
	| { kind: "error"; message: string };

interface UploadItem {
	id: number;
	file: File;
	targetKey: string;
	fingerprint?: string;
	status: ItemStatus;
}

/** SHA-256 of (first 4MB + last 4MB + size) — matches the server-side index. */
async function fingerprintFile(file: File): Promise<string> {
	let blob: Blob;
	if (file.size <= 2 * FP_CHUNK) {
		blob = file;
	} else {
		blob = new Blob([file.slice(0, FP_CHUNK), file.slice(file.size - FP_CHUNK)]);
	}
	const data = new Blob([blob, String(file.size)]);
	const digest = await crypto.subtle.digest("SHA-256", await data.arrayBuffer());
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

function xhrPut(
	url: string,
	body: Blob,
	contentType: string,
	onProgress: (loaded: number) => void,
): Promise<{ status: number; json: unknown }> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		xhr.setRequestHeader("Content-Type", contentType);
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			let json: unknown = null;
			try {
				json = JSON.parse(xhr.responseText);
			} catch {
				/* ignore */
			}
			resolve({ status: xhr.status, json });
		};
		xhr.onerror = () => reject(new Error("network error"));
		xhr.send(body);
	});
}

async function checkDuplicate(
	name: string,
	fingerprint?: string,
): Promise<{ nameExists: boolean; contentDuplicateOf: string | null }> {
	const r = await fetch("/api/upload/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, fingerprint }),
	});
	if (!r.ok) throw new Error(`check failed (${r.status})`);
	return r.json();
}

async function nextFreeName(name: string): Promise<string> {
	const dot = name.lastIndexOf(".");
	const base = dot === -1 ? name : name.slice(0, dot);
	const ext = dot === -1 ? "" : name.slice(dot);
	for (let n = 2; n < 50; n++) {
		const candidate = `${base} (${n})${ext}`;
		const { nameExists } = await checkDuplicate(candidate);
		if (!nameExists) return candidate;
	}
	throw new Error("could not find a free name");
}

async function uploadFile(
	file: File,
	key: string,
	fingerprint: string,
	onProgress: (pct: number) => void,
): Promise<void> {
	const contentType = file.type || "video/mp4";

	if (file.size <= PART_SIZE) {
		const { status } = await xhrPut(
			`/api/upload/direct/${encodeKey(key)}?fingerprint=${fingerprint}`,
			file,
			contentType,
			(loaded) => onProgress(Math.min(99, (loaded / file.size) * 100)),
		);
		if (status !== 200) throw new Error(`upload failed (${status})`);
		onProgress(100);
		return;
	}

	const initRes = await fetch("/api/upload/init", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ key, contentType }),
	});
	if (!initRes.ok) throw new Error(`init failed (${initRes.status})`);
	const { uploadId } = (await initRes.json()) as { uploadId: string };

	const partCount = Math.ceil(file.size / PART_SIZE);
	const loadedByPart = new Map<number, number>();
	const etags: { partNumber: number; etag: string }[] = [];
	const report = () => {
		let loaded = 0;
		for (const v of loadedByPart.values()) loaded += v;
		onProgress(Math.min(99, (loaded / file.size) * 100));
	};

	try {
		let nextPart = 1;
		const workers = Array.from(
			{ length: Math.min(PART_CONCURRENCY, partCount) },
			async () => {
				while (nextPart <= partCount) {
					const partNumber = nextPart++;
					const start = (partNumber - 1) * PART_SIZE;
					const chunk = file.slice(start, Math.min(start + PART_SIZE, file.size));
					const { status, json } = await xhrPut(
						`/api/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`,
						chunk,
						"application/octet-stream",
						(loaded) => {
							loadedByPart.set(partNumber, Math.min(loaded, chunk.size));
							report();
						},
					);
					if (status !== 200) throw new Error(`part ${partNumber} failed (${status})`);
					const { etag } = json as { etag: string };
					etags.push({ partNumber, etag });
					loadedByPart.set(partNumber, chunk.size);
					report();
				}
			},
		);
		await Promise.all(workers);

		etags.sort((a, b) => a.partNumber - b.partNumber);
		const completeRes = await fetch("/api/upload/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, uploadId, parts: etags, fingerprint }),
		});
		if (!completeRes.ok) throw new Error(`complete failed (${completeRes.status})`);
		onProgress(100);
	} catch (e) {
		await fetch("/api/upload/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, uploadId }),
		}).catch(() => {});
		throw e;
	}
}

export default function UploadPanel({
	onClose,
	onUploaded,
}: {
	onClose: () => void;
	onUploaded: () => void;
}) {
	const [items, setItems] = useState<UploadItem[]>([]);
	const [busy, setBusy] = useState(false);
	const nextId = useRef(1);
	const anyUploaded = useRef(false);

	const patch = useCallback((id: number, status: ItemStatus, extra?: Partial<UploadItem>) => {
		setItems((prev) =>
			prev.map((it) => (it.id === id ? { ...it, ...extra, status } : it)),
		);
	}, []);

	const runUpload = useCallback(
		async (item: UploadItem, key: string) => {
			patch(item.id, { kind: "uploading", pct: 0 }, { targetKey: key });
			try {
				await uploadFile(item.file, key, item.fingerprint ?? "", (pct) =>
					patch(item.id, { kind: "uploading", pct }),
				);
				anyUploaded.current = true;
				patch(item.id, { kind: "done", key });
			} catch (e) {
				patch(item.id, {
					kind: "error",
					message: e instanceof Error ? e.message : "upload failed",
				});
			}
		},
		[patch],
	);

	const processFiles = useCallback(
		async (files: File[]) => {
			setBusy(true);
			const newItems: UploadItem[] = files.map((file) => ({
				id: nextId.current++,
				file,
				targetKey: file.name,
				status: { kind: "pending" },
			}));
			setItems((prev) => [...prev, ...newItems]);

			for (const item of newItems) {
				try {
					patch(item.id, { kind: "hashing" });
					const fingerprint = await fingerprintFile(item.file);
					patch(item.id, { kind: "checking" }, { fingerprint });
					const { nameExists, contentDuplicateOf } = await checkDuplicate(
						item.file.name,
						fingerprint,
					);
					if (contentDuplicateOf) {
						patch(item.id, { kind: "dup-content", existingKey: contentDuplicateOf }, { fingerprint });
						continue;
					}
					if (nameExists) {
						patch(item.id, { kind: "dup-name" }, { fingerprint });
						continue;
					}
					await runUpload({ ...item, fingerprint }, item.file.name);
				} catch (e) {
					patch(item.id, {
						kind: "error",
						message: e instanceof Error ? e.message : "failed",
					});
				}
			}
			setBusy(false);
			if (anyUploaded.current) onUploaded();
		},
		[patch, runUpload, onUploaded],
	);

	const resolveDuplicate = useCallback(
		async (item: UploadItem, action: "skip" | "upload") => {
			if (action === "skip") {
				patch(item.id, { kind: "skipped" });
				return;
			}
			try {
				const { nameExists } = await checkDuplicate(item.file.name);
				const key = nameExists ? await nextFreeName(item.file.name) : item.file.name;
				await runUpload(item, key);
				onUploaded();
			} catch (e) {
				patch(item.id, {
					kind: "error",
					message: e instanceof Error ? e.message : "failed",
				});
			}
		},
		[patch, runUpload, onUploaded],
	);

	return (
		<div className="player-overlay" onClick={busy ? undefined : onClose}>
			<div className="upload-panel" onClick={(e) => e.stopPropagation()}>
				<div className="upload-head">
					<h2>Upload videos</h2>
					<button className="close" onClick={onClose} disabled={busy}>
						✕
					</button>
				</div>
				<label className="drop-zone">
					<input
						type="file"
						accept="video/*,.mp4,.m4v,.webm,.mov,.mkv,.avi,.ogv"
						multiple
						hidden
						onChange={(e) => {
							const files = Array.from(e.target.files ?? []);
							e.target.value = "";
							if (files.length) void processFiles(files);
						}}
					/>
					<span>Click to choose video files</span>
					<small>Duplicates are detected by name and by content before uploading</small>
				</label>
				<ul className="upload-list">
					{items.map((it) => (
						<li key={it.id}>
							<div className="upload-row">
								<span className="upload-name" title={it.file.name}>
									{it.targetKey}
								</span>
								<span className="upload-status">
									{it.status.kind === "pending" && "Waiting…"}
									{it.status.kind === "hashing" && "Fingerprinting…"}
									{it.status.kind === "checking" && "Checking for duplicates…"}
									{it.status.kind === "uploading" &&
										`Uploading ${it.status.pct.toFixed(0)}%`}
									{it.status.kind === "done" && "✓ Uploaded"}
									{it.status.kind === "skipped" && "Skipped"}
									{it.status.kind === "error" && `⚠ ${it.status.message}`}
								</span>
							</div>
							{it.status.kind === "uploading" && (
								<div className="progress">
									<div style={{ width: `${it.status.pct}%` }} />
								</div>
							)}
							{it.status.kind === "dup-content" && (
								<div className="dup-box">
									<span>
										Same content already in library as{" "}
										<strong>{it.status.existingKey}</strong>
									</span>
									<button onClick={() => void resolveDuplicate(it, "skip")}>Skip</button>
									<button onClick={() => void resolveDuplicate(it, "upload")}>
										Upload anyway
									</button>
								</div>
							)}
							{it.status.kind === "dup-name" && (
								<div className="dup-box">
									<span>A different video already uses this filename</span>
									<button onClick={() => void resolveDuplicate(it, "skip")}>Skip</button>
									<button onClick={() => void resolveDuplicate(it, "upload")}>
										Upload as copy
									</button>
								</div>
							)}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
