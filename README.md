# play.ezasapi

Private video library. One R2 bucket, one Cloudflare Worker, and two clients
(web app, Roku channel) that both talk to that Worker.

```
                          ┌──────────────────────────────────────────┐
  Browser  ──────────────▶│  play-ezasapi Worker                     │
  (src/react-app)         │  https://play.ezasapi.com                │
                          │  src/worker/index.ts                     │──▶ R2 bucket: entertainmentvideos
  Roku channel ──────────▶│                                          │      videos/*.mp4, *.m4v
  (roku/)                 │  /api/auth     PIN → token (cookie+JSON) │      .thumbnails/<key>.jpg
                          │  /api/videos   list                      │
                          │  /api/thumb/…  first-frame JPEG          │──▶ KV: HASHES
                          │  /api/stream/… video bytes, Range ok     │      fingerprint → key (dedupe)
                          │  /api/upload/… direct + multipart        │
                          └──────────────────────────────────────────┘
```

## Renames, deletes and the PC sync

Every video's content fingerprint is kept in KV (`fp:<sha256>`), so a video is
recognised by its content whatever its file name is.

- **Rename** on the website (✎) renames the actual file in the bucket
  (`POST /api/videos/rename`). Its thumbnail, group, favorite and fingerprint
  entry move with it.
- **Delete** on the website removes the file and leaves a "deleted" marker on
  its fingerprint, so the PC sync never uploads that video again.
- **`docs/sync-videos.ps1`** keeps `C:\Videos\play.ezasapi.source` and the
  site in step **both ways**, matching videos by content so a rename is never
  mistaken for a delete:

  | Change | Made on the PC | Made on the site |
  |---|---|---|
  | Add | uploaded to the site | downloaded to the PC |
  | Rename | renamed on the site | renamed on the PC |
  | Delete | deleted on the site | sent to the PC's Recycle Bin |

  Safety: `-DryRun` shows what would change without changing anything. The
  first run after updating from the old one-way script deletes nothing on the
  site (videos missing from the PC are downloaded back instead). More than 10
  site deletions in one run are held back until you run it with `-Yes`, and
  it stops if the folder is empty (e.g. the drive is not connected). To bring
  back a video deleted on the site, upload it again on the website. It also
  has the site fingerprint older videos that were not indexed yet
  (`POST /api/index/backfill`).

| Piece | Where | What it is |
|---|---|---|
| Worker (backend) | `src/worker/index.ts`, `wrangler.jsonc` | The only thing that touches the bucket. Deployed as `play-ezasapi` on `play.ezasapi.com`. |
| Web app | `src/react-app/`, `index.html`, `public/` | React grid + player, served by the same Worker as static assets. Uploads happen here (Upload button). `public/` holds the site icon set. |
| Roku channel | `roku/` | SceneGraph channel: PIN screen, poster grid, player. Points at `https://play.ezasapi.com`. |
| Roku package | `npm run roku:package` → `dist/play-ezasapi-roku.zip` | The zip you sideload onto the Roku (see `roku/README.md`). |
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
