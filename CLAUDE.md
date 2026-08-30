# play-ezasapi

Video preview + playback platform for the `entertainmentvideos` R2 bucket.

- **Subdomain:** play.ezasapi.com
- **Worker:** `play-ezasapi` (route: `play.ezasapi.com` custom domain)
- **Template:** Cloudflare Vite + React + Hono (official `vite-react-template`)
- **Service bindings used:** none (public site, no auth)
- **Resources:**
  - R2: `entertainmentvideos` → binding `ENTERTAINMENTVIDEOS`
  - KV: `HASHES` (id `fdaf6f7ff5c24be09b8332785754fde6`) — content-fingerprint index `fp:<sha256>` → `{key,size}`; fingerprint = SHA-256(first 4MB + last 4MB + size)
  - Assets: `dist/client` → binding `ASSETS`, SPA fallback, `run_worker_first: ["/api/*"]`
- **Secrets:** `PLAY_PIN` (Worker secret) — the access PIN; all `/api/*` except `/api/auth` require the HMAC cookie it derives

## API (worker: `src/worker/index.ts`)

- `POST /api/auth` — body `{pin}`; sets 30-day HttpOnly auth cookie on success (500ms delay on failure)
- `GET /api/videos` — full listing of video objects (paginated internally), returns key/name/size/uploaded/contentType/etag
- `GET|HEAD /api/stream/:key` — streams an object from R2 with HTTP Range support (seeking works); 1h edge cache headers
- `POST /api/upload/check` — `{name, fingerprint}` → `{nameExists, contentDuplicateOf}`
- `PUT /api/upload/direct/:key?fingerprint=` — single-request upload (≤48MB)
- `POST /api/upload/init` / `PUT /api/upload/part` / `POST /api/upload/complete` / `POST /api/upload/abort` — R2 multipart for large files (48MB parts, client uploads 3 in parallel)
- `POST /api/upload/register` — `{key, fingerprint}`; indexes an object uploaded out-of-band (rclone sync)
- `POST /api/sync/heartbeat` — sync script reports a finished run; stored in KV as `sync:last`
- `GET /api/sync/status` — `{last, ageHours}` for the last reported sync run

## Video sync (`docs/`)

There is **no cron trigger and no D1 database** — the bucket is the source of
truth and the daily sync is a *push* from the Windows PC that holds the videos
(Cloudflare cannot pull from a local folder). See `docs/SYNC.md`.

- `docs/sync-videos.ps1` — scans the local video folder, dedupes by fingerprint, uploads new files with rclone, registers fingerprints, sends a heartbeat
- `docs/install-daily-sync.ps1` — registers the `PlayEzasapiVideoSync` Windows Scheduled Task that runs it daily

## Frontend (`src/react-app/`)

Grid of lazy-loaded first-frame previews → click to open player overlay with
search, sort (newest/oldest/name/size), autoplay-next, shuffle, and an Up Next
queue. Keyboard: Esc close, Shift+←/→ prev/next.

## Commands

- `npm run dev` — local dev (real Workers runtime via Vite plugin)
- `npm run check` — tsc + build + `wrangler deploy --dry-run`
- `npm run deploy` — build + deploy to play.ezasapi.com
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after wrangler.jsonc changes
