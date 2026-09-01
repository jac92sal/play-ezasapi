import { useCallback, useEffect, useState } from "react";
import CameraTile from "./CameraTile";
import Recordings from "./Recordings";
import { api, Unauthorized, type Camera } from "./api";
import "./index.css";

type Tab = "wall" | "recordings";

export default function App() {
	const [authed, setAuthed] = useState<boolean | null>(null);
	const [tab, setTab] = useState<Tab>("wall");
	const [cameras, setCameras] = useState<Camera[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [columns, setColumns] = useState(() =>
		Number(localStorage.getItem("cam.columns") ?? 2),
	);
	const [muted, setMuted] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const { cameras } = await api.cameras();
			setCameras(cameras);
			setAuthed(true);
			setError(null);
		} catch (e) {
			if (e instanceof Unauthorized) {
				setAuthed(false);
				return;
			}
			setError(e instanceof Error ? e.message : "Could not reach the bridge");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Keep readiness and recording state honest without reloading the streams.
	useEffect(() => {
		if (authed !== true) return;
		const id = setInterval(() => void refresh(), 5000);
		return () => clearInterval(id);
	}, [authed, refresh]);

	useEffect(() => {
		localStorage.setItem("cam.columns", String(columns));
	}, [columns]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setExpanded(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const toggleRecord = useCallback(async (camera: Camera) => {
		const next = !camera.recording;
		// Optimistic: the 5s poll is the source of truth if the bridge disagrees.
		setCameras((prev) =>
			prev.map((c) => (c.id === camera.id ? { ...c, recording: next } : c)),
		);
		try {
			await api.record(camera.id, next);
		} catch (e) {
			setCameras((prev) =>
				prev.map((c) => (c.id === camera.id ? { ...c, recording: !next } : c)),
			);
			setError(e instanceof Error ? e.message : "Recording command failed");
		}
	}, []);

	if (authed === null) return <div className="boot">Loading…</div>;
	if (authed === false) return <PinGate onSuccess={() => void refresh()} />;

	const shown = expanded ? cameras.filter((c) => c.id === expanded) : cameras;
	const recordingCount = cameras.filter((c) => c.recording).length;

	return (
		<div className="app">
			<header className="topbar">
				<h1>Camera Wall</h1>

				<nav className="tabs">
					<button
						type="button"
						className={tab === "wall" ? "is-active" : ""}
						onClick={() => setTab("wall")}
					>
						Live
					</button>
					<button
						type="button"
						className={tab === "recordings" ? "is-active" : ""}
						onClick={() => setTab("recordings")}
					>
						Recordings
					</button>
				</nav>

				<div className="spacer" />

				{recordingCount > 0 && (
					<span className="rec-badge">
						<span className="rec-dot" aria-hidden />
						{recordingCount} recording
					</span>
				)}

				{tab === "wall" && !expanded && (
					<label className="cols">
						Columns
						<select
							value={columns}
							onChange={(e) => setColumns(Number(e.target.value))}
						>
							{[1, 2, 3, 4].map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
					</label>
				)}

				{tab === "wall" && (
					<button type="button" className="btn" onClick={() => setMuted((m) => !m)}>
						{muted ? "Unmute" : "Mute"}
					</button>
				)}
			</header>

			{error && (
				<div className="banner">
					{error}
					<button type="button" className="btn" onClick={() => void refresh()}>
						Retry
					</button>
				</div>
			)}

			{tab === "recordings" ? (
				<Recordings />
			) : cameras.length === 0 ? (
				<div className="empty">
					<h2>No cameras yet</h2>
					<p>
						Add each camera as a path in <code>bridge/mediamtx.yml</code> on your
						bridge box, then restart it. Cameras appear here automatically.
					</p>
				</div>
			) : (
				<main
					className="wall"
					style={{ "--cols": expanded ? 1 : columns } as React.CSSProperties}
				>
					{shown.map((camera) => (
						<CameraTile
							key={camera.id}
							camera={camera}
							muted={muted}
							expanded={expanded === camera.id}
							onToggleRecord={(c) => void toggleRecord(c)}
							onExpand={(c) => setExpanded((cur) => (cur === c.id ? null : c.id))}
						/>
					))}
				</main>
			)}
		</div>
	);
}

function PinGate({ onSuccess }: { onSuccess: () => void }) {
	const [pin, setPin] = useState("");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setFailed(false);
		const ok = await api.login(pin);
		setBusy(false);
		if (ok) onSuccess();
		else {
			setFailed(true);
			setPin("");
		}
	}

	return (
		<form className="gate" onSubmit={(e) => void submit(e)}>
			<h1>Camera Wall</h1>
			<input
				type="password"
				inputMode="numeric"
				autoComplete="current-password"
				placeholder="PIN"
				value={pin}
				onChange={(e) => setPin(e.target.value)}
				autoFocus
			/>
			<button type="submit" className="btn btn-primary" disabled={busy || !pin}>
				{busy ? "Checking…" : "Unlock"}
			</button>
			{failed && <p className="gate-error">Wrong PIN</p>}
		</form>
	);
}
