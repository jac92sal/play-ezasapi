# cam-ezasapi

Unified live camera wall — every camera on one screen, record on demand.

- **Subdomain:** cam.ezasapi.com
- **Worker:** `cam-ezasapi` (route: `cam.ezasapi.com/*`)
- **Template:** Cloudflare Vite + React + Hono
- **Service bindings used:** none
- **Resources:**
  - KV: `CAMERAS` — display names/order only, keyed `roster:meta`
  - R2: `cam-recordings` → binding `RECORDINGS`, keys `cam/<camera>/<timestamp>.mp4`
  - Assets: `dist/client` → `ASSETS`, SPA fallback, `run_worker_first: ["/api/*"]`
- **Secrets:** `CAM_PIN`, `BRIDGE_URL`, `BRIDGE_TOKEN`

## Architecture

The Worker never touches a camera. A LAN bridge (`bridge/`: MediaMTX + Caddy +
cloudflared + rclone) pulls RTSP from each camera and republishes low-latency
HLS behind a bearer token. The Worker is the auth boundary and the only thing
that holds the token; the browser talks exclusively to `cam.ezasapi.com`.

Camera credentials live in `bridge/mediamtx.yml` and nowhere else. The roster
is read live from the bridge's path list, so adding a camera means editing that
file — never the app.

## API (`src/worker/index.ts`)

- `POST /api/auth` — `{pin}`; sets a 30-day HttpOnly HMAC cookie (500ms delay on failure)
- `GET /api/cameras` — live roster: bridge path list + KV display metadata
- `PUT /api/cameras` — save display names and ordering
- `POST /api/record/start|stop/:camera` — PATCHes `record` on the bridge path
- `GET /api/recordings` — list synced recordings in R2
- `GET|HEAD /api/recordings/stream/:key` — playback with Range support
- `DELETE /api/recordings/:key`
- `ALL /api/bridge/*` — authenticated pass-through to the bridge (HLS playlists
  and segments); injects `BRIDGE_TOKEN`, forces `no-store`

## Frontend (`src/react-app/`)

PIN gate → grid of hls.js tiles (1–4 columns, double-click to expand, Esc to
close) with a per-camera Record toggle, plus a Recordings tab for playback,
download and delete. Roster polls every 5s so readiness and recording state
stay honest without restarting streams.

## Commands

- `npm run dev` — local dev
- `npm run check` — tsc + build + `wrangler deploy --dry-run`
- `npm run deploy` — build + deploy to cam.ezasapi.com
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts`
