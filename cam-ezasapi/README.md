# cam-ezasapi

Every camera on one screen, at **cam.ezasapi.com**, behind a PIN. Record any
camera on demand; recordings land in R2.

Two pieces:

| | |
|---|---|
| `bridge/` | Docker stack on a box on your LAN. Talks to the cameras. **Set this up first** — see [bridge/README.md](bridge/README.md). |
| this app | Cloudflare Worker + React SPA. The UI, the PIN, and the recording controls. |

## Deploy

```sh
npm install

# One-time resources
npx wrangler kv namespace create CAMERAS     # paste the id into wrangler.jsonc
npx wrangler r2 bucket create cam-recordings

# Secrets
npx wrangler secret put CAM_PIN              # the PIN for the wall
npx wrangler secret put BRIDGE_URL           # https://bridge.ezasapi.com  (no trailing slash)
npx wrangler secret put BRIDGE_TOKEN         # same value as BRIDGE_TOKEN in bridge/.env

npm run deploy
```

Add the `cam` DNS record for the Worker route, and point the tunnel's public
hostname `bridge.ezasapi.com` at `http://localhost:8080` on the bridge box.

## Using it

Cameras appear on their own — the roster is read live from the bridge, so
adding one means adding a path to `bridge/mediamtx.yml` and restarting it.

- **Columns** 1–4, or double-click a tile to expand it (Esc to close).
- **Record** starts a server-side recording on the bridge. It keeps running if
  you close the tab; press Stop to end it. Files reach the Recordings tab about
  a minute later.
- Streams run ~1–3s behind live. See the bridge README for why, and what it
  would take to get sub-second.
