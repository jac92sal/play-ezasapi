# How videos get into play.ezasapi.com

## The short version

There is **no Cloudflare-side database and no scheduled pull.** There never was.

- The library is the **R2 bucket** `entertainmentvideos`. `GET /api/videos` lists it
  live on every page load — there is no separate table to keep in sync.
- The KV namespace `HASHES` is only a **deduplication index**: `fp:<sha256>` →
  `{key,size}`. It is written when a file is uploaded, not on a schedule.
- The Worker has **no `scheduled()` handler** and `wrangler.jsonc` has **no
  `triggers.crons`**, so Cloudflare runs nothing on a timer for this project.

More importantly, a daily "pull" is not possible in that direction. The videos
live in a folder on a home PC. A Cloudflare Worker cannot reach into that folder.
The sync has to be a **push from the PC**.

## Where the videos come from

The source folder is on the Windows machine, defaulting to:

```
C:\Users\jacob\OneDrive\Videos
```

`docs/sync-videos.ps1` walks that folder (recursively), and for each video file:

1. Computes the content fingerprint — SHA-256 of (first 4MB + last 4MB + file size).
2. Calls `POST /api/upload/check` to ask whether that content or that filename is
   already in the bucket.
3. Uploads only the genuinely new files, with `rclone` (multipart, resumable).
4. Calls `POST /api/upload/register` so the fingerprint index knows about them.
5. Calls `POST /api/sync/heartbeat` so the site can display when the sync last ran.

The folder can be overridden with `-VideoFolder` or the `PLAY_VIDEO_FOLDER`
environment variable.

## Making it actually run daily

Nothing schedules the script by itself. Register it as a Windows Scheduled Task,
once, on the PC that holds the videos:

```powershell
cd <repo>\docs
.\install-daily-sync.ps1 -Pin <your-pin>
```

That creates a task named `PlayEzasapiVideoSync` which runs daily at 03:30 local
time as your user (so it can read OneDrive files). Options:

| Flag | Meaning |
| --- | --- |
| `-At 06:00` | Different time of day |
| `-VideoFolder D:\Videos` | Different source folder |
| `-TaskName ...` | Different task name |

Remove it with `Unregister-ScheduledTask -TaskName PlayEzasapiVideoSync`.

## Running it by hand

```powershell
$env:PLAY_PIN = "<your-pin>"

.\sync-videos.ps1 -DryRun     # scan and report; uploads nothing
.\sync-videos.ps1             # real run
```

## Checking whether it is actually happening

Three independent ways, in order of convenience:

1. **The site header.** A pill reads `Synced 4h ago`, or turns amber and reads
   `Sync: never run` / `Sync failed 2d ago` when something is wrong. Hover it for
   the file counts and the machine it ran on. It goes amber after 36 hours without
   a successful run.

2. **The API.** `GET /api/sync/status` (needs the auth cookie) returns the last
   run's report and its age in hours:

   ```json
   { "last": { "at": "...", "ok": true, "scanned": 172, "uploaded": 3,
               "skippedContent": 169, "skippedName": 0, "source": "PC:C:\\..." },
     "ageHours": 4.2 }
   ```

3. **The log on the PC.** Every run appends to
   `%LOCALAPPDATA%\play-ezasapi\sync-videos.log`, including failures.

Also useful: `Get-ScheduledTaskInfo -TaskName PlayEzasapiVideoSync` shows the last
run time and result code from Windows' own point of view.

## One-time setup: rclone

The script uploads with `rclone`, which needs an `r2` remote pointing at the bucket:

```powershell
winget install Rclone.Rclone
rclone config
```

Create a remote named `r2`, type `s3`, provider `Cloudflare`, with an R2 API token
(Access Key ID + Secret) and endpoint
`https://<account-id>.r2.cloudflarestorage.com`.

## Things worth knowing

- **The sync only adds.** Deleting a file locally does not delete it from R2.
- **The PIN is not in the repo.** Supply it with `-Pin` or `PLAY_PIN`.
  (An earlier version of this script had it hard-coded; if that value was ever
  committed and is still the live PIN, rotate it with
  `wrangler secret put PLAY_PIN`.)
- **Fingerprint backfill.** Files already in the bucket but missing from the
  `fp:` index get registered on the next run, so content-level dedupe catches
  them afterwards.
