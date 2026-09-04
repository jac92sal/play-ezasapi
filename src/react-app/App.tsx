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

/** How often the grid quietly re-checks the bucket for new/removed videos. */
const REFRESH_INTERVAL_MS = 60_000;

function streamUrl(key: string): string {
	return `/api/stream/${key.split("/").map(encodeURIComponent).join("/")}`;
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

/** Grid card — loads its preview (first frame) only once scrolled into view. */
function VideoCard({
	video,
	onPlay,
}: {
	video: VideoEntry;
	onPlay: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);

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
				{visible ? (
					<video
						src={`${streamUrl(video.key)}#t=0.5`}
						preload="metadata"
						muted
						playsInline
					/>
				) : (
					<div className="thumb-placeholder" />
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
	const [playingKey, setPlayingKey] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
	const [autoNext, setAutoNext] = useState(true);
	const [shuffle, setShuffle] = useState(false);
	const [showUpload, setShowUpload] = useState(false);
	const playerRef = useRef<HTMLVideoElement>(null);

	const inFlight = useRef(false);

	/** Fetch the listing; all state updates happen once the request settles. */
	const fetchVideos = useCallback(() => {
		if (inFlight.current) return;
		inFlight.current = true;
		fetch("/api/videos", { cache: "no-store" })
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
					setLastUpdated(new Date());
					setError(null);
				}
			})
			.catch((e: Error) => setError(e.message))
			.finally(() => {
				inFlight.current = false;
				setLoading(false);
				setRefreshing(false);
			});
	}, []);

	/**
	 * Re-fetch the listing from the bucket. A "silent" refresh keeps the
	 * current grid on screen (no loading state) so background updates don't
	 * flicker; the Refresh button and PIN unlock use the normal mode.
	 */
	const loadVideos = useCallback(
		(opts: { silent?: boolean } = {}) => {
			if (inFlight.current) return;
			if (!opts.silent) setLoading(true);
			setRefreshing(true);
			fetchVideos();
		},
		[fetchVideos],
	);

	// Initial load: `loading` already starts true, so no state needs to be
	// set here before the request goes out.
	useEffect(() => {
		fetchVideos();
	}, [fetchVideos]);

	// Keep the list current without a page reload: re-check when the tab
	// comes back into view and on a timer while it is visible.
	useEffect(() => {
		if (locked !== false) return;
		const refreshIfVisible = () => {
			if (document.visibilityState === "visible") loadVideos({ silent: true });
		};
		document.addEventListener("visibilitychange", refreshIfVisible);
		window.addEventListener("focus", refreshIfVisible);
		const timer = window.setInterval(refreshIfVisible, REFRESH_INTERVAL_MS);
		return () => {
			document.removeEventListener("visibilitychange", refreshIfVisible);
			window.removeEventListener("focus", refreshIfVisible);
			window.clearInterval(timer);
		};
	}, [locked, loadVideos]);

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

	// Track the playing video by key so a list refresh (or a re-sort) while
	// something is playing doesn't jump to a different video.
	const nowPlaying = useMemo(() => {
		if (playingKey === null) return null;
		const i = queue.findIndex((v) => v.key === playingKey);
		return i === -1 ? null : i;
	}, [queue, playingKey]);
	const current = nowPlaying !== null ? queue[nowPlaying] : null;

	const goTo = useCallback(
		(index: number) => {
			if (queue.length === 0) return;
			setPlayingKey(queue[((index % queue.length) + queue.length) % queue.length].key);
		},
		[queue],
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

	const close = useCallback(() => setPlayingKey(null), []);

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
		return <PinGate onUnlocked={() => loadVideos()} />;
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
				<button
					className={`refresh-btn${refreshing ? " spinning" : ""}`}
					onClick={() => loadVideos()}
					disabled={refreshing}
					title={
						lastUpdated
							? `Refresh list (updated ${lastUpdated.toLocaleTimeString()})`
							: "Refresh list"
					}
				>
					<span className="refresh-icon">↻</span> Refresh
				</button>
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
					onUploaded={() => loadVideos({ silent: true })}
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
