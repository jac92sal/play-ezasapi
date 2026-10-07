# play-ezasapi

Video preview + playback platform for the `entertainmentvideos` R2 bucket.

- **Subdomain:** play.ezasapi.com
- **Worker:** `play-ezasapi` (route: `play.ezasapi.com` custom domain)
- **Template:** Cloudflare Vite + React + Hono (official `vite-react-template`)
- **Service bindings used:** none (public site, no auth)
- **Resources:**
  - R2: `entertainmentvideos` → binding `ENTERTAINMENTVIDEOS`
  - KV: `HASHES` (id `fdaf6f7ff5c24be09b8332785754fde6`) — content-fingerprint index `fp:<sha256>` → `{key,size}` (key also in the entry metadata), or a tombstone `{key,size,deleted:true}` once that content was deleted on the site; fingerprint = SHA-256(first 4MB + last 4MB + size); also `library-meta` (titles/groups) and one `fav:<video key>` entry per favorite
  - Assets: `dist/client` → binding `ASSETS`, SPA fallback, `run_worker_first: ["/api/*"]`
- **Secrets:** `PLAY_PIN` (Worker secret) — the access PIN; all `/api/*` except `/api/auth` require the HMAC token it derives, presented as the `play_auth` cookie (web), `Authorization: Bearer` header, or `?auth=` query param (Roku posters/video)

## API (worker: `src/worker/index.ts`)

- `POST /api/auth` — body `{pin}`; sets 30-day HttpOnly auth cookie and returns `{ok, token}` on success (500ms delay on failure)
- `GET /api/videos` — full listing of video objects (paginated internally), returns key/name/size/uploaded/contentType/etag/hasThumb (`hasThumb` = a `.thumbnails/<key>.jpg` exists)
- `GET|HEAD /api/stream/:key` — streams an object from R2 with HTTP Range support (seeking works); 1h edge cache headers
- `GET /api/thumb/:key` — returns the pre-generated JPEG at `.thumbnails/<key>.jpg` (`image/jpeg`, 1d browser / 7d edge cache). If none exists it serves `public/thumb-placeholder.png` (200, `X-Thumb-Placeholder: 1`, 5min cache) so image-only clients such as the Roku PosterGrid still get a tile. Web grid cards skip the request when `hasThumb` is false (or the JPEG fails) and show a first frame from the video instead, falling back to the video name on the tile only if the video cannot load. New thumbnails come from `docs/sync-videos.ps1` (ffmpeg) and from the web grid via `PUT /api/thumb/:key`
- `PUT /api/thumb/:key` — body = JPEG bytes (≤2 MB, must start FF D8 FF); stores `.thumbnails/<key>.jpg` for an existing video. Keeps an existing thumbnail unless `?replace=1` (returns `{stored:false, reason:"exists"}`). Called by the PC sync script (ffmpeg frame) and by the web grid (it saves the first-frame preview of a card whose video has no JPEG, skipping near-black frames, once per page load)
- `POST /api/videos/meta` — `{key, title?, group?}` sets the display title / studio group shown in the web app (stored together in the KV value `library-meta`; empty clears; never renames). `/api/videos` returns `title` / `group` when set. The web edit dialog now renames instead of setting a title, and clears old titles
- `POST /api/videos/rename` — `{key, name}` (same folder + extension; Windows-invalid characters refused) or `{key, newKey}` (used by the PC sync). Streams a copy to the new key (multipart over 4 GB), then moves the thumbnail, group, favorite and `fp:` entry and deletes the old object; drops any display title. 409 if the new name is taken
- `POST /api/videos/fav` — `{key, fav}` with `fav` = `"gold"` | `"silver"` | `"bronze"` sets the favorite level, `null` clears it. Each favorite is its own KV entry `fav:<video key>` (level also in the entry's metadata) so concurrent clicks never overwrite each other. `/api/videos` returns `fav` when set; deleting a video removes its favorite
- `DELETE /api/videos/:key` — deletes the object and its `.thumbnails/<key>.jpg`, and turns the `fp:` entry into a tombstone (unless it points at another copy that still exists) so the PC sync never re-uploads it; a website upload of the same file revives it
- `POST /api/upload/check` — `{name, fingerprint}` → `{nameExists, contentDuplicateOf, deletedOnSite}` (`contentDuplicateOf` only if that object still exists; `deletedOnSite` = key the content had when deleted)
- `POST /api/index/backfill?after=&limit=` — fingerprints up to `limit` (default 8, max 25) videos not yet in the `fp:` index, in key order; call again with `after` = returned `next` until null; returns `{checked, added, duplicates:[{key,duplicateOf}], next}`
- `PUT /api/upload/direct/:key?fingerprint=` — single-request upload (≤48MB)
- `POST /api/upload/init` / `PUT /api/upload/part` / `POST /api/upload/complete` / `POST /api/upload/abort` — R2 multipart for large files (48MB parts, client uploads 3 in parallel)

## Frontend (`src/react-app/`)

Grid of lazy-loaded first-frame previews → click to open player overlay with
search, sort (newest/oldest/name/size), autoplay-next, shuffle, an Up Next
queue, "Group by studio" sections (studio guessed from the name prefix, e.g.
`BSB 00072`, `BiLatinMen - …`, `Chaos Men - …`, with a manual override), per-video
rename / Group editing (✎; renaming renames the file in the bucket), gold / silver / bronze favorites (🥇🥈🥉 badge on the card, ☆ card button cycling none → gold → silver → bronze → none, medal buttons in the player, an "All favorites / Gold / Silver / Bronze" filter, and a "Favorites first" sort), a "Possible duplicates" filter (videos sharing an exact byte size, listed
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
- `docs/sync-videos.ps1` (PowerShell, on the PC) — two-way sync between `C:\Videos\play.ezasapi.source` and the bucket (rclone both directions). First runs `/api/index/backfill` to completion. Matches videos by content fingerprint, then: new here → upload + `/api/upload/register`; new on the site → download; renamed on either side → rename the other; tombstoned on the site (`deletedOnSite`) → local file to the Recycle Bin; in `%LOCALAPPDATA%\play-ezasapi\sync-state.json` (fingerprint → name at the last run) but no longer in the folder → `DELETE /api/videos/:key`. Safety: the first run after upgrading from the one-way state file (no `_twoWay` marker) deletes nothing on the site and downloads instead; more than 10 site deletions in one run are held back (and not re-downloaded) until run with `-Yes`; an empty folder with a non-empty state aborts; `-DryRun` changes nothing. Site keys with Windows-invalid characters are not downloaded. Then an ffmpeg JPEG thumbnail for every synced video the site has none for (needs `winget install Gyan.FFmpeg`; skipped with a warning if missing); PIN comes from `$env:PLAY_PIN` or a prompt, never the file
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after wrangler.jsonc changes

## Deployment rule

`main` is production. Cloudflare Workers Builds deploys `main` to play.ezasapi.com
on every push, so every finished change must be merged into `main` (via PR) and
the site must never be deployed from a side branch with `npm run deploy`.
Deploying from a branch lets `main` fall behind the live site, and the next
merge into `main` then silently rolls the live site back.
