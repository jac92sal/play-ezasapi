# play.ezasapi

Private video library. One R2 bucket, one Cloudflare Worker, and three clients
(web app, Roku channel, PC sync script) that all talk to that Worker.

```
                          ┌──────────────────────────────────────────┐
  Browser  ──────────────▶│  play-ezasapi Worker                     │
  (src/react-app)         │  https://play.ezasapi.com                │
                          │  src/worker/index.ts                     │──▶ R2 bucket: entertainmentvideos
  Roku channel ──────────▶│                                          │      videos/*.mp4, *.m4v
  (roku/)                 │  /api/auth     PIN → token (cookie+JSON) │      .thumbnails/<key>.jpg
                          │  /api/videos   list                      │
  sync-videos.ps1 ───────▶│  /api/thumb/…  first-frame JPEG          │──▶ KV: HASHES
  (docs/, runs on the PC) │  /api/stream/… video bytes, Range ok     │      fingerprint → key (dedupe)
                          │  /api/upload/… direct + multipart        │
                          └──────────────────────────────────────────┘
```

| Piece | Where | What it is |
|---|---|---|
| Worker (backend) | `src/worker/index.ts`, `wrangler.jsonc` | The only thing that touches the bucket. Deployed as `play-ezasapi` on `play.ezasapi.com`. |
| Web app | `src/react-app/`, `index.html`, `public/` | React grid + player, served by the same Worker as static assets. `public/` holds the site icon set. |
| Roku channel | `roku/` | SceneGraph channel: PIN screen, poster grid, player. Points at `https://play.ezasapi.com`. |
| Roku package | `npm run roku:package` → `dist/play-ezasapi-roku.zip` | The zip you sideload onto the Roku (see `roku/README.md`). |
| PC sync | `docs/sync-videos.ps1` | Uploads new videos from the PC to the bucket through the Worker's upload API. |
| Storage | R2 `entertainmentvideos`, KV `HASHES` | Videos + thumbnails; content-fingerprint index used for duplicate checks. |

## Auth

Everything under `/api/*` except `/api/auth` needs the token derived from the
`PLAY_PIN` Worker secret. The token can be presented three ways, so every
client can use it:

- `play_auth` cookie: set by `/api/auth`, used by the web app
- `Authorization: Bearer <token>`: used by the Roku channel for JSON calls
- `?auth=<token>` query parameter: used by the Roku channel for posters and
  video playback, because Roku's Poster/Video nodes cannot send headers

`/api/auth` returns the token in its JSON body as well as in the cookie.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Local dev server (Workers runtime) |
| `npm run check` | Type-check, build the web app, dry-run deploy |
| `npm run deploy` | Build and deploy the Worker + web app to play.ezasapi.com |
| `npm run roku:package` | Zip `roku/` into `dist/play-ezasapi-roku.zip` for sideloading |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |

## Video count

The app counts only playable videos (`.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv`,
`.avi`, `.ogv`). The bucket's object count is higher because it also holds one
`.thumbnails/<key>.jpg` per video, the sync reports, and folder placeholders.
