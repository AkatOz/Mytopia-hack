# island/ — the face of MYTOPIA

The island draws the gateway's decision log. It never decides anything. Every animation is one row of `GET /events`, and the only things it sends back are button clicks (the four operator buttons and the six tool chips), each a POST that changes nothing on screen until the gateway's own event comes back.

## Answers to the brief's three questions

1. **Stack.** Plain ES modules plus **three.js 0.184** (WebGL), **no build step**. The renderer is Mytopia's `<three-d-stage>` web component: an orthographic camera, rendered at half resolution, with an ink-outline post-process for the pixel look. Every word on screen is crisp DOM laid over the canvas (the half-resolution render would blur canvas text). The gateway serves the `island/` folder as is; three.js and the fonts are vendored, so there are no CDN or network calls.
2. **Buildings.** An archipelago (`docs/ISLAND_V2.md`): each tool lives on its own islet, reached over one bridge with a gate and a guard. **Files** = the FILES tower, **GitHub** = the glass studio, **Mail** = the cottage, **Admin** = the courthouse, and the **gatehouse** on the main island is the gateway itself (its interior is the ledger room).
3. **Pre-existing vs new.** Pre-existing (from Mytopia, before this weekend): `three-d-stage.js` (unchanged) and the recipes gathered into `src/kit.js` (palette, materials, primitives), the terrain and scenery recipes, the building shapes and the small robot. Everything else is new this weekend. The full list is in [ASSETS.md](ASSETS.md).

## Run it

Served by the gateway at `http://127.0.0.1:8787/` (it serves its own `/config.js`). Replays: `?replay=/replay/demo.json` (the recorded run), `?replay=fixture.json` (the contract's 21 events), `?replay=tests/additions.json` (a hand-written recording of a per-tool revoke and a quarantine). Tests: `node --test island/tests/*.test.mjs`.

**Keys.** **G** (or a click on the gatehouse) opens the ledger room; click a ledger row, or Enter on it, for that row's raw JSON. **T** shows every event as a table. **A** opens the architecture sheet (who holds what, where the checks are, which picture proves which A10 step). **R** replays the fixture. **Esc** closes a sheet, or leaves the room. A click on a robot shows its latest event as raw JSON.

**Mouse.** REVOKE, RESTORE, KILL act on the selected agent's whole badge; RESET starts a new chain; SAVE REPLAY downloads every event seen. The **tool chips** on the agent card: live, a green chip (on the badge) is a button that pulls that one tool (`POST /agents/{id}/tools/{tool}/revoke`), a red struck chip marked "pulled" puts it back (`.../restore`); a grey struck chip was never on the badge and does nothing. Every button and chip reads "sent..." until the matching event arrives. In replay all of them are disabled.

**The mode badge** (top right): `LIVE · model` or `LIVE · scripted` (the selected agent's `agent_mode`, so a judge sees whether a model or a fixed script drives the calls), `STALE` when the gateway has not answered for 3 s, `REPLAY` when a file plays.

## How the island works (ten lines)

1. `src/reducer.js` has one pure function, `apply(state, event)`: it returns the new state and a list of effects. It applies each `seq` once, in order. Nothing else changes state.
2. `src/main.js` feeds it: live, it polls `GET /events?since_seq=<cursor>`; in replay, it plays a file at the recording's own pace. Same `apply` for both. It also wires the buttons, the chips and the keys.
3. Each event becomes a **script** for a robot (walk to a gate, show the ID card, the gate opens or refuses, a guard escorts it back) plus instant effects (plate colour, banner, stamp, slip, packet, lamp, padlock). `src/actors.js` plays the scripts: the robots, the five guards, walking on the waypoint graph of `src/layout.js`.
4. `src/world.js` builds the islands, bridges, gates, booths, the pen and the bin; `src/buildings.js` the five buildings; `src/kit.js` is Mytopia's recipes gathered into one file; `src/scene.js` puts them together and gives `main.js` one small API; `src/effects.js` draws slips, packets, lamps and smoke.
5. `src/hud.js` is every word you read: the agent card, the operator panel, the banner, the mode badge, the ticker, the name tags, the DENIED stamps and the ID cards anchored over the gate that acted, with one collision pass so nothing overlaps.
6. The **ID card** a robot raises shows its real `client` id, the scope, and the token line from the last event that mentioned it (`token OK · expires in 300 s`, or `signature OK · expires in 243 s` from a refusal); with no such event it says `token: checked by the gateway`, never a made-up number.
7. A **per-tool revoke** strikes that chip red "pulled", the badge count drops (3 of 6), a padlock hangs on that islet's gate and booth, and the next call of that tool is refused at its gate with the escort; the card's note says how many ms after the pull it was blocked.
8. A **quarantine** (the gateway pulled the badge itself after repeated refusals) is drawn like a revoke, chief and pen, under the banner and pill **QUARANTINED**; the REVOKE button never waits for it.
9. `src/room.js` and `src/ledger.js` are the ledger room: the last 12 rows and the hash chain, re-checked with SHA-256 in this browser (`✓ chain verified`, or where it broke). `src/arch.js` holds the architecture drawing.
10. The buttons only POST; in REPLAY they are disabled; if the gateway stops, the picture freezes and the badge says STALE. Nothing is ever invented on the client.

## Files a judge will open

| File | What it is |
|---|---|
| `index.html` | the page: paper HUD panels, CSS, the import map for the vendored three.js |
| `src/reducer.js` | the only logic: `apply(state, event)` → new state + effects |
| `src/main.js` | wiring: polling / replay, the effects queue, buttons, chips, keys |
| `src/hud.js` | every word on screen, as DOM |
| `src/arch.js` | the architecture sheet (key A) |
| `tests/*.test.mjs` | the fixture, the recorded demo and the round-two recording through the reducer; the chain check |
