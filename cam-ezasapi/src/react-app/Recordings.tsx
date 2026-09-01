import { useCallback, useEffect, useState } from "react";
import { api, formatBytes, type Recording } from "./api";

export default function Recordings() {
	const [items, setItems] = useState<Recording[] | null>(null);
	const [playing, setPlaying] = useState<Recording | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const { recordings } = await api.recordings();
			setItems(recordings);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load recordings");
			setItems([]);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function remove(rec: Recording) {
		if (!confirm(`Delete ${rec.name}? This cannot be undone.`)) return;
		await api.deleteRecording(rec.key);
		if (playing?.key === rec.key) setPlaying(null);
		await load();
	}

	if (items === null) return <div className="boot">Loading recordings…</div>;

	return (
		<main className="recordings">
			{error && <div className="banner">{error}</div>}

			{playing && (
				<div className="player">
					<video
						src={`/api/recordings/stream/${encodeURI(playing.key)}`}
						controls
						autoPlay
						playsInline
					/>
					<div className="player-bar">
						<span>{playing.name}</span>
						<button type="button" className="btn" onClick={() => setPlaying(null)}>
							Close
						</button>
					</div>
				</div>
			)}

			{items.length === 0 ? (
				<div className="empty">
					<h2>Nothing recorded yet</h2>
					<p>
						Press <strong>Record</strong> on a camera. Segments appear here once the
						bridge has uploaded them to R2 &mdash; about a
						minute after each segment closes.
					</p>
				</div>
			) : (
				<table className="rec-table">
					<thead>
						<tr>
							<th>Camera</th>
							<th>Recorded</th>
							<th>Size</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{items.map((rec) => (
							<tr key={rec.key}>
								<td>{rec.camera}</td>
								<td>{new Date(rec.uploaded).toLocaleString()}</td>
								<td>{formatBytes(rec.size)}</td>
								<td className="rec-actions">
									<button type="button" className="btn" onClick={() => setPlaying(rec)}>
										Play
									</button>
									<a className="btn" href={`/api/recordings/stream/${encodeURI(rec.key)}`} download>
										Download
									</a>
									<button type="button" className="btn btn-danger" onClick={() => void remove(rec)}>
										Delete
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</main>
	);
}
