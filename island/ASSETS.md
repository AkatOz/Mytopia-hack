# What in island/ was pre-existing, and what was made this weekend

The hackathon rules require the team to say exactly what was built during the event. The island's look comes from **Mytopia**, a teammate's (Ozi's) earlier personal project: a three.js pixel-art "floating island". It was written with Claude Code in Ozi's own repository between **2026-10-07 and 2026-10-20**, before this event. None of Mytopia's data, keys or other code came along.

## Pre-existing (copied from Mytopia)

Since the v2 rebuild (Saturday 2026-11-07 afternoon, `docs/ISLAND_V2.md`) the Mytopia recipes no longer live in one `scene.js`; they were moved, unchanged in spirit, into the files below.

| File / piece in island/ | Origin in Mytopia | Author, date | Changed here? |
|---|---|---|---|
| `three-d-stage.js` | `three-d-stage.js`: the `<three-d-stage>` web component (WebGL renderer, orthographic camera, orbit controls, half-resolution pixel render, ink-outline post-process shader). Its own header says it began as an "omelette starter" scaffold; where that starter came from, and under which licence, is still to be confirmed by Ozi | Ozi with Claude Code, 2026-10-07 to 10-15 | Byte-identical until Saturday night. Build 3 (Sat 2026-11-07 evening, commit a446d49) added one method, `setPixel(px)`: the rooms call `setPixel(1)` when one opens, so their painted boards render at full resolution, and `setPixel(2)` when it closes, so the island keeps its half-resolution pixel look; the `px` value read from the `pixel` attribute is now kept as `this._px` so the method can change it and refit. Eleven lines added, none removed (`git diff --ignore-cr-at-eol 65b74c3 a446d49 -- island/three-d-stage.js`). The file was also saved with Windows line endings (CRLF) in that commit, which is why a plain byte diff touches every line: `git show a446d49:island/three-d-stage.js \| tr -cd '\r' \| wc -c` counts 592 carriage returns and the same for `65b74c3` counts 0; `git ls-files --eol island/three-d-stage.js` reads `i/crlf` |
| `src/kit.js`: **Mytopia's recipes gathered into one file**: the material list and palette, `mat`, `box`/`cyl`/`ball`/`grp`/`pyramid` helpers, `Batch` (vertex-colour mesh builder), the seeded RNG, the canvas-texture helper | `campus.js` lines 12-15, 21-90 | same, 2026-10-07 to 10-20 | The file itself is new (2026-11-07); the recipes in it are Mytopia's. Materials for guards, lamps and slips added in the afternoon; materials for the tier medals, the cart and the Factory's iron, rust and brick added on Saturday night |
| `src/world.js`: the tile-terrain recipe (grass colours, dirt/rock layers, paving) and the scenery recipes `tree`, `bush`, `lamp`, `fence` | `campus.js` lines 91-165, 630-720 | same | Now six islands joined by bridges, with reeds, boats, gulls and more trees added on Saturday night |
| `src/buildings.js`: `windowOn`, `door`, `archWindow`, `gableRoof` and the building shapes. **GitHub** = Swing Studio, **Mail** = Welcome Center cottage, **Admin** = Quality Court courthouse | `campus.js` lines 177-226, buildings 3, 6 and the court islet | same | Scaled 1.15, re-placed; the FILES tower, the gatehouse and the whole Factory island (`src/factory.js`) are new |
| `src/actors.js`: the small robot body (treads, body, head, eyes, antenna) | `campus.js` `smallRobot()` | same | Plate, arms, ID card and the guard uniform added; six colours, the tier medal and the Factory cart added on Saturday night |
| `src/scene.js`: the sky gradient | `campus.js` `skyTex` | same | No |
| `src/effects.js`: the blocky smoke puff | `campus.js` smoke | same | Moved to the gate booths; also the Factory's chimneys since Saturday night |
| The visual language of the HUD: cream paper panels, 3px ink border, hard offset shadow, palette tokens; the trouble ladder; the mode badge; the ticker; the room card | Mytopia `Floating Island Campus.html`, `style.js`, `ladder.js` (ideas only, re-written here) | same | Re-implemented from scratch for this scene |

## Third-party (licences)

| Asset | Licence | File |
|---|---|---|
| three.js 0.184.0 (`vendor/three/three.module.js`, `three.core.js`, `OrbitControls.js`) | MIT | `vendor/three/LICENSE` |
| Pixelify Sans (400, 600; latin), via Fontsource | SIL Open Font License 1.1 | `fonts/OFL.txt`, `fonts/OFL-PixelifySans.txt` |
| VT323 (400; latin), via Fontsource | SIL Open Font License 1.1 | `fonts/OFL-VT323.txt` |

## New this weekend (Nov 7-8, 2026)

The first island, built on Saturday morning by Ozi's Claude Code agent from the brief:

- `src/reducer.js`: the pure `apply(state, event)`, the badge rule, dedupe and ordering, the tool-to-building map.
- `tests/reducer.test.mjs`: 12 tests that ran the 21-event fixture through the reducer (22 today).
- `src/main.js`: live polling with a cursor, replay at 1.5 s per event, the effects queue (at most three at once), the four buttons that only POST, the T table, R replay, robot click → raw JSON, and the overlays (name tags, speech bubbles, stamps, building labels, BLOCKED count).
- `src/scene.js` (new parts): the island layout, **the gatehouse** (lodges, arch, striped barrier that lifts for allowed calls, OFF LIMITS velvet-rope pen, BLOCKED bin that fills with red packets), the mailbox, the chest **plates** (grey, green, red, amber, dark with eyes out), roof **lamps**, green and red **sparks** with the fizzle at the barrier, the two-rung **smoke** plus **fire**, and robot **walking**.
- Stage B, `src/scene.js` + `src/main.js`: the gatehouse **ledger room** (cutaway walls, chalkboard and hash-chain canvases drawn from the log, the clerk robot that stamps each row, the iris wipe; the cutaway-room and iris *ideas* come from Mytopia's interiors, the code is new), falling packets in the BLOCKED bin, and the **Save replay** download.
- `index.html`: the paper HUD (mode badge, banner, agent card, ticker, operator panel, table sheet) and the responsive rules for 1280x720 and about 800 px wide.
- `config.example.js`, `README.md`, `ASSETS.md`, `CONTRACT_QUESTIONS.md`.
- `fixture.json` is a copy of `contract/fixture.json`, so **R** works when the gateway serves only `island/`.

### The archipelago rebuild (Saturday 2026-11-07 afternoon, `docs/ISLAND_V2.md`)

All new code, written during the event by Claude Code (the gateway session), which owns `island/` since 3:30 PM Saturday:

- `src/layout.js`: every coordinate of the islands, bridges, gates, the pen, the bin, the dock, and the waypoint graph the robots walk on.
- `src/world.js`: islands and bridges (plank decks with sag and rope rails), the four gates (posts, striped barrier, pixel-font signboard), the guard booths with their lamps and REFUSED counters, the dock and hatch, the OFF LIMITS pen, the BLOCKED bin, props and clouds.
- `src/buildings.js`: the FILES tower (the skyscraper), the gatehouse (clock, GATEWAY sign, flagpole, the chief's booth), and the three re-placed Mytopia buildings with door lamps.
- `src/actors.js`: agent robots and five guards (police uniform), the script queue, walking on the waypoint graph, the ID check, the escort, the pen, power-down.
- `src/effects.js`: paper slips flying to the ledger, red packets into the bin, timed lamps, the smoke ladder over a booth, the power-down puff.
- `src/hud.js`: the agent card with six tool chips, the operator panel, the gateway strip (decisions, p50/p95, chain status), the ticker, the T table, and the overlay (name tags, islet labels, DENIED stamps anchored to the gate that refused, the bin count) with one collision pass so no text overlaps.
- `src/room.js`: the ledger room in 3D (cutaway room, desk, the clerk who stamps each new row, a straight-on camera). Since build 3 it is a four-line shim that re-exports `rooms.js` and `ledger.js`, kept so older imports resolve; it holds no room of its own.
- `src/ledger.js`: the room's two DOM panels (THE LEDGER, HASH CHAIN) laid over the boards (removed in build 3; the boards are 3D now), and `verifyChain`, which recomputes every row's SHA-256 in the browser (kept).
- `src/scene.js`: puts the parts together and gives `main.js` one small API.
- `tests/ledger.test.mjs`: the browser chain check against the gateway's hashes; `tests/reducer.test.mjs` updated for the v2 scripts.
- `src/main.js`: replay keeps the recording's rhythm and lets each robot beat finish; the speech bubbles are gone.

### Round two (Saturday 2026-11-07, 4 PM onward, `docs/ISLAND_V2_ADDITIONS.md`)

All new code, written during the event:

- `src/arch.js` (new file): the architecture sheet behind key **A**, an inline SVG of the launcher, agent, gateway and the four AWS services with the trust boundaries, plus the table of which picture proves which A10 step and the honest limits.
- `tests/additions.test.mjs` (new file): per-tool revoke and restore, quarantine, the ID card's lines, the three-state mode badge, the chips.
- `tests/additions.json` (new file): a hand-written recording in the gateway's event shapes (per-tool revoke, the refusal after it, restore, three refusals, a quarantine); labelled as hand-written in the file, with placeholder hashes. It plays at `?replay=tests/additions.json`.
- `src/reducer.js`: per-tool `revoked`/`restored` (the badge loses or regains one tool, `gates[key].locked`, ack `tool:<name>`), quarantine (QUARANTINED, no ack), the ID card lines from the gateway's own words, `badgeText` for `LIVE · model` / `LIVE · scripted` / `REPLAY`.
- `src/hud.js`: the chips as buttons (live), the "pulled" chip, the QUARANTINED pill, the DOM ID card, the mode badge's second word.
- `src/world.js`: the padlock plate (a canvas pixel padlock) on each gate's booth and under its signboard.
- `src/actors.js`, `src/scene.js`, `src/main.js`: the ID card hook, the padlock effect, the chips' POSTs, ledger rows that open their raw JSON, the A key.
- `src/ledger.js`: no clipped cell in the ledger table (full time, agent without "-bot", full decision word, short rule names), rows that open on click or Enter.
- `index.html`, `README.md`, this file.

### Build 3: the Factory, tiers, interiors, plain words (Saturday 2026-11-07 evening, `docs/BUILD3.md`, commit a446d49)

All new code, written during the event by Claude Code's four build streams (the gateway lifecycle; the world and the Factory; the interiors; reducer, HUD, main and tests). New files tonight:

- `src/tiers.js`: the tier table (Bronze, Silver, Gold, Diamond: rank, plain line, ceiling, medal colour), the same table as `gateway/tiers.py`; written with the spec (commit 65b74c3), before the streams started.
- `src/factory.js`: the Factory island's buildings: the iron FACTORY arch over the bridge's south end, the brick hall (sawtooth roof, two chimneys, the double door, the FACTORY signboard, the clock, the loading ramp with crates, the FLOOR plaque), the yard's four painted squares and its lamp, the inspection bay (four posts, a slate roof, the round lift, the gantry with its scanner arm, the tall screen) and the cart's parking spot.
- `src/rooms.js`: the seven interiors as cutaway rooms the camera orbits (the gatehouse with THE LEDGER chalkboard, THE HASH CHAIN receipts and TAMPER TEST; the FILES tower lobby, the GitHub studio, the Mail cottage and the Admin courthouse with their stations, lamps and boards; the Factory office with the whiteboard; the Factory floor with the production line), the text painted on 2048-pixel canvas textures, and the pure board-line builders the tests read. `room.js` folded into it.
- `tests/factory.json`: a hand-written recording in the gateway's event shapes (mint, a run from the yard, the patrol, three refusals and the quarantine into the bay, restore, a demotion, kill, retire); labelled as hand-written in the file, with placeholder hashes. It plays at `?replay=tests/factory.json`.
- `tests/factory.test.mjs` (14 tests): the robot appears and walks to the yard; a run from the yard skips the hatch; the quarantine escorts to the bay and opens the inquest; `inquestOf`; the demotion trims the chips; the kill carts to the bay with no summon of the chief; retire removes the robot; the five chip states; the tiers; the plain words; the older recordings still play.
- `tests/rooms.test.mjs` (8 tests): the ledger board's lines and the row-click mapping, the chain exhibit, TAMPER TEST on a copy, the workshop boards, the whiteboard, the floor board.
- `tests/rooms.html`: a scratch page that opens one interior in a bare stage (`?room=...`, `&build=1`, `&tamper=1`) for looking at a room without the island.
- `tests/demo3.test.mjs` (6 tests, added later Saturday night in commit 97a7d14): the Factory run on real AWS (`replay/demo3.json`, 56 rows) through the reducer: created first and retired last, every row draws something, the minted Gold robot walks to the yard and is gone after retire, promote and demote, the quarantine into the bay with an inquest that matches the gateway's, the cart for a killed robot.

Changed tonight: `src/reducer.js` (tiers on every agent; `created`, `tier_changed`, `retired`; quarantine and kill go to the bay; `inquestOf`), `src/hud.js` (the medal and PROMOTE / DEMOTE, the five chip states, the agent sheet, the office sheet with the NEW AGENT form, the inquest panel, the plain words), `src/main.js` (`GET /tiers`, the Factory's POSTs, the mint flow into the floor, rooms, keys H, F and ?), `src/scene.js` (the Factory, the rooms, picking a building, the bay screen), `src/actors.js` (six colours, the medal, the cart, the build and recycle steps), `src/world.js`, `src/buildings.js`, `src/effects.js`, `src/layout.js` (the Factory island, the moved dock, the new framing), `src/kit.js` (materials only), `src/ledger.js` (the DOM panels gone; `verifyChain` stays), `src/room.js` (now a re-export shim), `index.html` (the subtitles, the three small buttons, hide panels, the help sheet, the sheets), `tests/reducer.test.mjs`, `tests/additions.test.mjs`, `README.md`, this file, and `three-d-stage.js` (`setPixel`, as the table above says). The island's tests numbered 60 at a446d49 and 66 since 97a7d14 (`tests/demo3.test.mjs`).
