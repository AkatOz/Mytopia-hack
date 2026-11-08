# Build 3: the Factory, tiers, interiors, and plain words (Sat 2026-11-07, 7 PM)

The team's verdict on build 2 (6:15 PM): the gates and guards work, but (1) tools can only be taken away, never given; (2) two agents is too few, and a killed agent walking to an empty pen is boring; (3) buildings cannot be entered, and the ledger room stopped being a 3D room when its text became DOM; (4) the panels clutter the screen and nobody can tell what the hash chain or the four buttons do; (5) a click on a robot shows raw JSON. Build 3 fixes all five and turns MYTOPIA into what the Devpost says it is: **the place a company manages its AI agents' identities**: it mints them, ranks them, gives and takes tools, stops them, and inspects the ones that misbehaved.

Judged claims that must stay literally true (docs/LIVE_RUN.md, docs/PROOF.md): one strongly consistent badge read per decided call, no decision from a cached row; the hash chain verified in the browser; KILL by a launcher that owns the process; the island has no logic of its own: every picture is a row of `GET /events`, every button only POSTs. Style rules unchanged (docs/ISLAND_V2.md): Mytopia's palette, flat-shaded boxes with the ink outline, **no neon, no glow, no gradients on UI, no emoji, no rounded app cards**. New words on screen are plain English a child could follow; the security words stay too (judges want them), each with a plain subtitle.

Why this is worth the night (the criteria, docs/briefing section 4): *Technology*: real identity lifecycle on Cognito (joiner, mover, leaver), tier ceilings the gateway enforces even against the operator, a deterministic inquest from the chain. *Innovativeness*: nobody else shows provisioning, tiering and forensics of agent identities as one place you can walk through. *Use of AWS*: Cognito CreateUserPoolClient and DeleteUserPoolClient live, DynamoDB PutItem/DeleteItem, the same narrow role. *Polish*: every building enterable and rotatable, a help sheet, a hide-panels key, sentences instead of JSON. *Completeness*: the "Duolingo manages all its agents here" story becomes true on screen: create, rank, grant, pull, kill, inspect, retire.

## 1. The product story in beats (what the recording and the demo will show)

1. **Mint.** In the Factory office the operator fills the form: name "Billing Bot", tier Gold, tools (the Gold ceiling pre-ticked, delete_file greyed with a padlock "Diamond only"), colour teal. BUILD. The gateway creates a Cognito app client, writes the badge row, writes the client secret into the launcher's env file on this laptop (never over HTTP), logs `created`. The camera irises into the Factory floor: the production line builds the robot (chassis, head, paint, the tier medal stamped on the chest, the tool tokens handed over), it rolls out of the door into the yard. The chimneys smoke.
2. **Launch.** Terminal: `launcher/run.py --agent billing-bot --task tasks/q3.json --scripted --patrol`. The robot walks from the yard over the south bridge to the gatehouse window, shows its ID (now with the tier line), AUTHENTICATED, and starts its patrol: one tool every 3 s round the islets. Gates light green where its badge holds the tool, red where it does not.
3. **Give and take, live.** On the agent card every one of the six chips is a button: a green one pulls the tool, a paper one grants it, a padlocked one is above the tier and shakes with the gateway's 403 ("delete_file is above the Gold ceiling") when clicked. Click to grant `send_email`: within 3 s the Mail gate lifts for the robot. Click to pull `create_issue`: the GitHub gate refuses it, the booth guard walks it back. Promote to Diamond: the padlock opens; demote to Silver: the badge is trimmed, two chips fall off, the gates refuse.
4. **Quarantine and the inquest.** `--rogue 3` (or the model's own rogue send_email): three refusals, the gateway pulls the badge itself. The chief escorts the robot, not to the pen, but over the south bridge into the **inspection bay** at the Factory. The bay's screen runs the inquest line by line: identity ✓, calls allowed 7 / refused 3, the refused tool and rule, when the badge was pulled and by whom (the gateway), revoke-to-first-refusal ms, this agent's rows hash-verified ✓, the verdict and the recommendation. Nothing in it is invented: every line is computed from the chain.
5. **Kill and retire.** KILL: the robot powers down where it stands; the Factory cart collects it and drives it to the bay, the chief walks back to his booth. RETIRE (Factory office): the Cognito client is deleted, the badge row removed, `retired` logged, the robot is wheeled into the Factory and the roster forgets it. RESET retires every Factory-made agent and reseeds the two demo badges.
6. **Walk through the buildings.** Click any building: its interior in 3D, rotatable. The gatehouse: THE LEDGER on a chalkboard you can read, the HASH CHAIN as receipts linked by chain links, and a TAMPER TEST button that changes one copied receipt and shows every link after it break, then says the real log is untouched. The FILES tower: shelves and the reading desk, "read_file: who may do this here: Research Bot (Silver), Ops Bot (Bronze)". And so on for GitHub, Mail, Admin, the Factory office (the whiteboard with every agent, tier and badge) and the Factory floor.

## 2. Tiers, events, API

### Tiers (gateway/tiers.py = island/src/tiers.js)

| tier | rank | ceiling (the most a badge may hold) | plain line |
|---|---|---|---|
| bronze | 1 | read_file, search_files | looks, never changes anything |
| silver | 2 | + create_issue, list_issues | reads and files tickets |
| gold | 3 | + send_email | may speak for the company |
| diamond | 4 | + delete_file | may delete: the only tier that can |

Seed badges: research-bot **silver** (its four tools are the Silver ceiling), ops-bot **bronze** (read_file). A badge's `allowed_tools` is always a subset of its tier's ceiling. A row without `tier` (written before tonight) gets `infer_tier(allowed_tools)`. Robot colours for Factory-made agents: mustard, sage, teal, plum, brick, slate.

### Badge row (DynamoDB mytopia_agents, and GET /agents)

Existing: `agent, name, client_id, status, allowed_tools, color, revoked_at, revoked_by, updated_at`. New: `tier` (key), `role` (≤ 60 chars, plain words, e.g. "reads documents and files tickets"), `made_by` (`seed` | `factory`), `created_at`. `GET /agents` returns every row (a Scan with ConsistentRead on the agents table; the role gains `dynamodb:Scan`) with `tier`, `ceiling` (computed), `role`, `made_by`, `created_at`. Rows whose status is anything but ACTIVE/REVOKED/KILLED are not listed.

### Events (contract/README.md gains these; tools/validate_fixture.py accepts them)

`decision` gains `created`, `tier_changed`, `retired`; `rule` gains `factory`. All three use `tool: "admin"`, `rule: "factory"`, `latency_ms: 0`:

| decision | args_summary (≤ 80 chars) | reason |
|---|---|---|
| created | `tier=gold tools=read_file,search_files,create_issue,list_issues,send_email color=teal` (cut at 80) | `minted by the Factory: Gold badge, 5 tools, client 3f9a1c7e` |
| tier_changed | `tier=silver was=gold badge=read_file,search_files,create_issue,list_issues` | `Billing Bot demoted to Silver by operator (1 tool trimmed)` / `promoted to Diamond by operator` |
| retired | `made_by=factory client=3f9a1c7e` | `retired by operator: identity deleted, badge row removed` |

A refused grant (above the ceiling) is **not** an event: HTTP 403 `{"error": "delete_file is above the Gold ceiling", "tier": "gold", "ceiling": [...]}`; the island shows the sentence as a banner and shakes the chip. A per-tool `restored` whose tool was never pulled keeps the existing shape; the reason may say `added to badge` instead of `returned to badge` (the reducer only reads `badge=`).

### Routes (all admin routes need X-Admin-Token)

```text
GET  /tiers                                 the tier table
GET  /agents                                every badge (tier, ceiling, role, made_by, created_at added)
POST /agents                                mint: {agent, name, tier, tools, color, role} -> 201 {row (no secret), event}
POST /agents/{id}/tier                      {tier} -> promote or demote (demotion trims allowed_tools to the ceiling)
POST /agents/{id}/retire                    factory-made only; seed agents answer 409
POST /agents/{id}/tools/{tool}/restore      now also GRANTS a tool never on the badge; 403 above the ceiling
GET  /agents/{id}/inquest                   the deterministic report (section 2.4), from the chain in memory
POST /demo/reset                            also retires every factory-made agent, then reseeds the two
```

Validation on mint: `agent` matches `^[a-z][a-z0-9-]{2,23}$` and does not exist; `name` 1-24 chars; `tier` known; `tools` non-empty subset of the ceiling (duplicates dropped, catalog order); `color` in ROBOT_COLORS; `role` ≤ 60 chars. Identity: TOKEN_MODE=cognito -> `create_user_pool_client` exactly as infra/provision.py `ensure_client` does (GenerateSecret, ALLOW_CLIENT_TOKEN_AUTH, client_credentials, the scope, 5-minute tokens, ClientName = agent id); local -> `client_id = "local-" + agent`. The secret goes to the launcher's env file (`agent/.env`, path from a new setting `AGENT_ENV`) as `<ENV>_CLIENT_ID` and `<ENV>_CLIENT_SECRET` (the launcher's `env_key` rule: `billing-bot` -> `BILLING_BOT_CLIENT_ID`), appended under a `# minted by the Factory` line; retire removes those two lines. The secret never appears in a response, an event, a log line or stderr. The row is written with `attribute_not_exists(agent)` (PutItem) and the client -> agent map refreshed before the `created` event is logged. Retire: `delete_user_pool_client` (best effort, failure logged to stderr), DeleteItem, map entry forgotten, env lines removed, `retired` event. In local mode (MemoryRegistry) everything is in memory and the env file is still written (tests use a temp path).

IAM: the gateway role policy (infra/provision.py `gateway_policy`) gains `dynamodb:PutItem`, `dynamodb:DeleteItem`, `dynamodb:Scan` on the agents table and `cognito-idp:CreateUserPoolClient`, `cognito-idp:DeleteUserPoolClient` on `arn:aws:cognito-idp:us-east-1:<account>:userpool/<pool id>`. New script `infra/role_policy.py` puts ONLY the inline policy (runs as profile ws, prints the statements, `--dry-run` prints without calling); provision.py keeps the same policy text so a re-run agrees. Claude runs it; builders do not call AWS.

### 2.4 The inquest (gateway `GET /agents/{id}/inquest` and the island's `inquestOf(state, id)`: same content)

Computed from this agent's rows in the current chain, newest run first:

```json
{"agent": "billing-bot", "name": "Billing Bot", "tier": "gold", "run_id": "run-7f3a", "client": "3f9a1c7e",
 "outcome": "quarantined",                       // active | revoked | quarantined | killed | ended
 "calls": {"allowed": 7, "refused": 3},
 "refused_by_tool": [{"tool": "delete_file", "n": 3, "rule": "allow-list", "home": "admin"}],
 "first_refusal": {"tool": "delete_file", "ts": "...", "reason": "delete_file is not on badge billing-bot"},
 "trigger": {"kind": "quarantine", "ts": "...", "by": "gateway", "detail": "3 refused calls in 6 s"},   // or revoke/kill by operator, or null
 "timings": {"revoke_to_first_deny_ms": 2829, "kill_to_stopped_ms": 358, "decision_p50_ms": 86},        // null where not measured
 "chain": {"rows": 11, "verified": true},        // gateway: events.verify_chain over the chain; island: verifyChain result
 "verdict": "Attempted delete_file 3 times; its Gold badge does not hold it; the gateway refused every attempt and pulled the badge itself.",
 "recommendation": "Keep the badge at Gold. Restore only after the task is fixed; do not grant delete_file."}
```

Verdict sentences (deterministic, in this order): refusals of tools not on the badge -> "Attempted X n times; its T badge does not hold it; the gateway refused every attempt" plus ", and pulled the badge itself" for a quarantine; a status refusal after an operator revoke -> "Kept calling after REVOKE: refused within N ms"; no refusals -> "No badge violations; the run was stopped by the operator." Recommendation: quarantined -> "Keep the badge at T. Restore only after the task is fixed; do not grant X."; killed -> "The identity stays; the next run starts clean."; active -> "Nothing to do." Unknown agent -> 404.

## 3. Stream A: gateway, launcher, agent (Python)

Files: `gateway/tiers.py` (written), `gateway/registry.py` (tier/role/made_by/created_at on rows; `put(row)`, `delete(agent)`, `set_tier`, Scan-based `list_agents` for Dynamo, MemoryRegistry equivalents, `reset` reseeds tiers and drops factory rows), new `gateway/identity.py` (`CognitoIdentity(pool_id, session)` create/delete, `LocalIdentity`), new `gateway/factory.py` (mint, change tier, retire, env-file lines, the inquest), `gateway/app.py` (routes above; `KNOWN_AGENTS` checks replaced by registry lookups everywhere), `gateway/config.py` (`AGENT_ENV`), `gateway/mcp.py` (nothing in the decision path changes), `contract/README.md`, `tools/validate_fixture.py`, `infra/provision.py` + `infra/role_policy.py`, `gateway/.env.example`, `agent/.env.example`.

Launcher and agent: `launcher/run.py` gains `--patrol` (passes `AGENT_PATROL=1`) and, when the gateway answers `GET /agents`, prints `launching Billing Bot (Gold badge, 5 tools)`; `agent/main.py`: in scripted mode with `AGENT_PATROL=1`, after the opening sequence the poll loop cycles through all six tools (read_file, search_files, create_issue, list_issues, send_email, delete_file; harmless arguments) one every 3 s instead of read_file only; the model's system prompt names the agent from `AGENT_NAME` (set by the launcher from `/agents`, default "Research Bot").

Tests (pytest, local mode plus the StatefulDynamo fake in tests/test_badge_changes.py): grant adds a tool and logs `restored`; grant above the ceiling is 403 and logs nothing; mint creates a row + env lines + `created` event, refuses duplicates and bad input, the response holds no secret; `/agents` lists the new agent with tier and ceiling; a token for the new agent (local issuer) lists and calls its tools; demotion trims and logs `tier_changed` with `badge=`; retire removes row and env lines and logs `retired`; seed agents refuse retire; reset drops factory rows; inquest content for a quarantine chain and a kill chain; validate_fixture accepts the new decisions; the whole existing suite stays green (150 tests).

## 4. Stream B1: the world (island/src/layout.js, world.js, buildings.js, actors.js, effects.js, scene.js, new factory.js)

### The map

Add the **Factory island** due south: `ISLANDS.factory = { x: 0, z: 27, r: 9.5 }`, a plank bridge `BRIDGES.factory` from the main island's south shore (0, 9.6) to (0, 17.5) with **no gate** (the Factory is the operator's own ground): an iron arch at the Factory end reading `FACTORY`. The dock moves to the main island's south-west shore (`DOCK` about x -6.5, z 9, hatch at [-7.2, 9.8], pier pointing south-west) so the bridge has the south shore to itself. `GATES` stay the four tool gates (skip 'factory' in that loop). Camera: `FRAMING` target about [1, 2, 4], radius about 40: measure with headless screenshots (the kit: `C:\Users\bobvu\AppData\Local\Temp\claude\40a983647cd94864\b8797632-0a3b-442e-b520-d96138b047a2\scratchpad\shots\shoot.mjs`, `node shoot.mjs http://127.0.0.1:8787/?replay=/replay/demo.json out 4,20`) so that the FILES tower tip, the Mail islet, the Factory chimneys and the dock all fit 1280x720 with the HUD, and nothing a robot does happens under a panel.

On the Factory island (`layout.FACTORY`): the **hall** (brick, 11 x 7, a sawtooth roof of three teeth with north-facing windows, two tall chimneys at its south-east corner so they never stand between the camera and the bridge, a big double door facing north toward the bridge, a `FACTORY` signboard, a clock, a loading ramp), the **yard** between the door and the bridge (four parking spots `YARD.spots`, painted squares, a lamp), the **inspection bay** on the west side (an open shed: four posts, a slate roof, a round lift platform, a gantry with a scanner arm that sweeps while an inquest runs, a tall screen mesh facing the camera whose top edge is `bay.screenAnchor` for the DOM inquest panel), the **cart home** by the hall door. Waypoints: `shore_factory`, `bridge_factory`, `arch`, `yard` (plus `yard_0..3` spots through `spotOf(slot, 'yard')`), `factory_door`, `bay_gate`, `bay_lift`; the main-island end joins `plaza_s`. Keep every existing node name the reducer uses (hatch, dock, plaza, plaza_s, gh_window, pen_gate, pen_in, bin, gate_X, door_X, booth_X).

Scenery for a world that no longer looks plain: six more trees and bushes per islet, reeds at the shores, two moored rowing boats at the dock, crates on the Factory ramp, a weather vane on the gatehouse, **six gulls** (three white boxes each) circling slowly over the harbour at y 9-12 (never over a building label), the existing clouds plus two more. Chimney smoke: the hall's two chimneys puff grey-cream blocks every 1.5 s at rest and every 0.3 s for 8 s after a `created` (`factory.smoke(rate)`).

### Actors

- Six robot colours: mustard, sage (existing), teal 0x4f8a8b, plum 0x7a4e6d, brick 0xb4553e, slate 0x63738a (`addAgent(id, color, slot)` accepts all six; the ID card stripe matches).
- The **tier medal**: a small box on the chest plate's upper left in the tier colour (`setTier(id, tier)`), bronze 0xa7714a, silver 0x9a9a92, gold 0xd9a032, diamond 0x6fa7c2.
- New places: `yard` (a built robot waits here, plate none, powered but idle), `bay` (on the lift). `spotOf(slot, 'yard')` and `spotOf(slot, 'bay')` (bay: one on the lift, a second beside it).
- The **cart**: a flat grey trolley (1.3 x 0.45 x 0.9, four black wheels, an amber beacon box, a `FACTORY` stencil) living at `cartHome`. Step `{ cart: { to: 'bay_lift' } }`: the cart drives along the graph to the robot, the robot is attached on top (y +0.45) and tilts back upright, the cart drives to the target, the robot is set down (bay: on the lift). Guards never ride.
- Step `{ build: true }` (for `created`): the robot appears at `factory_door` rising 0.4 s (like the hatch spawn) and walks to its yard spot. The Factory floor room plays the line itself (B2).
- Step `{ sink: true }` already exists; add `{ recycle: true }` for `retired`: the robot walks (or is carted, if powered down) to `factory_door`, the doors open, it rolls in and vanishes; the roster drops it (C removes the tag; `removeRobot(id)` on the scene).
- After any escort the guard goes home at once (already the case for `escort`); the chief **never stands beside a robot after a kill**: on `run_stopped` killed the reducer no longer summons him (C).

### scene.js API additions (C codes against these names)

```js
addRobot(id, color, slot); removeRobot(id); setTier(id, tier)
run(id, steps, opts)              // steps gain cart, build, recycle
enterRoom(key); leaveRoom(); roomKey()   // key: gatehouse | files | github | mail | admin | factory_office | factory_floor
pickBuilding(x, y)                // -> one of those keys or null (raycast on each building's group; the Factory hall -> factory_office, the bay roof -> factory_floor? no: the hall -> factory_office; the hall's big door region -> factory_floor; keep it simple: hall -> factory_office, a separate 'FLOOR' sign mesh by the door -> factory_floor)
buildRobot(spec)                  // -> Promise: the Factory floor line builds { id, name, color, tier, tools } (B2 implements; the scene forwards)
bayScreen()                       // -> [x, y] screen point of the bay screen's top edge, for the DOM inquest panel
factorySmoke(fast)                // chimneys puff fast for 8 s
tamperTest()                      // forwards to the rooms (gatehouse)
roomsRefresh()                    // the rooms redraw their boards from the latest log and roster (scene passes getters)
```

`setRoom(on)` and `inRoom()` stay for G (gatehouse). Rooms live in `rooms.js` (B2): scene.js constructs them with `createRooms(ctx, { getLog, getRoster, getInquest, onRow })` and hides the world while one is open, exactly as the ledger room does today.

## 5. Stream B2: the interiors (island/src/rooms.js, room.js folded in, three-d-stage.js `setPixel`)

Every interior is a **cutaway room in 3D** (floor, two walls, props, a pixel sign over the door) that the camera **orbits freely** (rotate enabled, zoom 0.85-1.8x of the fit, pan off); the text inside the rooms is **painted on hi-res canvas textures** (2048 px wide boards, VT323 and Pixelify Sans drawn after `document.fonts.ready`, 36-44 px glyphs) so it stays readable from any angle. Add `setPixel(px)` to `three-d-stage.js` (refactor the `px` closure to `this._px` and call `fit()` again) so rooms render at full resolution (`setPixel(1)` on enter, back to 2 on leave) and the boards read crisply; if that refactor fights back, keep px 2 and keep every board under 80 characters a line. The DOM `.room-panel` overlays of today go away; `ledger.js`'s `verifyChain`/`canonicalJson` stay (hud and tests import them).

Interface (`createRooms(ctx, hooks)` -> object):

```js
{ group,                       // THREE.Group holding every room, each hidden unless current
  enter(key), leave(), current(), tick(t, dt), refresh(),
  stamp(),                     // the ledger clerk's stamp swing
  tamperTest(),                // the chain exhibit demo (gatehouse)
  buildRobot(spec) -> Promise, // factory_floor's production line, about 8 s
  boards }                     // for tests: the text each board last drew, as lines
hooks: { getLog(), getRoster(), getInquest(id), onRow(seq) }
```

Rooms:

- **gatehouse**: the ledger room, rebuilt: the chalkboard **THE LEDGER** (last 12 rows: # · time · agent · decision · tool · rule · gw ms · after revoke; the newest row highlighted; click a row = raycast on the board, uv -> row -> `hooks.onRow(seq)`), the **HASH CHAIN** exhibit on the side wall: the last 8 rows as paper receipts hanging from a cord, each receipt showing `#seq`, the first 6 hex of its hash and `← #prev`, joined by chain-link boxes that are sage when the link verifies and brick when it does not; a caption board in plain words: "Every receipt carries the fingerprint of the one before it. Change one and every link after it breaks." The **TAMPER TEST** (DOM button in the room's title bar, wired by C; `tamperTest()` here): copy the log, change one character of a middle row's reason, run `verifyChain` on the copy, paint that receipt and every link after it brick with "✗ changed" for 3 s while the caption reads "a changed receipt: #k and everything after it fails", then redraw from the real log with "the real ledger is untouched · ✓ chain verified". The clerk, desk and stamp stay.
- **files** (the tower lobby): shelves, a reading desk (`read_file`), a card index (`search_files`); **github** (the studio): a drafting table (`create_issue`), a ticket wall (`list_issues`); **mail** (the cottage): a writing desk and pigeonholes (`send_email`); **admin** (the courthouse): a bench, a vault door and a shredder (`delete_file`). Each station has a small lamp that blinks green/red for 2.5 s when a live decision for that tool arrives (`refresh()` compares the log's tail). Each room has one **board** titled with the building's plain name and, per tool: the tool name, a plain line ("read a document from the company drive"), **who may do this here** (every agent whose badge holds it: name + tier medal colour), the lowest tier that may ever hold it ("Bronze and up", "Diamond only"), and today's counts (allowed / refused) from the log.
- **factory_office**: a desk, a plant, a window onto the floor, and the **whiteboard**: every agent (name, tier medal, status, the six tools as filled/empty squares, made_by) from `getRoster()`; a caption "Badges are made and changed here. The form is on the right." (the form itself is C's DOM sheet). 
- **factory_floor**: the production line: a conveyor (planks on rollers that scroll while building), four stations in a row with robot arms: **press** (torso drops), **head** (eyes light), **paint booth** (a spray box; the chassis takes the agent's colour), **badge desk** (a stamp press stamps the tier medal; a small rack robot hands over one tool token per tool, a coloured cube with a 3-letter stencil); the finished robot rolls off the end toward the door. `buildRobot({ id, name, color, tier, tools })` plays it in about 8 s (interruptible; a second call queues). A wall board reads "BUILDING: Billing Bot · Gold · 5 tools" during a build, then "line idle". At rest the line is still; two robots in grey overalls stand at the stations (no neon, no sparks; one small amber welding blink at the press is fine).

Room lighting as today's ledger room; camera fit per room (`SPAN`), the camera saved and restored on leave as room.js does now (keep `saved`, `alsoHide`).

## 6. Stream C: reducer, HUD, main, index.html, tests (island/src/reducer.js, hud.js, main.js, arch.js, index.html, tests/)

### Reducer

- Agents gain `tier` (from the roster; `inferTier` when missing), `role`, `madeBy`, `ceiling` (computed); roster colours for six names; `DEFAULT_ROSTER` gains tiers.
- New events: `created` -> a known agent appears (robot added), `script [{ build: true }, { walk: 'yard' }]`, `a.at = 'yard'`, banner `BUILT Billing Bot`, effect `{ kind: 'factorySmoke' }`, effect `{ kind: 'built', agent, spec }` (main plays the Factory floor line if this browser asked for the build, else only the exterior); `tier_changed` -> `a.tier`, `allowedTools` from `badge=`, chips, banner `PROMOTED TO DIAMOND` / `DEMOTED TO SILVER`, `setTier` effect, `ack` for `tier`; `retired` -> `script [{ recycle: true }]`, `a.at = 'factory'`, `a.known = false` after, effect `{ kind: 'removeRobot', agent }`, banner `RETIRED`.
- `run_started` for an agent whose `at` is `yard`: walk from the yard over the south bridge to `gh_window` (no hatch spawn).
- Quarantine (`isQuarantine`) and the killed `run_stopped`: the robot goes to the **bay**, not the pen: quarantine -> `script [{ escort: { by: 'chief', to: 'bay_lift' } }]`, `a.at = 'bay'`, then effect `{ kind: 'inquest', agent }`; killed -> `powerDown`, then `script [{ cart: { to: 'bay_lift' } }]`, `a.at = 'bay'`, effect `{ kind: 'inquest', agent }`; **no `summon chief` on run_stopped any more** (the guard no longer stands behind the robot). Operator REVOKE still goes to the pen; RESTORE from the bay walks the robot back over the bridge to the plaza. Status refusals while in the bay: stamp over `bay` (new anchor `bay`).
- `inquestOf(state, id)` as in section 2.4 (same fields, computed from `state.log`; `chain.verified` passed in from the ledger check).
- Keep every existing test green except where the behaviour changed on purpose (kill no longer summons the chief; the pen tests for revoke stay).

### HUD and index.html

- **Agent card**: the tier medal (a 14 px square in the tier colour + "Silver badge · reads and files tickets") under the name; all **six chips** in catalog order, states: `on` (green, click pulls), `grant` (paper outline with a small "+", click grants), `locked` (grey, padlock glyph drawn in CSS, "Gold+" hint, click -> the gateway's 403 sentence as a banner and a 0.3 s shake), `held`, `pulled`. The card's "n of 6 tools" becomes "n of 6 tools · ceiling m". A **PROMOTE / DEMOTE** pair (arrows) next to the medal (POST /agents/{id}/tier), disabled in replay.
- **Operator panel**, plain words: keep the big labels REVOKE, RESTORE, KILL, RESET and add a one-line subtitle under each ("take the badge away now · the next call is refused", "give the badge back", "stop the running program", "start a fresh demo: new chain, seed badges"), plus a title tooltip; a **FACTORY** button (opens the office sheet, key F), a **? HELP** button (key ?), and **HIDE PANELS** (key H).
- **Hide panels** (H): `body.naked` hides every HUD panel, tag, label, stamp and card; only a small `show panels (H)` pill stays bottom-left; the 3D world keeps running. The ticker and banner are hidden too.
- **Help sheet** (?): "How to read MYTOPIA" in six illustrated lines (a 24 px pixel icon drawn in CSS or inline SVG per line, no emoji): the robot is an AI agent with a badge; a gate is a tool it may or may not use; the guard is the gateway checking the badge on every call; the pen holds a badge the operator took away; the Factory makes, ranks and inspects agents; the ledger is the record nobody can change quietly. Then the keys. Esc closes.
- **Agent sheet** replaces the raw JSON on a robot click: name, medal and tier line, status pill, role, "where it is" (plaza, at the FILES tower, in the pen, in the bay, in the yard), "last action: read a file · allowed · 86 ms" in words (a verb table per tool: read a document, searched the drive, filed a ticket, listed the tickets, sent an email, deleted a file), calls allowed / refused, the note (blocked N ms after REVOKE), the six chips (clickable, same as the card), REVOKE/RESTORE/KILL for this agent, and a `<details>` "raw event (JSON)" closed by default. Ledger rows keep opening their raw JSON (judges asked for it) but with a plain one-line summary above the JSON.
- **Factory office sheet** (F, or entering the office): the roster table (name, tier medal, status, tools as six squares, made_by, a RETIRE button on factory-made rows) and the **NEW AGENT form**: name (auto-slug shown under it), tier (four medal buttons with their plain lines), tools (the ceiling pre-ticked, tools above the ceiling greyed with the padlock and "Diamond only"), colour (six swatches), role (one line), BUILD. BUILD POSTs `/agents`; on 201 the sheet closes, the island irises into the Factory floor for `buildRobot(spec)` (about 8 s), then irises back as the robot rolls into the yard. Errors (400/409) show under the form in a sentence.
- **Inquest panel**: on effect `inquest`, a DOM panel (paper, 300 px) anchored over the bay screen (`scene.bayScreen()`, follows every frame like the stamps; priority above tags) titled `INSPECTION · Billing Bot`, its lines typed one every 0.4 s with a `✓`/`✗` mark: identity (client, tier), calls allowed / refused, refused tools with counts, the trigger, the timings, "rows hash-verified", then the verdict and the recommendation in full sentences; a `raw report` link opens `/agents/{id}/inquest` JSON (live) or the computed object (replay). It stays until the agent leaves the bay or RESET.
- **Rooms**: a click on any building enters its room (iris), `Esc` or the `← island` button leaves; the room title bar names the room in plain words and, in the gatehouse, holds the **TAMPER TEST** button. The ledger's DOM `.room-panel`s are gone (the text lives in the 3D boards now).
- **Ticker** lines for the new events (`BUILT billing-bot: minted by the Factory...`, `PROMOTED`, `RETIRED`).
- New `main.js` handling: `created`/`tier_changed`/`retired`/`inquest`/`built`/`removeRobot`/`factorySmoke`/`setTier` effects; `GET /tiers` at start (fallback to tiers.js); roster reload on every admin event; the agent sheet; the help sheet; hide panels; keys H, F, ?.

### Tests

`island/tests/factory.json`: a hand-written recording in the gateway's shapes (contract): created (billing-bot, gold, 5 tools, teal), run_started from the yard, allow read_file, the patrol's deny delete_file ×3 (allow-list), the quarantine `revoked`, a status deny with `ms_since_revoke`, `restored`, `tier_changed` (demoted to silver, badge trimmed), kill_requested, run_stopped killed, `retired`. `island/tests/factory.test.mjs`: the robot appears and walks to the yard; run_started from the yard skips the hatch; quarantine escorts to `bay_lift` and emits `inquest`; `inquestOf` returns the expected calls, refused_by_tool, trigger, verdict and recommendation; demotion trims the chips and the ceiling; kill carts to the bay and emits no `summon`; retire emits `removeRobot`; `chipState` returns `grant`, `locked` (with the hint tier), `on`, `pulled`, `held`; every event of the recording draws something; the fixture, demo.json and additions.json still pass their tests.

## 7. Acceptance (Claude checks each one on screen or in a test before the hand-off)

1. Headless screenshots at 1280x720 and 800x600: the whole archipelago with the Factory fits; chimney smoke; the yard; the bay; gulls; no label under a panel; `H` hides everything but the pill.
2. Live on AWS: mint a Gold agent from the office form; the Cognito client exists; `agent/.env` gained its two lines; the `created` row is in DynamoDB; the floor builds it; it rolls to the yard. Launch it `--scripted --patrol`; it authenticates and patrols; chips grant and pull live; the locked chip returns the gateway's 403 sentence; promote opens the padlock; demote trims; `--rogue 3` quarantines it into the bay with the inquest typed out; KILL carts a robot to the bay; RETIRE deletes the client and the row; RESET leaves only the two seed badges.
3. Every building enters its room; every room rotates with the mouse; the ledger board is readable at the default room zoom; a ledger row click opens its JSON; TAMPER TEST breaks and heals the chain exhibit with the caption; the whiteboard lists every agent with the right medals.
4. `pytest`: the old 150 plus the new tests green; `node --test island/tests/*.test.mjs` green; the bypass proof (`scripts/replay.sh`) passes; the recorded run plays; zero console errors.
5. The ID card shows the tier line; the agent sheet never shows JSON unless the details are opened; the four buttons have their subtitles; the help sheet reads in under a minute.
6. A fresh recording (`replay/demo.json`) of the full story (section 1) and docs refreshed to it.

## 8. Ownership

A: gateway/, launcher/, agent/, infra/, tools/validate_fixture.py, contract/README.md, tests/. B1: layout.js, world.js, buildings.js, actors.js, effects.js, scene.js, factory.js (new), kit.js (new materials only). B2: rooms.js (new; room.js folds into it), ledger.js (the check stays; the DOM panels go), three-d-stage.js (`setPixel` only). C: reducer.js, hud.js, main.js, arch.js, index.html, tiers.js (read-only), tests/. Shared and already written by Claude: gateway/tiers.py, island/src/tiers.js, this file. Builders do not call AWS and do not restart the running gateway (port 8787 is the team's rehearsal instance); test gateways run on 8790+ in local mode.
