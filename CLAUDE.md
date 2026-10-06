# play-ezasapi

Video preview + playback platform for the `entertainmentvideos` R2 bucket.

- **Subdomain:** play.ezasapi.com
- **Worker:** `play-ezasapi` (route: `play.ezasapi.com` custom domain)
- **Template:** Cloudflare Vite + React + Hono (official `vite-react-template`)
- **Service bindings used:** none (public site, no auth)
- **Resources:**
  - R2: `entertainmentvideos` → binding `ENTERTAINMENTVIDEOS`
  - KV: `HASHES` (id `fdaf6f7ff5c24be09b8332785754fde6`) — content-fingerprint index `fp:<sha256>` → `{key,size}`; fingerprint = SHA-256(first 4MB + last 4MB + size); also `library-meta` (titles/groups) and one `fav:<video key>` entry per favorite
  - Assets: `dist/client` → binding `ASSETS`, SPA fallback, `run_worker_first: ["/api/*"]`
- **Secrets:** `PLAY_PIN` (Worker secret) — the access PIN; all `/api/*` except `/api/auth` require the HMAC token it derives, presented as the `play_auth` cookie (web), `Authorization: Bearer` header, or `?auth=` query param (Roku posters/video)

## API (worker: `src/worker/index.ts`)

- `POST /api/auth` — body `{pin}`; sets 30-day HttpOnly auth cookie and returns `{ok, token}` on success (500ms delay on failure)
- `GET /api/videos` — full listing of video objects (paginated internally), returns key/name/size/uploaded/contentType/etag/hasThumb (`hasThumb` = a `.thumbnails/<key>.jpg` exists)
- `GET|HEAD /api/stream/:key` — streams an object from R2 with HTTP Range support (seeking works); 1h edge cache headers
- `GET /api/thumb/:key` — returns the pre-generated JPEG at `.thumbnails/<key>.jpg` (`image/jpeg`, 1d browser / 7d edge cache). If none exists it serves `public/thumb-placeholder.png` (200, `X-Thumb-Placeholder: 1`, 5min cache) so image-only clients such as the Roku PosterGrid still get a tile. Web grid cards skip the request when `hasThumb` is false (or the JPEG fails) and show a first frame from the video instead, falling back to the video name on the tile only if the video cannot load. New thumbnails come from `docs/sync-videos.ps1` (ffmpeg) and from the web grid via `PUT /api/thumb/:key`
- `PUT /api/thumb/:key` — body = JPEG bytes (≤2 MB, must start FF D8 FF); stores `.thumbnails/<key>.jpg` for an existing video. Keeps an existing thumbnail unless `?replace=1` (returns `{stored:false, reason:"exists"}`). Called by the PC sync script (ffmpeg frame) and by the web grid (it saves the first-frame preview of a card whose video has no JPEG, skipping near-black frames, once per page load)
- `POST /api/videos/meta` — `{key, title?, group?}` sets the display title / studio group shown in the web app (stored together in the KV value `library-meta`; empty clears; the object is never renamed). `/api/videos` returns `title` / `group` when set
- `POST /api/videos/fav` — `{key, fav}` with `fav` = `"gold"` | `"silver"` | `"bronze"` sets the favorite level, `null` clears it. Each favorite is its own KV entry `fav:<video key>` (level also in the entry's metadata) so concurrent clicks never overwrite each other. `/api/videos` returns `fav` when set; deleting a video removes its favorite
- `DELETE /api/videos/:key` — deletes the object, its `.thumbnails/<key>.jpg`, and the `fp:` KV entry when it points at that key (fingerprint recomputed from the object)
- `POST /api/upload/check` — `{name, fingerprint}` → `{nameExists, contentDuplicateOf}`
- `PUT /api/upload/direct/:key?fingerprint=` — single-request upload (≤48MB)
- `POST /api/upload/init` / `PUT /api/upload/part` / `POST /api/upload/complete` / `POST /api/upload/abort` — R2 multipart for large files (48MB parts, client uploads 3 in parallel)

## Frontend (`src/react-app/`)

Grid of lazy-loaded first-frame previews → click to open player overlay with
search, sort (newest/oldest/name/size), autoplay-next, shuffle, an Up Next
queue, "Group by studio" sections (studio guessed from the name prefix, e.g.
`BSB 00072`, `BiLatinMen - …`, `Chaos Men - …`, with a manual override), per-video
Title / Group editing (✎), gold / silver / bronze favorites (🥇🥈🥉 badge on the card, ☆ card button cycling none → gold → silver → bronze → none, medal buttons in the player, an "All favorites / Gold / Silver / Bronze" filter, and a "Favorites first" sort), a "Possible duplicates" filter (videos sharing an exact byte size, listed
side by side), and delete (card hover button or player button, with confirm). Keyboard: Esc close, Shift+←/→ prev/next.

## Roku channel (`roku/`)

SceneGraph channel (BrightScript) with the same PIN → grid → player flow,
pointed at `https://play.ezasapi.com` (`m.baseUrl` in `components/MainScene.brs`).
`ApiTask` does the HTTP; posters and playback pass the token as `?auth=`.
Favorites: `*` in the grid opens a menu (filter all / all favorites / Gold / Silver / Bronze, saved in the registry; set the focused video's favorite; refresh), `*` during playback opens the Gold / Silver / Bronze / none chooser. The level shows in capitals on the tile's second caption line.
Icons/splash in `roku/images/` come from the bucket thumbnail `8Pi9kJ1W6A9TjJgB.mp4`.
Validate with `bsc --rootDir roku --createPackage false` (brighterscript).
`README.md` at the repo root maps how the Worker, web app and Roku channel fit together.

The list refreshes without a page reload: a ↻ Refresh button in the top bar,
a silent re-fetch whenever the tab regains focus/visibility, and a 60s
background poll while visible. The playing video is tracked by key, so a
refresh mid-playback never jumps to a different video.

## Commands

- `npm run dev` — local dev (real Workers runtime via Vite plugin)
- `npm run check` — tsc + build + `wrangler deploy --dry-run`
- `npm run deploy` — build + deploy to play.ezasapi.com
- `npm run roku:package` — zip `roku/` into `dist/play-ezasapi-roku.zip` for sideloading
- `docs/sync-videos.ps1` (PowerShell, on the PC) — one-way sync of `C:\Videos\play.ezasapi.source` into the bucket via rclone, skipping content the site already has, then an ffmpeg JPEG thumbnail for every synced video the site has none for (needs `winget install Gyan.FFmpeg`; skipped with a warning if missing); PIN comes from `$env:PLAY_PIN` or a prompt, never the file
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after wrangler.jsonc changes

## Deployment rule

`main` is production. Cloudflare Workers Builds deploys `main` to play.ezasapi.com
on every push, so every finished change must be merged into `main` (via PR) and
the site must never be deployed from a side branch with `npm run deploy`.
Deploying from a branch lets `main` fall behind the live site, and the next
merge into `main` then silently rolls the live site back.
