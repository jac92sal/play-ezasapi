import { useEffect, useRef, useState } from "react";
import Hls from "hls.js/light";
import { hlsUrl, formatDuration, type Camera } from "./api";

interface Props {
	camera: Camera;
	muted: boolean;
	onToggleRecord: (camera: Camera) => void;
	onExpand: (camera: Camera) => void;
	expanded?: boolean;
}

type Status = "connecting" | "live" | "offline" | "error";

export default function CameraTile({
	camera,
	muted,
	onToggleRecord,
	onExpand,
	expanded = false,
}: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [status, setStatus] = useState<Status>("connecting");
	const [elapsed, setElapsed] = useState(0);

	// Tick the recording timer.
	useEffect(() => {
		if (!camera.recording) {
			setElapsed(0);
			return;
		}
		const started = Date.now();
		const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
		return () => clearInterval(id);
	}, [camera.recording]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		if (!camera.ready) {
			setStatus("offline");
			return;
		}

		const src = hlsUrl(camera.id);
		setStatus("connecting");

		// Safari plays HLS natively; everyone else goes through hls.js.
		if (!Hls.isSupported()) {
			video.src = src;
			const onPlaying = () => setStatus("live");
			const onError = () => setStatus("error");
			video.addEventListener("playing", onPlaying);
			video.addEventListener("error", onError);
			void video.play().catch(() => {});
			return () => {
				video.removeEventListener("playing", onPlaying);
				video.removeEventListener("error", onError);
				video.removeAttribute("src");
				video.load();
			};
		}

		const hls = new Hls({
			// Tuned for a live wall: stay near the edge, recover quietly.
			lowLatencyMode: true,
			liveSyncDurationCount: 2,
			backBufferLength: 10,
			manifestLoadingMaxRetry: 6,
			levelLoadingMaxRetry: 6,
			fragLoadingMaxRetry: 6,
		});
		hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
		hls.on(Hls.Events.FRAG_BUFFERED, () => setStatus("live"));
		hls.on(Hls.Events.ERROR, (_evt, data) => {
			if (!data.fatal) return;
			if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
				setStatus("connecting");
				hls.startLoad();
			} else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
				hls.recoverMediaError();
			} else {
				setStatus("error");
				hls.destroy();
			}
		});
		hls.loadSource(src);
		hls.attachMedia(video);
		return () => hls.destroy();
	}, [camera.id, camera.ready]);

	const label =
		status === "live"
			? "LIVE"
			: status === "offline"
				? "OFFLINE"
				: status === "error"
					? "ERROR"
					: "CONNECTING";

	return (
		<div className={`tile ${expanded ? "tile-expanded" : ""}`} data-status={status}>
			<video
				ref={videoRef}
				muted={muted}
				playsInline
				autoPlay
				onDoubleClick={() => onExpand(camera)}
			/>

			{status !== "live" && (
				<div className="tile-placeholder">
					<span className="spinner" data-hidden={status !== "connecting"} />
					<span>
						{status === "offline"
							? "No signal from bridge"
							: status === "error"
								? "Stream failed"
								: "Connecting…"}
					</span>
				</div>
			)}

			<div className="tile-bar">
				<span className={`dot dot-${status}`} aria-hidden />
				<span className="tile-name">{camera.name}</span>
				<span className="tile-status">{label}</span>

				{camera.recording && (
					<span className="rec-badge">
						<span className="rec-dot" aria-hidden />
						REC {formatDuration(elapsed)}
					</span>
				)}

				<button
					type="button"
					className={`btn btn-rec ${camera.recording ? "is-on" : ""}`}
					onClick={() => onToggleRecord(camera)}
					disabled={!camera.ready}
					title={camera.recording ? "Stop recording" : "Start recording"}
				>
					{camera.recording ? "Stop" : "Record"}
				</button>
				<button
					type="button"
					className="btn"
					onClick={() => onExpand(camera)}
					title={expanded ? "Back to wall" : "Expand"}
				>
					{expanded ? "Close" : "Expand"}
				</button>
			</div>
		</div>
	);
}
