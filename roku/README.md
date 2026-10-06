# play.ezasapi Roku channel

SceneGraph channel that plays the library from `https://play.ezasapi.com`
(the `play-ezasapi` Cloudflare Worker in this repo). It has no backend of its
own: if the Worker is up, the channel works.

## Files

| File | Role |
|---|---|
| `manifest` | Channel name, version, icon and splash image paths |
| `source/main.brs` | Entry point; opens `MainScene` |
| `components/MainScene.xml` / `.brs` | PIN dialog, poster grid, video player, autoplay-next |
| `components/ApiTask.xml` / `.brs` | Background HTTP: `POST /api/auth`, `GET /api/videos` |
| `images/` | Icon (336x210, 248x140) and splash (1280x720, 1920x1080, 720x480), generated from the bucket thumbnail `8Pi9kJ1W6A9TjJgB.mp4` |
| `images/poster-missing.png` | Grid poster shown while a thumbnail loads or if it fails to load |

## How it talks to the Worker

1. First launch shows a 4-digit PIN dialog. The PIN goes to `POST /api/auth`,
   which returns a token. The token is saved in the Roku registry so the PIN
   is only asked once (or again if the PIN is changed on the server).
2. `GET /api/videos` with `Authorization: Bearer <token>` fills the grid,
   newest first.
3. Posters load from `/api/thumb/<key>?auth=<token>`. Videos without a
   thumbnail JPEG show the placeholder until the PC sync script (ffmpeg) or the
   web app saves one.
4. Selecting a video plays `/api/stream/<key>?auth=<token>`; the Worker
   supports byte ranges so seeking works. When a video ends the next one plays.
   Back returns to the grid. If the list fails to load, `*` retries.
5. While a video plays: **Down** jumps to the next video, **Up** to the previous
   one, `*` shows the title banner and opens the favorite chooser (Gold,
   Silver, Bronze, Not a favorite). Left/Right/OK keep their normal
   seek and pause behaviour. A video that cannot play (an incomplete upload)
   is skipped automatically instead of dropping back to the grid.
6. In the grid, `*` opens a menu: show all videos, all favorites, or only
   Gold / Silver / Bronze (remembered between launches), set the favorite of
   the focused video, or refresh the list. A favorite's level is shown in
   capitals on the tile's second caption line. Favorites are the same ones the
   web app uses (`POST /api/videos/fav`).

To point the channel somewhere else, change `m.baseUrl` at the top of
`components/MainScene.brs`. To change the PIN length, change `m.pinLength`.

## Build the package

```
npm run roku:package
```

Writes `dist/play-ezasapi-roku.zip` with `manifest` at the zip root, which is
what Roku's installer expects.

## Sideload onto the Roku

1. On the Roku, enable Developer Mode: press Home 3x, Up 2x, Right, Left,
   Right, Left, Right. Accept, set a dev password, and note the IP address.
2. In a browser on the same network open `http://<roku-ip>` and log in as
   `rokudev` with that password.
3. Under **Upload**, choose `dist/play-ezasapi-roku.zip`, then **Install**.
   Roku will replace any previously sideloaded channel.
4. The channel appears on the Roku home screen as **play.ezasapi**.

Re-run steps 3 and 4 whenever you rebuild the zip.
