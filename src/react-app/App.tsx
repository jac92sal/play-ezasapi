import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadPanel from "./Upload";
import "./App.css";

interface VideoEntry {
	key: string;
	name: string;
	size: number;
	uploaded: string;
	contentType: string;
	etag: string;
}

type SortMode = "newest" | "oldest" | "name" | "size";

function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

function streamUrl(key: string): string {
	return `/api/stream/${encodeKey(key)}`;
}

function thumbUrl(key: string): string {
	return `/api/thumb/${encodeKey(key)}`;
}

function formatSize(bytes: number): string {
	if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
	if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
	if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
	return `${bytes} B`;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function prettyName(name: string): string {
	return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

/**
 * Grid card — loads its preview only once scrolled into view. Uses the
 * pre-generated JPEG thumbnail; falls back to a first-frame <video> if the
 * thumbnail is missing.
 */
function VideoCard({
	video,
	onPlay,
}: {
	video: VideoEntry;
	onPlay: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [thumbFailed, setThumbFailed] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="card" ref={ref} onClick={onPlay} title={video.name}>
			<div className="thumb">
				{!visible ? (
					<div className="thumb-placeholder" />
				) : thumbFailed ? (
					<video
						src={`${streamUrl(video.key)}#t=0.5`}
						preload="metadata"
						muted
						playsInline
					/>
				) : (
					<img
						src={thumbUrl(video.key)}
						alt=""
						loading="lazy"
						decoding="async"
						onError={() => setThumbFailed(true)}
					/>
				)}
				<span className="play-badge">▶</span>
			</div>
			<div className="card-meta">
				<div className="card-title">{prettyName(video.name)}</div>
				<div className="card-sub">
					{formatSize(video.size)} · {formatDate(video.uploaded)}
				</div>
			</div>
		</div>
	);
}

function PinGate({ onUnlocked }: { onUnlocked: () => void }) {
	const [pin, setPin] = useState("");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy || pin.length === 0) return;
		setBusy(true);
		setFailed(false);
		try {
			const r = await fetch("/api/auth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin }),
			});
			if (r.ok) {
				onUnlocked();
			} else {
				setFailed(true);
				setPin("");
			}
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="pin-gate">
			<form className={`pin-card${failed ? " shake" : ""}`} onSubmit={submit}>
				<div className="pin-logo">▶</div>
				<h1>play.ezasapi</h1>
				<p>Enter PIN to continue</p>
				<input
					type="password"
					inputMode="numeric"
					autoComplete="off"
					autoFocus
					maxLength={8}
					value={pin}
					onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
					placeholder="••••"
				/>
				<button type="submit" disabled={busy || pin.length === 0}>
					{busy ? "Checking…" : "Unlock"}
				</button>
				{failed && <div className="pin-error">Wrong PIN — try again</div>}
			</form>
		</div>
	);
}

export default function App() {
	const [locked, setLocked] = useState<boolean | null>(null);
	const [videos, setVideos] = useState<VideoEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortMode>("newest");
	const [nowPlaying, setNowPlaying] = useState<number | null>(null);
	const [autoNext, setAutoNext] = useState(true);
	const [shuffle, setShuffle] = useState(false);
	const [showUpload, setShowUpload] = useState(false);
	const playerRef = useRef<HTMLVideoElement>(null);

	const loadVideos = useCallback(() => {
		setLoading(true);
		setError(null);
		fetch("/api/videos")
			.then((r) => {
				if (r.status === 401) {
					setLocked(true);
					return null;
				}
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json() as Promise<{ videos: VideoEntry[] }>;
			})
			.then((data) => {
				if (data) {
					setLocked(false);
					setVideos(data.videos);
				}
			})
			.catch((e: Error) => setError(e.message))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		loadVideos();
	}, [loadVideos]);

	const queue = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = videos.filter(
			(v) => !q || v.name.toLowerCase().includes(q) || v.key.toLowerCase().includes(q),
		);
		const sorted = [...filtered];
		switch (sort) {
			case "newest":
				sorted.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
				break;
			case "oldest":
				sorted.sort((a, b) => a.uploaded.localeCompare(b.uploaded));
				break;
			case "name":
				sorted.sort((a, b) => a.name.localeCompare(b.name));
				break;
			case "size":
				sorted.sort((a, b) => b.size - a.size);
				break;
		}
		return sorted;
	}, [videos, query, sort]);

	const current = nowPlaying !== null ? queue[nowPlaying] : null;

	const goTo = useCallback(
		(index: number) => {
			if (queue.length === 0) return;
			setNowPlaying(((index % queue.length) + queue.length) % queue.length);
		},
		[queue.length],
	);

	const next = useCallback(() => {
		if (nowPlaying === null || queue.length === 0) return;
		if (shuffle && queue.length > 1) {
			let pick = nowPlaying;
			while (pick === nowPlaying) {
				pick = Math.floor(Math.random() * queue.length);
			}
			goTo(pick);
		} else {
			goTo(nowPlaying + 1);
		}
	}, [nowPlaying, queue.length, shuffle, goTo]);

	const prev = useCallback(() => {
		if (nowPlaying === null) return;
		goTo(nowPlaying - 1);
	}, [nowPlaying, goTo]);

	const close = useCallback(() => setNowPlaying(null), []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (nowPlaying === null) return;
			if (e.key === "Escape") close();
			if (e.key === "ArrowRight" && e.shiftKey) next();
			if (e.key === "ArrowLeft" && e.shiftKey) prev();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [nowPlaying, close, next, prev]);

	if (locked === true) {
		return <PinGate onUnlocked={loadVideos} />;
	}
	if (locked === null) {
		return <div className="pin-gate"><div className="pin-card"><p>Loading…</p></div></div>;
	}

	return (
		<div className="app">
			<header className="topbar">
				<h1 className="brand">
					<span className="brand-mark">▶</span> play.ezasapi
				</h1>
				<input
					className="search"
					type="search"
					placeholder="Search videos…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<select
					className="sort"
					value={sort}
					onChange={(e) => setSort(e.target.value as SortMode)}
				>
					<option value="newest">Newest first</option>
					<option value="oldest">Oldest first</option>
					<option value="name">Name A–Z</option>
					<option value="size">Largest first</option>
				</select>
				<span className="count">
					{loading ? "Loading…" : `${queue.length} video${queue.length === 1 ? "" : "s"}`}
				</span>
				<button className="upload-btn" onClick={() => setShowUpload(true)}>
					⬆ Upload
				</button>
			</header>

			{error && <div className="notice error">Couldn't load videos: {error}</div>}
			{!loading && !error && queue.length === 0 && (
				<div className="notice">No videos match.</div>
			)}

			<main className="grid">
				{queue.map((v, i) => (
					<VideoCard key={v.key} video={v} onPlay={() => goTo(i)} />
				))}
			</main>

			{showUpload && (
				<UploadPanel
					onClose={() => setShowUpload(false)}
					onUploaded={loadVideos}
				/>
			)}

			{current && (
				<div className="player-overlay" onClick={close}>
					<div className="player-shell" onClick={(e) => e.stopPropagation()}>
						<div className="player-main">
							<video
								ref={playerRef}
								key={current.key}
								src={streamUrl(current.key)}
								controls
								autoPlay
								playsInline
								onEnded={() => {
									if (autoNext) next();
								}}
							/>
							<div className="player-bar">
								<div className="player-title">{prettyName(current.name)}</div>
								<div className="player-controls">
									<button onClick={prev} title="Previous (Shift+←)">⏮ Prev</button>
									<button onClick={next} title="Next (Shift+→)">Next ⏭</button>
									<label className="toggle">
										<input
											type="checkbox"
											checked={autoNext}
											onChange={(e) => setAutoNext(e.target.checked)}
										/>
										Autoplay next
									</label>
									<label className="toggle">
										<input
											type="checkbox"
											checked={shuffle}
											onChange={(e) => setShuffle(e.target.checked)}
										/>
										Shuffle
									</label>
									<button className="close" onClick={close} title="Close (Esc)">
										✕ Close
									</button>
								</div>
							</div>
						</div>
						<aside className="up-next">
							<h2>Up next</h2>
							<ul>
								{queue.map((v, i) => (
									<li
										key={v.key}
										className={i === nowPlaying ? "active" : ""}
										onClick={() => goTo(i)}
									>
										<span className="up-next-index">{i + 1}</span>
										<span className="up-next-name">{prettyName(v.name)}</span>
										<span className="up-next-size">{formatSize(v.size)}</span>
									</li>
								))}
							</ul>
						</aside>
					</div>
				</div>
			)}
		</div>
	);
}
