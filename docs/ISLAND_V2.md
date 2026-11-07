# Island v2: the archipelago (design brief, Sat 2026-11-07, 3 PM)

The team's verdict on v1 at 3 PM: one plain island, buildings that nothing guards, popups that collide, an unreadable ledger board. v2 keeps everything that works (the reducer, the polling, the contract, the paper HUD language, Mytopia's palette and building recipes, the half-resolution pixel render with the ink outline) and rebuilds the world so that **the security story is the picture**: every tool lives on its own islet, every islet is reached over one bridge, every bridge has a gate with a guard, and nothing crosses a gate without showing its badge.

Style rules, non-negotiable: Mytopia's palette (cream paper, ink brown, signal orange, sage, mustard, brick, slate), flat-shaded boxes with the ink outline, no neon, no glow bloom, no gradients on UI, no emoji, no rounded "app" cards. Everything on screen either is a row in the decision log or is scenery.

## 1. The world, top view

Units are scene units (one terrain tile = 1). The camera is the existing orthographic iso view from the south-east; "north" is away from the camera (negative z), "south" is toward it (positive z), "west" is screen-left (negative x).

```
                 Mail islet (-11,-21)           GitHub islet (12,-21)
                        ●  bridge NW                 ●  bridge NE
                         \                          /
  Files islet (-23, 0) ●—— bridge W ——  MAIN ISLAND  —— bridge E ——● Admin islet (23, 0)
                                       (0,0) r≈10
                                       gatehouse (0,-5.5)
                                       plaza (0,0)  pen (6.5,4)  bin (-6.5,4)
                                       dock (0, 11) : robots spawn here
```

| Place | Centre (x, z) | Radius | What stands on it |
|---|---|---|---|
| Main island "the harbour" | (0, 0) | 10 (edge noise ±0.9) | the gatehouse (gateway HQ) at (0, -5.5) facing south; the plaza paved from (0,-2) to the dock; the dock pier at (0, 11) sticking out south; the holding pen (OFF LIMITS rope) at (6.5, 4); the BLOCKED bin at (-6.5, 4); lamps, trees, bushes, a flagpole |
| Files islet | (-23, 0) | 6.5 | the FILES tower (skyscraper), door facing east toward the bridge |
| Admin islet | (23, 0) | 5.5 | the courthouse, door facing west |
| Mail islet | (-11, -21) | 5.5 | the cottage with the mailbox, door facing south-east |
| GitHub islet | (12, -21) | 5.5 | the glass studio, door facing south-west |

Bridges (wooden plank decks 1.6 wide, rope rails, two piers per bridge, slight sag in the middle, each plank a box so the outline shader draws them):

| Bridge | From main-island edge | To islet edge | Gate at the main-island end |
|---|---|---|---|
| W (Files) | (-10, 0) | (-16.5, 0) | gate at (-9, 0), booth at (-9, -1.6) |
| E (Admin) | (10, 0) | (17.5, 0) | gate at (9, 0), booth at (9, 1.6) |
| NW (Mail) | (-6.5, -7.6) | (-8.5, -15.6) | gate at (-6, -6.6), booth beside it on the outer side |
| NE (GitHub) | (7, -7.6) | (9, -15.6) | gate at (6.5, -6.6), booth beside it on the outer side |

Every gate: two square posts (wood_dark) with a striped barrier arm (red/white) pivoting on the booth side, a small signboard on the far post with the tool names of that islet (3D box + canvas texture, big letters, e.g. `FILES` on line one and `read_file · search_files` on line two), a booth (plaster box 1.2×1.9×1.2 with a dark-blue band, a window on the gate side, a tile roof, a lamp cube on the roof that is grey by default, green while a crossing is allowed, red after a refusal, for 2.5 s) and **one guard inside** (see 3).

The world is bigger than v1 by about 2.3× in radius. Frame it with `stage.setObject(world, { target: [0, -1.5, -3], radius: 27 })`, `minZoom 0.7`, `maxZoom 3`, pan disabled. Keep the floating-island look (dirt and rock undersides, no water): the bridges span the air between the islands, which is Mytopia's own idiom. Add six slow pixel clouds (clusters of 3 to 5 white boxes, `noNormal` so the outline does not ink them) drifting below the islands at y ≈ -6, and three above the horizon. Nothing else moves in the sky.

## 2. Buildings

Reuse the v1 recipes (`windowOn`, `door`, `archWindow`, `gableRoof`, the four buildings) scaled by 1.15, and add:

**The FILES tower** (the skyscraper, the landmark; replaces the brick library). Footprint 4.6×4.6, stone base two floors tall and 5.4 wide (arched windows, columns at the door), a brick shaft of seven floors above it (each floor 1.0 high: a band of `brick_dark` every floor, a 4×1 grid of windows per face, about 40 percent of them `window_lit` chosen with the seeded RNG so the pattern never changes), a setback at floor 7 (the top two floors 3.6 wide, stone), a flat roof with a parapet, a water tank on legs, an antenna with a red tip, and a vertical sign down the east face reading `F I L E S` (stone letters as boxes, one per letter, or a canvas-textured board 0.7 wide; letters must read at the default zoom). Total height about 11.5 units: it must be the tallest thing on screen by a wide margin and visible behind the HUD's left column. Its door lamp (see 4) sits over the door.

**GitHub studio**, **Mail cottage**, **Admin courthouse**: as v1, scaled 1.15, each with its door facing its bridge and a door lamp.

**The gatehouse** (the gateway's HQ, on the main island): a two-storey stone office 7 wide × 4.5 deep, slate roof, a clock face on the gable (canvas texture, hands fixed at 9:15), a `GATEWAY` signboard over the door, a flagpole with an orange pennant, the chief guard's booth at its left corner. The ledger room (section 6) is its interior. Clicking it or pressing G opens the room.

## 3. Actors

**Agents** are v1's robot recipe at scale 3 (mustard Research Bot, sage Ops Bot) with the chest plate (grey, green, red, amber, dark) and, new, a small **ID card** mesh (0.5×0.35 paper with a mustard/sage stripe) held in the left hand that is hidden except during an ID check, when the arm raises it for 0.7 s.

**Guards** (new): the same robot recipe recoloured as a police uniform, no neon: body `0x2f3b55` navy, head cream, a peaked cap (a navy box 0.42×0.1×0.3 on top of the head plus a brim box in front, cap band `0x1f2738`), a brass star on the chest (a small `brass` box), black treads, no antenna. Scale 3 like the agents. Five of them: one in each booth (visible through the booth window; the booth is open on the gate side) and the **chief** at the gatehouse booth. A guard has three poses: standing in the booth, walking (the same bob as the agents), and escorting (walking half a unit behind and beside the agent with the arm extended toward it).

**Movement**: straight segments with ease at both ends, speed 3.0 units/s (agents) and 3.4 (guards); walking paths go through named waypoints so a robot never cuts across a building: `dock → plaza_s → plaza → gate_X → bridge_X_mid → door_X` and back. The agent faces its direction of travel; at rest it faces south (the camera). No pathfinding library: a hand-written waypoint graph in `layout.js`.

## 4. What each event does (the rituals)

Each agent runs a **script queue** (`actors.js`): an event turns into a script of timed steps; a new event for the same agent appends its script; if the queue holds more than one pending script, all but the newest are fast-forwarded (jump to end state, no animation) so the picture never lags the log by more than one call. Replay and live use the same code.

| Event | Script (times are targets; everything is interruptible) |
|---|---|
| `run_started` | the robot rises out of the dock hatch (0.4 s), walks to the gatehouse window (plaza_s → plaza → gatehouse_window), raises its ID card (0.7 s), the chief's lamp turns green, the plate pops grey → green with a 0.2 s scale bounce, banner AUTHENTICATED, the robot walks to its plaza spot. Card: "badge: 4 of 6 tools". |
| `allow` (tool at islet X; `tools/list` is the gatehouse) | if not already at door_X: walk to gate_X, stop 0.3 s, raise the ID card (0.7 s), the booth lamp turns green, the barrier lifts, walk across the bridge to door_X. At the door: the door lamp turns green for 2.5 s, a **slip** (a small paper 0.3×0.4, green-edged) flies from the door lamp to the gatehouse roof in 1.0 s along a raised arc (the log entry arriving at the ledger). `tools/list`: the robot walks to the gatehouse window, the chief's lamp blinks green, a slip rises from the window. The robot stays where it is until the next event. |
| `deny`, rule `allow-list` (tool at islet X) | walk to gate_X, stop, raise the ID card, the booth lamp turns **red**, the barrier stays down, a DENIED stamp appears **over the gate** (section 5), a red-edged slip flies to the gatehouse, a red packet drops into the BLOCKED bin. The booth guard steps out (0.5 s), walks to the robot and **escorts it back to the plaza** (both walk; the guard stays half a unit behind on the bridge side, arm out), then the guard walks back to the booth. The gate's refusal counter sign increments (a small canvas-textured plate on the booth: `REFUSED 1`). No smoke on the building: the building did nothing. |
| `deny`, rule `status-revoked` or `status-killed` | the robot is in the pen (see `revoked`). It raises its ID card inside the pen; the pen lamp turns red; a DENIED stamp over the pen; a red slip; a red packet in the bin. The robot does not move. Card note: `blocked 494 ms after REVOKE` (from `ms_since_revoke`). |
| `deny`, rule `token`, `registry-unavailable`, `header-mismatch` (agent may be unknown) | the gatehouse window: red lamp, DENIED stamp over the gatehouse, a red slip and a packet; if the agent has a robot it walks to the window first. |
| `revoked` | plate → red; the robot stops where it is (mid-bridge, at a door, in the plaza); the **chief guard** walks from the gatehouse booth to the robot and escorts it to the pen (waypoints back over the bridge if needed, barrier lifts for the guard), the rope gate closes behind it; banner REVOKED. The robot stays in the pen. |
| `restored` | the chief walks to the pen, the rope gate opens, the robot walks to its plaza spot, plate → green, banner RESTORED, the chief walks back. |
| `kill_requested` | plate → amber; the robot freezes in place (even mid-walk); banner KILL REQUESTED; the chief walks toward it (arrives in time for the stop). |
| `run_stopped`, killed (a `kill_requested` precedes it, or the reason says "killed by harness") | the robot **powers down**: eyes out, plate dark, antenna tip off, it sinks 0.15 and tilts 6°, a grey puff rises once; banner RUN KILLED; ticker `run stopped 1274 ms after KILL · exit 1 (killed by harness)`. The chief stands beside it. No fire anywhere. |
| `run_stopped`, exited on its own | the robot walks back to the dock and sinks into the hatch; plate grey; banner RUN ENDED. |
| RESET (page reload) | everything back to the start: robots in the dock hatch, guards in booths, bins empty, counters 0. |

**Smoke** stays as the per-islet "trouble ladder" only for repeated refusals at the same gate: rung 1 (3 puffs over the booth) after 2 refusals at that gate, rung 2 (6 puffs) after 4. It clears on RESET. Fire is gone.

**Speech bubbles are gone.** The agent's last decision line lives in the agent card (section 5). The reason text for a revoke lives in the card's note and in the ticker.

## 5. The overlay and the HUD (DOM, crisp text, nothing collides)

All text that must be read is DOM, positioned over the canvas with `toScreen()`, never a canvas texture (the half-resolution render blurs canvas text; that was the v1 ledger problem). Overlay elements and their anchors:

| Element | Anchor | Rule |
|---|---|---|
| Agent name tag (`Research Bot`) | 0.2 above the robot's head | always on; small (VT323 18 px) |
| DENIED stamp (`DENIED send_email`) | above the **gate** (or pen, or gatehouse) that refused, fixed world point | one per anchor; a new stamp replaces the old; 1.6 s, the v1 stamp animation |
| Islet label (`FILES`, `GITHUB`, `MAIL`, `ADMIN`) | 1.3 above each roof | always on; ink background |
| Refusal counter | on the booth (3D canvas plate, not DOM; two big digits only) | |
| BLOCKED bin count | above the bin | always on |

**Collision pass**: every frame, after positioning, run one pass over the overlay elements sorted by priority (stamp > name tag > islet label > bin count): for each pair that overlaps (AABB with 4 px margin) move the lower-priority one down by the overlap plus 6 px, repeat at most 3 times. With bubbles gone and stamps anchored to gates, collisions are rare; the pass makes them impossible.

**HUD panels** (paper, 3 px ink border, hard shadow, Pixelify Sans headings, VT323 figures):

- Top-left: brand. Top-centre: the 44 px banner, 2 s. Top-right: the mode badge LIVE / STALE / REPLAY with its subtitle.
- Left, under the brand: **the agent card**, 320 px wide: tabs for the agents; name; `client s2ch2ppk` (first 8 of the Cognito client id); status pill; **the badge as six tool chips** in two rows (`read_file search_files create_issue list_issues send_email delete_file`), allowed ones filled green, the others grey with a strike; `calls allowed 8 · blocked 4`; `last: ALLOW read_file · 165 ms` (tone-coloured); the note line (`blocked 494 ms after REVOKE` in red, or the stop note).
- Right: **the operator panel**: `BLOCKED` with the big count; `acts on: research-bot`; REVOKE, RESTORE, KILL, RESET, SAVE REPLAY (as v1: disabled in replay, "sent..." until the event arrives); under it a **gateway strip**: `decisions 16 · p50 164 ms · p95 178 ms · chain ✓ verified` (p50/p95 from `latency_ms` of allow/deny rows in the log; chain status from section 6).
- Bottom: the ticker (newest line, seq in grey).
- The T table and the robot-click JSON sheet as v1.
- At 1280×720 and at about 800 px wide nothing overlaps the world's buildings' doors or the gates (the world's framing target is shifted so the left column covers only sky and the Files islet's far edge).

## 6. The ledger room (G)

Keep the 3D room (floor, two cutaway walls, the desk, the clerk who stamps each new row, the iris wipe). Replace both canvas boards with **DOM panels positioned over the board planes** each frame (`toScreen()` of the plane's four corners → `left/top/width/height`), so the text is crisp at any zoom:

- **THE LEDGER** (over the chalkboard): a table of the last 12 rows, newest at the bottom and highlighted: `#seq · time (HH:MM:SS.mmm) · agent · DECISION · tool · rule · gateway ms · since revoke · hash[0:8] ← prev[0:8]`. Decision colours: allow sage, deny brick, admin amber, harness grey. Header strip: `chain chain-20261107T220759Z · 16 rows · p50 164 ms · p95 178 ms · blocked 4 · ✓ chain verified` (or `✗ broken at #N`, or `not verified (replay fixture)`).
- **HASH CHAIN** (over the left paper): the last 8 links as `#15 7c2a…  ←  #14 9b01…` with a small check per link.
- **Verification in the browser** (`room.js`, `verifyChain(log)`): for each row, recompute `SHA-256` over the canonical JSON of the row without `hash`: keys sorted, no spaces (`JSON.stringify` of an object whose keys were inserted in sorted order, with `,` and `:` separators, which matches Python's `json.dumps(sort_keys=True, separators=(",", ":"))` for these ASCII fields), compare with `hash`, and check `prev_hash` equals the previous row's `hash` (`genesis` for the first). Use `crypto.subtle.digest`. A fixture whose hashes are placeholders reports `not verified`.

## 7. Module split (so two builders can work at once)

```
island/src/kit.js       materials, palette, primitives (box/cyl/ball/grp/pyramid), Batch, seeded RNG, canvasTexture helper   (shared; written first)
island/src/layout.js    every coordinate in section 1 + the waypoint graph + spotOf(agentSlot, place)                          (shared; written first)
island/src/world.js     islands, bridges, gates, booths, dock, pen, bin, clouds, props            → buildWorld(ctx) returns { world, gates, places, anchors }
island/src/buildings.js the tower, studio, cottage, courthouse, gatehouse                        → buildBuildings(ctx, world) returns PLACES (door, roof, lamp materials)
island/src/actors.js    agents, guards, the script queue, walking, poses, ID check, power-down    → createActors(ctx, layout, gates)
island/src/effects.js   slips, packets, stamps anchors, lamps, smoke ladder, clouds tick         → createEffects(ctx, ...)
island/src/room.js      the ledger room 3D + the DOM ledger/chain panels + verifyChain           → createRoom(ctx, stage)
island/src/hud.js       render(state), renderBadge, the overlay layout and collision pass, gateway strip
island/src/scene.js     createScene(stage): composes the above and returns the same API shape main.js uses today (addRobot, setPlate, move, …) plus the new script calls
island/src/reducer.js   as today; effects gain: gate (approach+id+cross), refuse (gate+escort), pen, release, powerDown, slip, stampAt
island/src/main.js      as today; replay uses real timestamp gaps clamped to [0.6, 3.5] s; the bubbles code goes
```

Builder A owns `kit.js`, `layout.js`, `world.js`, `buildings.js`, `room.js` (3D part). Builder B owns `actors.js`, `effects.js`, `hud.js`, `reducer.js`, `main.js`, `scene.js`, `room.js` (DOM part), `tests/`. The interface between them is `layout.js` (positions, waypoints) and the `PLACES`/`gates` objects returned by A's builders: `{ key, door: Vector3, roof: Vector3, lampMat, boothLampMat, barrier: Group, booth: Group, guardHome: Vector3, signTex }`.

## 8. What must not change

- The contract (`contract/README.md`): event shape, `GET /events?since_seq`, the four POST buttons, `GET /agents`, `GET /config.js`; order by `seq`; `apply(state, event)` stays pure and keeps its exported names (`apply`, `initialState`, `withRoster`, `badge`, `fresh`, `DEFAULT_ROSTER`, `ALL_TOOLS`, `TOOL_HOME`, `BUILDINGS`, `rung`).
- Served by the gateway at `/` as static files: relative paths, no build step, ES modules, vendored three.js 0.184 (`island/vendor/three`), self-hosted fonts, no request to any host but the gateway.
- Replay mode (`?replay=<file>`), the R key (fixture), the T table, Esc, G, robot click → raw JSON, the LIVE/STALE/REPLAY rule (3 s), SAVE REPLAY.
- The acceptance tests in `docs/ISLAND_ACCEPTANCE.md` (6) must pass again, plus: every one of the 21 fixture events draws something; the recorded run `replay/demo.json` plays end to end; at 1280×720 nothing overlaps; the ledger room's text is legible at arm's length in a screenshot.
- `island/ASSETS.md` keeps saying exactly what is pre-existing (the stage component, the recipes, the palette) and lists the new files.

## 9. Acceptance (what Claude checks with screenshots before the island is accepted)

1. Default view at 1280×720: four islets, four bridges, four gates with booths and guards, the tower unmistakably tallest, the dock, the pen, the bin; no HUD panel covering a door or a gate; the FILES sign readable.
2. Replay of `replay/demo.json`: AUTHENTICATED at the gatehouse window; the robot shows ID at the Files gate and crosses; `send_email` refused at the Mail gate with the stamp over the gate and the guard walking it back; after REVOKE the chief escorts it to the pen and the next three denies stamp over the pen; KILL freezes it; run_stopped powers it down; no text overlaps another at any moment (checked at 6 screenshots).
3. G: the ledger reads at arm's length; the gateway strip shows p50/p95 and `✓ chain verified` on a live chain, `not verified` on the fixture.
4. Live against the gateway: tests 2, 3, 4 of `docs/ISLAND_ACCEPTANCE.md`.
5. `node --test island/tests/*.test.mjs` green; no console errors; 60 fps on the demo laptop (the stage's own sharp fallback may drop to the old resolution; that is fine).
