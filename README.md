# red-string

Two phones, one room, a few buttons. One person creates a room with a 4-letter code, the other joins with it. Each person has their own buttons; pressing one lights its light on the other person's phone for 2 seconds. Made for playing a crossword together, where only one person holds the puzzle ("I know", "Next", "No idea").

## Run

```sh
npm run server   # the relay, http://127.0.0.1:8793
npm run site     # the page, http://localhost:4181
npm test
```

Open http://localhost:4181 in two tabs: create a room in one, join it in the other. `?relay=<port>` points the page at a throwaway relay (`PORT=<port> npm run server`).

## Files

```
index.html, app.js   the page: lobby → create room → the room, and the button editor
style.css            one fixed light look (no dark mode), so a light looks the same on both phones
server/server.js     the relay (Node, no dependencies)
server/presets.json  the starting layouts offered when creating a room
```

## How it works

A room has two **seats** and a list of **buttons**. Each button belongs to one seat: only that seat sees it as a button, and the other seat sees it as a light. So the two sides can be different (the crossword preset gives the solver "Go ahead" and the watcher three buttons) or the same.

- **Creating a room:** pick a code (a random one is filled in), a preset, and adjust both seats' buttons: tap the dot to pick from 9 colors, type to rename, × to remove. The creator takes seat 1; whoever joins gets seat 2. A third person is told the room is full.
- **In the room:** the other person's lights on top, your buttons at the bottom. ✎ opens the same editor; anyone can change either seat's buttons, and saving updates both phones.
- **Connections:** each phone keeps a Server-Sent Events stream open to the relay; presses and edits are plain POSTs. If a phone loses its connection (screen locked, reload, bad signal), its seat is kept for 2 minutes. A reload in the same tab rejoins the room (the seat is kept in that tab's sessionStorage). × leaves at once. A room with no one left closes.

Relay API (every POST body is JSON sent as `text/plain`, so browsers skip the CORS preflight):

| | |
|---|---|
| `GET /health` | `ok` |
| `GET /v1/presets` | the presets |
| `POST /v1/rooms` | `{code, name, buttons, preset?}` → 201 `{seat, token}` · 409 code taken |
| `POST /v1/rooms/<code>/join` | `{name}` → `{seat, token}` · 404 no room · 409 full |
| `GET /v1/rooms/<code>/events?token=` | the stream: `state` (seats, names, who's connected, buttons) and `press` `{id}` |
| `POST /v1/rooms/<code>/press` | `{token, id}` → 204 (only your own seat's buttons) |
| `POST /v1/rooms/<code>/buttons` | `{token, buttons}` → 204, replaces the list |
| `POST /v1/rooms/<code>/leave` | `{token}` → 204 |

Only the site's own pages may call it from a browser (`https://adgnvtefc.github.io` and localhost:4181; add more with `RED_STRING_ORIGINS`). Joining is limited to 240 tries a minute (slows down code guessing), new rooms to 60 per 10 minutes, and 500 rooms at once.

## Always on

```sh
launchd/install.sh                                             # install / reinstall
launchctl kickstart -k gui/$(id -u)/com.hanmo.red-string       # restart after editing server.js (closes every room)
launchctl bootout gui/$(id -u)/com.hanmo.red-string            # stop
```

Log: `~/.red-string/logs/server.log`. The relay is listed in monitor-hub's `SERVICES`.

## Port and data

- **Port:** `PORT`, default `8793`. `/health` answers `ok`.
- **Data:** none on disk. Rooms, names and buttons live only in the relay's memory; a restart closes every room.

## Public or tailnet

**Public**, through Tailscale Funnel at `https://hanmos-mac-studio.tail6c4683.ts.net/red-string` → 127.0.0.1:8793, because the person you play with isn't on the tailnet. The page uses that address everywhere except localhost. Set up with:

```sh
tailscale funnel --bg --set-path /red-string http://127.0.0.1:8793
```

The page is on GitHub Pages: https://adgnvtefc.github.io/red-string/

## Stats

The relay reports to catseye (site `red-string`) in the background; catseye being down never affects a room. The page sends nothing. No names, codes or button labels are sent.

| Event | When | Data |
|---|---|---|
| `room_created` | a room opens | `preset` (its id, or `none`), `buttons` (how many) |
| `room_joined` | someone takes seat 2 | — |
| `room_closed` | the last person leaves or times out | `minutes` open, `presses` in total |

Presses aren't sent one by one: catseye's limit is shared by every site, and a busy room could use it up.

## Exceptions and flags

- **The seat token is in the event stream's URL** (`?token=`), because `EventSource` can't send headers. Nothing on the way logs URLs, and a token only lasts as long as its seat.
- **No monitor-hub tile yet** (`web/sites/red-string/`). The events are in catseye, so one can be added later.
