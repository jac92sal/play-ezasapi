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
	title?: string;
	group?: string;
	/** False when the bucket has no `.thumbnails/<key>.jpg` for this video. */
	hasThumb?: boolean;
	fav?: FavLevel;
}

type SortMode = "newest" | "oldest" | "name" | "size" | "favorites";

/** Favorite levels, best first. */
const FAV_LEVELS = ["gold", "silver", "bronze"] as const;
type FavLevel = (typeof FAV_LEVELS)[number];
type FavFilter = "all" | "any" | FavLevel;
const FAV_ICON: Record<FavLevel, string> = { gold: "🥇", silver: "🥈", bronze: "🥉" };
const FAV_LABEL: Record<FavLevel, string> = { gold: "Gold", silver: "Silver", bronze: "Bronze" };

/** 0 = gold … 3 = not a favorite, for "Favorites first" sorting. */
function favRank(v: VideoEntry): number {
	return v.fav ? FAV_LEVELS.indexOf(v.fav) : FAV_LEVELS.length;
}

/** The card's medal button steps none → gold → silver → bronze → none. */
function nextFav(fav: FavLevel | undefined): FavLevel | null {
	if (!fav) return "gold";
	const i = FAV_LEVELS.indexOf(fav);
	return i === FAV_LEVELS.length - 1 ? null : FAV_LEVELS[i + 1];
}

/** How often the grid quietly re-checks the bucket for new/removed videos. */
const REFRESH_INTERVAL_MS = 60_000;

function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

function streamUrl(key: string): string {
	return `/api/stream/${encodeKey(key)}`;
}

/** Ask, then delete the video from the bucket. Resolves true when it is gone. */
async function confirmAndDelete(video: VideoEntry): Promise<boolean> {
	const ok = window.confirm(
		`Delete "${video.name}" (${formatSize(video.size)}) from the bucket?\n\nThis cannot be undone.`,
	);
	if (!ok) return false;
	const r = await fetch(`/api/videos/${encodeKey(video.key)}`, { method: "DELETE" });
	if (r.ok || r.status === 404) return true;
	window.alert(`Delete failed (HTTP ${r.status}).`);
	return false;
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

function displayTitle(video: VideoEntry): string {
	return video.title || prettyName(video.name);
}

const OTHER_GROUP = "Other";

/**
 * Studios whose files are named inconsistently. Keys are the name prefix with
 * spaces and punctuation removed, lower-case; values are the label to show.
 */
const GROUP_ALIASES: Record<string, string> = {
	bsb: "BSB",
	bilatinmen: "BiLatinMen",
	onlyfans: "OnlyFans",
	of: "OnlyFans",
	collegedudes: "College Dudes",
	colledgedudes: "College Dudes",
	colledgdudes: "College Dudes",
	guysinsweatpants: "Guys in Sweatpants",
	chaosmen: "Chaos Men",
	rawfuckclub: "Raw Fuck Club",
	rawfuckers: "Raw Fuckers",
	lucasentertainment: "Lucas Entertainment",
	lucasenterataintment: "Lucas Entertainment",
	lucas: "Lucas Entertainment",
	defiant: "Defiant Skaters",
	defiantskaters: "Defiant Skaters",
	timtales: "TimTales",
	nextdoor: "Next Door",
	cockyboys: "Cocky Boys",
	brothercrush: "Brother Crush",
	sayuncle: "Say Uncle",
	peterfever: "Peter Fever",
	badpuppy: "Bad Puppy",
	ericvideos: "Eric Videos",
	asiantwinks: "Asian Twinks",
	rawhole: "Raw Hole",
	hotrola: "Hot Rola",
	manhunter: "ManHunter",
	twinkaboo: "TwinkAboo",
	falcon: "Falcon",
	maxedge: "Max Edge",
	citebeur: "Citebeur",
	irmaosdotados: "Irmaos Dotados",
	bth: "BTH",
};

const normalizeGroup = (g: string) => g.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess the studio from the file name: "Studio - Title", "Studio_Title",
 * "Studio.title", "Studio 00123", or a known studio word at the start. Random
 * IDs and plain numbers get no group.
 */
function autoGroup(name: string): string | null {
	const base = name.replace(/\.[^.]+$/, "").trim();
	if (/^\d+$/.test(base)) return null;
	const match =
		/^(.+?)\s+-\s+/.exec(base) ??
		/^([A-Za-z][A-Za-z0-9 ]{1,30}?)\s*[_.]\s*\S/.exec(base) ??
		/^([A-Za-z][A-Za-z ]{1,30}?)\s+\d{3,}$/.exec(base);
	const prefix = match?.[1].trim() ?? null;
	if (!prefix || /^\d/.test(prefix)) {
		// No separator: check whether it starts with a known studio word.
		const first = normalizeGroup(base.split(/\s+/).slice(0, 2).join(""));
		const firstWord = normalizeGroup(base.split(/\s+/)[0]);
		if (GROUP_ALIASES[firstWord]) return GROUP_ALIASES[firstWord];
		if (GROUP_ALIASES[first]) return GROUP_ALIASES[first];
		return null;
	}
	const key = normalizeGroup(prefix);
	if (GROUP_ALIASES[key]) return GROUP_ALIASES[key];
	// A random id like "8N1oxUB_4Zc9fQi-" or "t5PrYgAk" is not a studio.
	if (!/[aeiouAEIOU]/.test(prefix) || /^[A-Za-z0-9]{1,2}$/.test(prefix)) return null;
	if (/\d/.test(prefix) && !/\s/.test(prefix)) return null;
	return prefix;
}

function groupOf(video: VideoEntry): string {
	return video.group || autoGroup(video.name) || OTHER_GROUP;
}

/** Edit the display title and group of one video. */
function EditDialog({
	video,
	groups,
	onClose,
	onSaved,
}: {
	video: VideoEntry;
	groups: string[];
	onClose: () => void;
	onSaved: (title: string | null, group: string | null) => void;
}) {
	const [title, setTitle] = useState(video.title ?? "");
	const [group, setGroup] = useState(video.group ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const guessed = autoGroup(video.name);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !busy) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [busy, onClose]);

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const r = await fetch("/api/videos/meta", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key: video.key, title, group }),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const data = (await r.json()) as { title: string | null; group: string | null };
			onSaved(data.title, data.group);
		} catch (err) {
			setError(err instanceof Error ? err.message : "failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="player-overlay" onClick={busy ? undefined : onClose}>
			<form className="edit-panel" onClick={(e) => e.stopPropagation()} onSubmit={save}>
				<div className="upload-head">
					<h2>Edit video</h2>
					<button type="button" className="close" onClick={onClose} disabled={busy}>
						✕
					</button>
				</div>
				<div className="edit-file" title={video.key}>
					File: {video.name}
				</div>
				<label className="edit-field">
					<span>Title</span>
					<input
						type="text"
						value={title}
						autoFocus
						maxLength={200}
						placeholder={prettyName(video.name)}
						onChange={(e) => setTitle(e.target.value)}
					/>
				</label>
				<label className="edit-field">
					<span>Group</span>
					<input
						type="text"
						value={group}
						maxLength={200}
						list="group-options"
						placeholder={guessed ?? OTHER_GROUP}
						onChange={(e) => setGroup(e.target.value)}
					/>
					<datalist id="group-options">
						{groups.map((g) => (
							<option key={g} value={g} />
						))}
					</datalist>
				</label>
				<div className="edit-hint">
					Leave a field empty to use the name from the file
					{guessed ? ` (group guessed as "${guessed}")` : ""}. The file itself is not renamed.
				</div>
				{error && <div className="pin-error">Save failed: {error}</div>}
				<div className="edit-actions">
					<button type="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={busy}>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</div>
	);
}

/** Keys whose thumbnail this page has already tried to save, so each is attempted once. */
const thumbAttempted = new Set<string>();

/**
 * Save the frame a grid card is showing as the video's `.thumbnails/<key>.jpg`,
 * so later visits and the Roku channel get a real poster instead of the
 * placeholder. Skips frames that are almost black (e.g. a fade-in), leaving
 * those for the ffmpeg step in the PC sync script.
 */
function saveFrameAsThumb(el: HTMLVideoElement, key: string) {
	if (thumbAttempted.has(key) || el.readyState < 2 || el.videoWidth === 0) return;
	thumbAttempted.add(key);
	const width = Math.min(640, el.videoWidth);
	const height = Math.round((el.videoHeight / el.videoWidth) * width);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	try {
		ctx.drawImage(el, 0, 0, width, height);
		// Average brightness of a coarse sample; below ~6% counts as black.
		const { data } = ctx.getImageData(0, 0, width, height);
		let sum = 0;
		let n = 0;
		for (let i = 0; i < data.length; i += 4 * 97) {
			sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
			n++;
		}
		if (n === 0 || sum / n < 16) return;
	} catch {
		return;
	}
	canvas.toBlob(
		(blob) => {
			if (!blob) return;
			fetch(`/api/thumb/${encodeKey(key)}`, {
				method: "PUT",
				headers: { "Content-Type": "image/jpeg" },
				body: blob,
			}).catch(() => {
				/* best effort: the card keeps showing the video frame */
			});
		},
		"image/jpeg",
		0.82,
	);
}

/**
 * Grid card — loads its preview only once scrolled into view. Uses the
 * pre-generated JPEG thumbnail; when the bucket has none (or the image fails
 * to load) it shows a frame from the video itself, as newly synced videos have
 * no JPEG yet. Only if the video can't load either does it show the video's
 * name on the tile, so every card is identifiable even without artwork.
 */
function VideoCard({
	video,
	possibleDuplicate,
	onPlay,
	onEdit,
	onDelete,
	onFav,
}: {
	video: VideoEntry;
	possibleDuplicate: boolean;
	onPlay: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onFav: (fav: FavLevel | null) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [thumbFailed, setThumbFailed] = useState(false);
	const [frameFailed, setFrameFailed] = useState(false);
	const useFrame = video.hasThumb === false || thumbFailed;
	const showTitleTile = useFrame && frameFailed;

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
				{showTitleTile ? (
					<div className="thumb-title">
						<span>{prettyName(video.name)}</span>
					</div>
				) : !visible ? (
					<div className="thumb-placeholder" />
				) : useFrame ? (
					<video
						src={`${streamUrl(video.key)}#t=0.5`}
						preload="metadata"
						muted
						playsInline
						onError={() => setFrameFailed(true)}
						onLoadedData={(e) => {
							// Only when the bucket has no JPEG; a JPEG that merely failed to load is kept.
							if (video.hasThumb === false) saveFrameAsThumb(e.currentTarget, video.key);
						}}
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
				{possibleDuplicate && (
					<span className="dup-badge" title="Another video has exactly the same size">
						possible duplicate
					</span>
				)}
				{video.fav && (
					<span className={`fav-badge fav-${video.fav}`} title={`${FAV_LABEL[video.fav]} favorite`}>
						{FAV_ICON[video.fav]}
					</span>
				)}
				<div className="card-actions">
					<button
						className={`card-btn card-fav${video.fav ? " is-fav" : ""}`}
						title={(() => {
							const n = nextFav(video.fav);
							return n ? `Make ${FAV_LABEL[n]} favorite` : "Remove from favorites";
						})()}
						onClick={(e) => {
							e.stopPropagation();
							onFav(nextFav(video.fav));
						}}
					>
						{video.fav ? FAV_ICON[video.fav] : "☆"}
					</button>
					<button
						className="card-btn"
						title="Edit title / group"
						onClick={(e) => {
							e.stopPropagation();
							onEdit();
						}}
					>
						✎
					</button>
					<button
						className="card-btn card-delete"
						title="Delete this video"
						onClick={(e) => {
							e.stopPropagation();
							onDelete();
						}}
					>
						🗑
					</button>
				</div>
			</div>
			<div className="card-meta">
				<div className="card-title">{displayTitle(video)}</div>
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
	const [dupOnly, setDupOnly] = useState(false);
	const [favFilter, setFavFilter] = useState<FavFilter>("all");
	const [grouped, setGrouped] = useState(() => {
		try {
			return localStorage.getItem("play.grouped") === "1";
		} catch {
			return false;
		}
	});
	const [editing, setEditing] = useState<VideoEntry | null>(null);
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

	/** Videos whose byte size matches another video: the usual sign of a copy under a second name. */
	const duplicateKeys = useMemo(() => {
		const bySize = new Map<number, VideoEntry[]>();
		for (const v of videos) {
			const group = bySize.get(v.size);
			if (group) group.push(v);
			else bySize.set(v.size, [v]);
		}
		const keys = new Set<string>();
		for (const group of bySize.values()) {
			if (group.length > 1) for (const v of group) keys.add(v.key);
		}
		return keys;
	}, [videos]);

	const queue = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = videos.filter(
			(v) =>
				(!q ||
					v.name.toLowerCase().includes(q) ||
					v.key.toLowerCase().includes(q) ||
					displayTitle(v).toLowerCase().includes(q) ||
					groupOf(v).toLowerCase().includes(q)) &&
				(!dupOnly || duplicateKeys.has(v.key)) &&
				(favFilter === "all" || (favFilter === "any" ? !!v.fav : v.fav === favFilter)),
		);
		const sorted = [...filtered];
		if (dupOnly) {
			// Keep each same-size pair next to each other so they can be compared.
			sorted.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
			return sorted;
		}
		switch (sort) {
			case "newest":
				sorted.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
				break;
			case "oldest":
				sorted.sort((a, b) => a.uploaded.localeCompare(b.uploaded));
				break;
			case "name":
				sorted.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
				break;
			case "size":
				sorted.sort((a, b) => b.size - a.size);
				break;
			case "favorites":
				sorted.sort((a, b) => favRank(a) - favRank(b) || b.uploaded.localeCompare(a.uploaded));
				break;
		}
		if (grouped) {
			// Stable: keeps the chosen order inside each group, "Other" last.
			const rank = (v: VideoEntry) => {
				const g = groupOf(v);
				return g === OTHER_GROUP ? "\uffff" : g.toLowerCase();
			};
			sorted.sort((a, b) => rank(a).localeCompare(rank(b)));
		}
		return sorted;
	}, [videos, query, sort, dupOnly, duplicateKeys, grouped, favFilter]);

	/** Every group label in use, for the edit dialog's suggestions. */
	const groupNames = useMemo(
		() => [...new Set(videos.map(groupOf))].filter((g) => g !== OTHER_GROUP).sort((a, b) => a.localeCompare(b)),
		[videos],
	);

	/** Contiguous slices of the queue per group (the queue is group-sorted when grouped). */
	const sections = useMemo(() => {
		// The duplicates view is sorted by size so each pair sits together; grouping would split them.
		if (!grouped || dupOnly) return null;
		const out: { group: string; start: number; items: VideoEntry[] }[] = [];
		queue.forEach((v, i) => {
			const g = groupOf(v);
			const last = out[out.length - 1];
			if (last && last.group === g) last.items.push(v);
			else out.push({ group: g, start: i, items: [v] });
		});
		return out;
	}, [queue, grouped, dupOnly]);

	const applyMeta = useCallback((key: string, title: string | null, group: string | null) => {
		setVideos((list) =>
			list.map((v) => {
				if (v.key !== key) return v;
				const next: VideoEntry = { ...v };
				if (title) next.title = title;
				else delete next.title;
				if (group) next.group = group;
				else delete next.group;
				return next;
			}),
		);
	}, []);

	/** Set or clear a favorite level; updates the grid at once and undoes it if saving fails. */
	const setFav = useCallback((video: VideoEntry, fav: FavLevel | null) => {
		const apply = (level: FavLevel | null | undefined) =>
			setVideos((list) =>
				list.map((v) => {
					if (v.key !== video.key) return v;
					const next: VideoEntry = { ...v };
					if (level) next.fav = level;
					else delete next.fav;
					return next;
				}),
			);
		const previous = video.fav;
		apply(fav);
		fetch("/api/videos/fav", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: video.key, fav }),
		})
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
			})
			.catch((e: Error) => {
				apply(previous);
				window.alert(`Could not save favorite (${e.message}).`);
			});
	}, []);

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

	const removeVideo = useCallback(
		async (video: VideoEntry) => {
			const wasPlaying = current?.key === video.key;
			if (wasPlaying) playerRef.current?.pause();
			if (!(await confirmAndDelete(video))) return;
			setVideos((list) => list.filter((v) => v.key !== video.key));
			if (wasPlaying) {
				// Move on to what was next (or the new last video if it was the last one).
				const i = nowPlaying ?? -1;
				const following = queue.length <= 1 || i === -1 ? null : (queue[i + 1] ?? queue[i - 1]);
				setPlayingKey(following ? following.key : null);
			}
		},
		[current, nowPlaying, queue],
	);

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
					<option value="favorites">Favorites first</option>
				</select>
				<select
					className="sort"
					value={favFilter}
					onChange={(e) => setFavFilter(e.target.value as FavFilter)}
					title="Show only favorites"
				>
					<option value="all">All videos</option>
					<option value="any">★ All favorites</option>
					{FAV_LEVELS.map((level) => (
						<option key={level} value={level}>
							{FAV_ICON[level]} {FAV_LABEL[level]}
						</option>
					))}
				</select>
				<label className="toggle dup-toggle" title="Put each studio's videos together">
					<input
						type="checkbox"
						checked={grouped}
						onChange={(e) => {
							setGrouped(e.target.checked);
							try {
								localStorage.setItem("play.grouped", e.target.checked ? "1" : "0");
							} catch {
								/* ignore */
							}
						}}
					/>
					Group by studio
				</label>
				<label className="toggle dup-toggle" title="Show only videos that share an exact size with another video">
					<input
						type="checkbox"
						checked={dupOnly}
						onChange={(e) => setDupOnly(e.target.checked)}
					/>
					Possible duplicates{duplicateKeys.size > 0 ? ` (${duplicateKeys.size})` : ""}
				</label>
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

			{sections ? (
				<main className="sections">
					{sections.map((s) => (
						<section key={s.group} className="group-section">
							<h2 className="group-title">
								{s.group} <span className="group-count">{s.items.length}</span>
							</h2>
							<div className="grid">
								{s.items.map((v, j) => (
									<VideoCard
										key={v.key}
										video={v}
										possibleDuplicate={duplicateKeys.has(v.key)}
										onPlay={() => goTo(s.start + j)}
										onEdit={() => setEditing(v)}
										onDelete={() => void removeVideo(v)}
										onFav={(fav) => setFav(v, fav)}
									/>
								))}
							</div>
						</section>
					))}
				</main>
			) : (
				<main className="grid">
					{queue.map((v, i) => (
						<VideoCard
							key={v.key}
							video={v}
							possibleDuplicate={duplicateKeys.has(v.key)}
							onPlay={() => goTo(i)}
							onEdit={() => setEditing(v)}
							onDelete={() => void removeVideo(v)}
							onFav={(fav) => setFav(v, fav)}
						/>
					))}
				</main>
			)}

			{editing && (
				<EditDialog
					video={editing}
					groups={groupNames}
					onClose={() => setEditing(null)}
					onSaved={(title, group) => {
						applyMeta(editing.key, title, group);
						setEditing(null);
					}}
				/>
			)}

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
								<div className="player-title">
									{displayTitle(current)}
									<span className="player-group">{groupOf(current)}</span>
								</div>
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
									<span className="fav-picker" title="Favorite level">
										{FAV_LEVELS.map((level) => (
											<button
												key={level}
												className={`fav-pick${current.fav === level ? " active" : ""}`}
												onClick={() => setFav(current, current.fav === level ? null : level)}
												title={
													current.fav === level
														? `Remove ${FAV_LABEL[level]} favorite`
														: `Make ${FAV_LABEL[level]} favorite`
												}
											>
												{FAV_ICON[level]}
											</button>
										))}
									</span>
									<button onClick={() => setEditing(current)} title="Edit title / group">
										✎ Edit
									</button>
									<button
										className="danger"
										onClick={() => void removeVideo(current)}
										title="Delete this video from the bucket"
									>
										🗑 Delete
									</button>
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
										<span className="up-next-name">
											{v.fav && <span className="up-next-fav">{FAV_ICON[v.fav]}</span>}
											{displayTitle(v)}
										</span>
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
