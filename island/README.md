# island/ — the face of MYTOPIA

The island draws the gateway's decision log. It never decides anything. Every animation is one row of `GET /events`, and the only things it sends back are four button clicks.

## Answers to the brief's three questions (section 9)

1. **Stack.** Plain ES modules plus **three.js 0.184** (WebGL), **no build step**. The renderer is Mytopia's `<three-d-stage>` web component: an orthographic camera, rendered at half resolution, with a depth/normal ink-outline post-process for the pixel look. The HUD is plain HTML/CSS paper panels. Everything is already static, so **the files live directly in `island/`** (there is no `dist/`). The gateway serves the `island/` folder as is. three.js and the fonts are vendored in `island/vendor/` and `island/fonts/`, so there are no CDN or network calls.
2. **Buildings.** Gatehouse = Mytopia's gate arch (from the Welcome Center), widened into a low gatehouse with a striped barrier, an OFF LIMITS rope and a BLOCKED bin. **Files** = the brick library. **GitHub** = the glass studio. **Mail** = the cottage with flower boxes, plus a new mailbox. **Admin** = the columned courthouse.
3. **Pre-existing vs new.** Pre-existing (from Mytopia, written before this weekend): `three-d-stage.js` (unchanged) and the geometry helpers, materials, building shapes, robot, tree, lamp and fence recipes copied into `src/scene.js`. New this weekend: the reducer, the island scene layout and gatehouse, plates, sparks, smoke/fire, the HUD, polling/replay/buttons, and the tests. The full list is in [ASSETS.md](ASSETS.md).

## Run it

```bash
# from the repo root: any static server works (ES modules do not load from file://)
python3 -m http.server 5300
# replay:  http://127.0.0.1:5300/island/index.html?replay=../contract/fixture.json
# live:    put a config.js next to index.html (copy config.example.js), start the gateway or tools/mock_gateway.py, open island/index.html
```

When served by the gateway at `http://127.0.0.1:8787/`, the gateway's own `/config.js` is used. Keys: **G** (or click the gatehouse) opens the gatehouse ledger room, **T** shows the event table, **R** replays the fixture, **Esc** closes overlays or leaves the room. **SAVE REPLAY** downloads every event seen as `{"events":[...]}`, which plays back with `?replay=<file>`. Tests: `node --test island/tests/*.test.mjs`.

## Files a judge will open

| File | What it is |
|---|---|
| `index.html` | the page: paper HUD panels, CSS, the import map for the vendored three.js |
| `src/reducer.js` | the only logic: `apply(state, event)` → new state + effects; badge rule; dedupe |
| `src/main.js` | wiring: live polling / replay, the effects queue, the HUD, the four buttons, keys |
| `src/scene.js` | the three.js island: buildings, gatehouse, robots, plates, lamps, sparks, smoke, fire, and the gatehouse ledger room |
| `three-d-stage.js` | Mytopia's renderer component (pre-existing, unchanged) |
| `tests/reducer.test.mjs` | the fixture run through the reducer |

## How the island works (ten lines)

1. `src/reducer.js` has one pure function, `apply(state, event)`, that returns the new state and a list of effects. Nothing else changes state.
2. Events are applied in `seq` order, once each. Anything at or below the cursor (the highest seq applied) is ignored.
3. `src/main.js` gets events in one of two ways. Live: it polls `GET /events?since_seq=<cursor>` every second. Replay: it reads a JSON file and hands over one event every 1.5 s. Both paths feed the same `apply`.
4. The effects (spark, lamp, stamp, banner, plate, smoke, move) go into a queue in `src/main.js`. At most three play at once, so the screen stays calm.
5. `src/scene.js` builds the island in three.js and only knows how to draw. It has no idea why something is drawn.
6. Smoke and fire are state, not effects. They come from each building's denial count in the reducer state.
7. The mode badge is not an event. Every second it is recomputed from the age of the last successful poll: LIVE under 3 s, otherwise STALE. A file playback is always REPLAY.
8. The buttons only POST to the gateway and show "sent...". The plate turns red only when the gateway's `revoked` event comes back through polling.
9. In REPLAY the buttons are disabled, so a recording can never look like it controls anything.
10. If the gateway stops, the scene freezes as it was and the badge says STALE. Nothing is ever invented on the client.

## Stage B (after the live integration passed)

- **Walking robots:** a robot walks through the arch to the building of its latest allowed call, and back to the gate on a deny.
- **Gatehouse ledger room:** press G or click the gatehouse. An iris wipe opens a cutaway room. The chalkboard lists the last seven decisions from the same event log (allow in green, deny in red, admin in amber), the paper board beside it shows the hash chain (each row names the hash of the one before it). The chain is **tamper-evident, not tamper-proof**: an edited or deleted row breaks the links, so the edit shows; it does not stop anyone from making one. The gateway writes and verifies the chain; the island only draws it. and the clerk robot stamps every new row. It is drawn from `state.log` and decides nothing.
- **BLOCKED bin:** each denied call drops a red packet into the bin by the gate.
- **Click a robot:** shows the raw JSON of its latest event.
- **Save replay:** downloads every event seen, so a clean live run can become the backup recording.
