# Bridge

Cheap IP cameras speak RTSP. Browsers don't. Cloudflare Workers can't transcode
video or hold a socket open to a device on your LAN. So one always-on box on
your network does that job: it pulls each camera, republishes everything as
low-latency HLS, and records on command.

```
V720 cams ─┐
webcam ────┼─RTSP→ MediaMTX ─HLS→ Caddy ─→ cloudflared ─→ bridge.ezasapi.com
phone ─────┘            │                                        ↑
                        └─ recordings ─→ rclone ─→ R2      cam.ezasapi.com
                                                            (the Worker)
```

Nothing is port-forwarded. `cloudflared` dials out; Caddy rejects anything
without the shared bearer token, which only the Worker knows.

## Hardware

Any Docker host on the camera network: Raspberry Pi 4/5, an N100 mini PC, a
Synology, a spare laptop. Four 1080p cameras remuxed (not transcoded) is a
light load — a Pi 4 handles it.

## Setup

**1. Find your cameras' RTSP URLs.** Do this first, before anything else.

```sh
sh discover-rtsp.sh 192.168.1.0/24 admin yourpassword
```

**If nothing responds, your V720 cameras are P2P-only** — the firmware talks to
the vendor's cloud and nothing else, and no amount of software on your side
changes that. Options, in order of how much they cost you:

- Check the V720 app's settings for an "ONVIF", "RTSP", or "local/LAN" toggle.
  Some models ship it off.
- Some of these cams run stock firmware that answers on port 8899 (ONVIF) even
  when 554 looks closed. `discover-rtsp.sh` scans for it.
- Otherwise, replace them. Any camera advertising **ONVIF** or **RTSP** works
  here unchanged — Reolink, Amcrest, Tapo, Wyze (with RTSP firmware), and most
  sub-$40 no-name cams. This app doesn't care which.

**2. Put the working URLs into `mediamtx.yml`.** Camera passwords live here and
only here — they never reach the Worker, KV, or your browser.

**3. Create the Cloudflare Tunnel.** Zero Trust → Networks → Tunnels → Create.
Add a public hostname `bridge.ezasapi.com` → `http://localhost:8080`. Copy the
tunnel token.

**4. Fill in `.env`** (gitignored):

```sh
cp .env.example .env
openssl rand -hex 32      # this is BRIDGE_TOKEN — the Worker needs the same value
```

**5. Start it:**

```sh
docker compose up -d
docker compose logs -f mediamtx     # each camera should log "ready"
```

## Adding a camera later

Add a path to `mediamtx.yml`, then `docker compose restart mediamtx`. It shows
up on the wall on its own — the app reads the live path list from the bridge.

## Notes

- **Audio.** HLS carries AAC and Opus. Most cheap cams emit G.711, which gets
  dropped. Video is unaffected. If you need camera audio, that's a re-encode
  (`runOnReady` with ffmpeg) rather than the straight copy used here.
- **Latency** is roughly 1–3s. That's the cost of HLS through a tunnel. WebRTC
  would be sub-second but needs a UDP port open on your router.
- **Recordings** are fragmented MP4, copied straight from the camera with no
  re-encode. `rclone` moves them to R2 about a minute after each segment
  closes; long recordings roll into 15-minute files.
- **Disk.** Recordings sit in a Docker volume until uploaded. If R2 credentials
  are wrong the volume grows — check `docker compose logs uploader`.
