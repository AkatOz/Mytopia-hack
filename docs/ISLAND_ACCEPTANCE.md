# Island acceptance run (gateway session, Sat 2026-11-07, 1:35 PM PT)

Island at `island/` as merged from branch `island` (commit 93869f9). Run in the Claude desktop browser pane (Chromium) on the demo laptop. Mock: `tools/mock_gateway.py`. Real gateway: `gateway/` in AWS mode (`MODE=aws`, `TOOLS_MODE=lambda`, `TOKEN_MODE=cognito`) on `http://127.0.0.1:8787`, backed by the event account (Cognito pool `us-east-1_Se7ydR6ys`, DynamoDB `mytopia_agents` / `mytopia_events`, Lambda `mytopia-tools`).

| # | Test (from the brief, section 6) | Result | What was seen |
|---|---|---|---|
| 1 | Replay: `index.html?replay=../contract/fixture.json` draws all 21 events, badge REPLAY, buttons disabled, `T` shows the table | PASS | Every event drew; the card showed "blocked 1840 ms after REVOKE" and, at the end, Ops Bot as RUN ENDED (exit 0) with no fire. The only console error was the expected `config.js` 404 on the plain static server. |
| 2 | Against the mock: badge LIVE, scene plays, REVOKE shows "sent..." then the plate turns red when `revoked` arrives | PASS | Mock on 8788 with fixture playback: LIVE "gateway answering"; after selecting Research Bot and clicking REVOKE, event #22 `revoked` arrived within a poll: banner REVOKED, status REVOKED, robot parked at the rope. |
| 3 | Stop the mock: STALE within 3 s, scene unchanged; start it again: LIVE | PASS | Mock process killed at 13:30:53; badge read "STALE, no answer for 7 s" with the scene frozen; after the restart the badge was LIVE again within a poll. |
| 4 | Served by the gateway at `/` with no dev server: relative paths, no console errors, no requests to any host other than 127.0.0.1 | PASS | The real gateway served `island/` at `http://127.0.0.1:8787/`. Console: no errors. Network: 43 requests, all to `127.0.0.1:8787` (`src/*.js`, `vendor/three/*`, `fonts/*.woff2`, `/agents`, `/events?since_seq=N`, `/config.js`). |
| 5 | Wifi off: the page still renders (local fonts and assets) | PASS (by inspection) | No request leaves the laptop (test 4's list); fonts and three.js are vendored. Not tested with the radio actually off; will be during the evening failure rehearsal. |
| 6 | Full screen at 1280x720 and at about 800 px wide | PASS | At 1280x720 everything fits with room to spare; at 800x600 the HUD narrows and nothing is clipped or overlapping. |

## Live integration, beyond the six

- Buttons against the real gateway: REVOKE wrote `status=REVOKED` to DynamoDB (`UpdateItem`, conditional on the row), the gateway appended `revoked` (seq 11), the island showed REVOKED within a poll; RESTORE did the reverse (seq 12). Both agents' tabs work.
- The chain drawn by the island is the same one in DynamoDB: `chain-20261107T212445Z`, 12 records, `prev_hash` links verified, the gateway role cannot list tables.
- The card shows the real Cognito client id prefix (`s2ch2ppk`) once a `run_started` names it.
- One gateway bug surfaced during this run and is fixed (commit 5a06ddd): the DynamoDB condition expression used the bare word `agent`, a reserved word, so REVOKE returned 503 on real AWS until aliased.

## Notes for the island side (no action required)

- Nothing failed. Stage B (ledger room, bin packets, Save replay) can start whenever you like; the live integration has passed.
- When the gateway restarts without `/demo/reset`, `seq` continues from the JSONL twin, so the island's cursor stays valid; `GET /events` also carries a `chain` key that changes only on reset.
- The gateway labels token failures and unknown tool names as `tools/list` (the gatehouse), never a tool name outside the six.

## Stage B check (2:05 PM PT, island commit f07d592 merged as 63a5a01)

- Ledger room (`G` or click the gatehouse): opened on the live gateway mid-activity; the chalkboard listed the last seven decisions (seq 35 to 41: RESTORED, ALLOW read_file, REVOKED, DENY read_file, DENY tools/list, DENY read_file, RESTORED) with the hash-chain board beside it and the clerk at the desk; `Esc` returned to the island. Those seven rows were the bypass-proof script's real calls against the gateway at that moment, so the room shows the live log, not a copy. PASS.
- Wording: the island files say nothing wrong, but on stage the chain is "tamper-evident", never "tamper-proof" (a judge will test the difference).
- Not yet exercised here: SAVE REPLAY (the island's own test covers it; the gateway-side recording `replay/demo.json` exists regardless).

## v2 acceptance (Sat 4:30 PM)

The island was rebuilt on Saturday afternoon as "the archipelago" (`docs/ISLAND_V2.md`) with round two on top (`docs/ISLAND_V2_ADDITIONS.md`), by Claude Code from Ozi's renderer and recipes (`island/ASSETS.md`). The six tests above still describe the contract it must keep; this is what was checked on the rebuilt island.

| Check | Result | What was seen |
|---|---|---|
| Replay of the new recording (the 4:18 PM model-mode run, then `replay/demo2.json`, now `replay/demo.json`) | PASS | Every beat plays: the ID card at the gatehouse window and AUTHENTICATED; the ID check at the FILES and GITHUB gates with the barrier lifting and the slips flying to the gatehouse; `send_email` refused at the MAIL gate with the stamp over the gate and the guard's escort; REVOKE with the chief's escort into the pen and the refusals stamped over the pen; KILL freezing the robot; `run_stopped` powering it down with "run stopped 358 ms after KILL". |
| Island tests (`node --test island/tests/*.test.mjs`) | 38 tests, PASS at the time of the check | See the note below the table: three of them broke when the recording was swapped. |
| Console | PASS | Zero errors, apart from three.js's deprecation warning for `THREE.Clock`. |
| Overlapping labels at 1280x720 | PASS | Sampled every 150 ms through the whole replay: no DOM label overlapped another (stamps, ID cards, name tags, islet labels, the bin count). |
| The ledger room (G) | PASS | No clipped cell (full time, agent, full decision word, short rule names); the header reads "chain verified", computed in the browser with SHA-256 and matching the gateway's hashes; a row opens its raw JSON with the DynamoDB `pk`/`seq` line. |
| The live page against the real gateway | To confirm in rehearsal 1 | The build session reported the badge reading `LIVE · model`, but no recorded run backs it: the only model-mode run on record (4:18 PM) is older than round two (commit fab83d6, 4:51 PM), which added the badge's second word. Check `LIVE · model` and `LIVE · scripted` by eye in rehearsal 1. |
| The architecture sheet (A) | PASS | Readable; Esc closes it. |
| Frame rate | To measure in rehearsal 1 | A figure of 53 fps was noted during the build, but no measurement was saved and it may have come from headless Edge; the target in `docs/ISLAND_V2.md` is 60 fps on the demo laptop. |

Verified only in headless Edge, not yet by eye in the demo browser: the replay walk-through, the label-overlap sampling, the ledger cells and the architecture sheet. Still to do in rehearsal 1 (7:00 PM): **a tool chip clicked on the live island** (the padlock, the refusal at that gate, the restore) and **a quarantine on the live island** (`--scripted --rogue 3`). Both were checked on the gateway against real AWS (`docs/LIVE_RUN.md`, third run), in the reducer tests, and by replaying the hand-written `island/tests/additions.json`, but neither has been seen live on the island.

**Note added at 5 PM by the docs pass, resolved at 5:05 PM: the three tests below now assert the new recording's values (2829 ms, 266 s at the 12th event, 358 ms, 11 decisions, p50 86 / p95 271 ms) and 38 of 38 pass. The history:** After `replay/demo.json` was swapped to the 4:18 PM recording (commit fab83d6, 4:51 PM), `node --test island/tests/*.test.mjs` reports 38 tests, 35 pass, 3 fail. The three still assert the first run's numbers against the new file: "ID card lines ..." in `tests/additions.test.mjs` expects `signature OK · expires in 254 s` at the 12th event; "gateway strip ..." in `tests/reducer.test.mjs` expects 12 decisions and a p50 of at least 156 ms; "the recorded demo plays end to end ..." expects `revokeMs` 494 and "run stopped 1274 ms after KILL". The island code is not at fault: the recording changed under the tests. Fix before rehearsal 1: point those three at `replay/demo-first-run.json`, or update their expected values to the new recording (2829 ms, 269 s, 358 ms, 11 decisions).

## v3 acceptance (build 3, commit a446d49, Sat 2026-11-07 7:29 PM PT): the checks of `docs/BUILD3.md` section 7

Status (written about 8 PM, updated later Saturday night after commits 97a7d14 and 84652de): the integration ran `pytest` (189 tests collected, reported green) and reported zero console errors; `node --test island/tests/*.test.mjs` passes 66 (60 at a446d49, six more on the AWS recording since 97a7d14; re-run while updating this). Bob put the Factory's IAM permissions on the gateway role at 7:53 PM (`infra/role_policy.py`) and the whole flow ran on real AWS at 7:55 PM as run 7 in `docs/LIVE_RUN.md` (run 6 is the same flow in local mode, with the island polling in headless Edge). The gateway-side boxes below are ticked from run 7; a box about what is seen on screen stays open until rehearsal 2, which becomes run 8. Claude writes the checker's name after "checked by". A box stays open until someone has seen the thing on screen or in a test result; the builders' reports do not count.

**1. Headless screenshots at 1280x720 and 800x600**

- [x] the whole archipelago with the Factory fits (checked by: Claude, headless Edge 1280x720 and 800x600, Saturday 7:30 to 8:10 PM: every islet, the Factory, its chimneys, the yard and the bay on screen)
- [x] chimney smoke (checked by: Claude, 2560x1440 crops of the Factory during the factory.json replay)
- [x] the yard (checked by: Claude, the same crops: four painted squares north-east of the hall door)
- [x] the bay (checked by: Claude, the same crops and the live AWS run: shed, lift, scanner, screen)
- [x] gulls (checked by: Claude, the 1280x720 frames: gulls over the harbour, clear of the labels)
- [x] no label under a panel (checked by: Claude, every 1280x720 frame of the local and AWS runs)
- [x] `H` hides everything but the pill (checked by: Claude, headless Edge 8:15 PM: no HUD element visible after H, the card back after the second H)

**2. Live on AWS**

- [x] `POST /agents` mints a Gold agent and the Cognito app client `billing-bot` exists in the pool (checked by: run 7, `docs/LIVE_RUN.md`: the client listed with the ws profile, 201 in 1.2 s)
- [ ] the same mint from the office form on screen (checked by: )
- [x] `agent/.env` gained its two lines (checked by: run 7, `docs/LIVE_RUN.md`)
- [x] the badge row is in `mytopia_agents` with `made_by factory` (checked by: run 7, `docs/LIVE_RUN.md`; the `created` event is seq 1 of chain `chain-20261108T035444Z` in `replay/demo3.json`)
- [x] the `created` event's twin row in `mytopia_events`, opened in the console (checked by: Claude, 8:15 PM, read with the ws profile: pk chain-20261108T035444Z seq 1, decision created, rule factory, hash db953c5d...)
- [ ] the floor builds it; it rolls to the yard (checked by: ) (the floor plays only in the browser that clicked BUILD; run 6 saw the Billing Bot tab with its Gold medal in headless Edge, not the floor)
- [x] launch it `--scripted --patrol`; it authenticates and patrols (checked by: run 7, `docs/LIVE_RUN.md`: `token OK`, `run_started` 1.5 s after the mint, one listed tool every 3 s)
- [x] a grant and a pull reach the gate live (checked by: run 7, `docs/LIVE_RUN.md`, through the gateway's routes: the pulled tool refused once 11,572 ms after the pull, the grant allowed on the next cycle)
- [x] the chips on the card do the same on screen (checked by: Claude, the AWS run watched in headless Edge: the pulled send_email chip struck red, the padlocked delete_file with its Diamond-only hint, the Diamond card with six green chips) (run 6 saw the pulled chip struck red in headless Edge)
- [x] the gateway's 403 sentence above the ceiling (checked by: run 7, `docs/LIVE_RUN.md`: `403 delete_file is above the Gold ceiling`, nothing logged)
- [x] the locked chip shows that sentence and shakes (checked by: Claude, builder C's live screenshot c2/08: the banner `delete_file is above the Gold ceiling` after the click; the shake is a 0.3 s keyframe, not watched)
- [x] promote raises the ceiling: `delete_file` granted and allowed after it (checked by: run 7, `docs/LIVE_RUN.md`)
- [x] the padlock opens on the card (checked by: Claude, the recording's replay at the Diamond beat: six green chips, no padlock) (run 6 saw the Diamond card with six green chips in headless Edge)
- [x] demote trims (checked by: run 7, `docs/LIVE_RUN.md`: four tools, `4 of 6 tools visible`, no refusal, no quarantine)
- [x] `--rogue 3` quarantines the agent; `GET /agents/research-bot/inquest` reads allowed 3, refused 4 (checked by: run 7, `docs/LIVE_RUN.md`)
- [x] the escort into the bay and the panel typed out, on screen (checked by: Claude, two live AWS runs watched in headless Edge 8:05 and 8:12 PM: QUARANTINED, the escort, the panel typed out line by line in the card's place) (the headless run 6 found and fixed one bug here, commit d6dec55)
- [x] KILL: the launcher kills the tree (checked by: run 7, `docs/LIVE_RUN.md`: psutil 116 ms, `kill_to_stopped_ms` 113)
- [x] the cart carries the killed robot to the bay (checked by: Claude, the same live runs: the robot's tag moved from the east gate to the bay lift 12 to 28 s after the kill; cartfix.mjs harness)
- [x] RETIRE deletes the client and the row (checked by: run 7, `docs/LIVE_RUN.md`: the pool lists the two seed clients again, the row and the env lines gone, `retired` at seq 56)
- [x] RESET leaves only the two seed badges (checked by: Claude, 8:07 PM after the AWS run: /agents lists research-bot and ops-bot, both ACTIVE, tiers silver and bronze)

**3. Rooms**

- [x] every building enters its room (checked by: Claude, the Files room entered by a click on the tower (builder C's frame c7/02), the gatehouse by G and by click; the other rooms seen through the rooms scratch page)
- [x] every room rotates with the mouse (checked by: Claude, the gatehouse rotated 40 degrees (builder B2's gh/rotated.png): boards still readable)
- [x] the ledger board is readable at the default room zoom (checked by: Claude, room.png of the integrated page: 15 rows legible at 1280x720)
- [x] a ledger row click opens its JSON (checked by: Claude, the rotated-room frame shows `row clicked: #7` from the raycast; the JSON sheet itself is the build-2 sheet, unchanged)
- [x] TAMPER TEST breaks and heals the chain exhibit with the caption (checked by: Claude, builder B2's tamper/t003 (broken at #11, brick links, caption) and t007 (healed, chain verified again))
- [x] the whiteboard lists every agent with the right medals (checked by: Claude, factory_office frame: three agents, Silver, Bronze, Gold medals, six badge squares, made by seed and factory)

**4. Tests and proofs**

- [x] `pytest`: the old 150 plus the new tests green (189 collected) (checked by: Claude, 8:20 PM on the final code: 189 passed in 28 s)
- [x] `node --test island/tests/*.test.mjs` green (66; 60 at a446d49, six more on the AWS recording since 97a7d14) (checked by: Claude, re-run Saturday night while updating this file: 66 pass, 0 fail)
- [x] the bypass proof (`scripts/replay.sh` or `scripts/replay.ps1`) passes on the build-3 gateway (checked by: Claude, 8:06 PM on the build-3 gateway in AWS mode: replay proof OK (still-valid token refused after revoke, tampered token 401, Lambda unreachable from the shell, badge restored))
- [x] the recorded run plays (checked by: Claude, replay/demo3.json played in headless Edge to seq 56 with the inquest shown at the quarantine beat, zero console errors)
- [x] zero console errors (checked by: Claude, every headless run of the night: only the THREE.Clock deprecation warning)

**5. Plain words**

- [ ] the ID card shows the tier line (checked by: Claude, not ticked: the raised ID card keeps its three lines, client, scope and token; the tier medal and line live on the agent card, the agent sheet and the whiteboard. Left as built on purpose: the card is a 1.2 s flash and its lines are the gateway's own words). Note for the checker: as built, the ID card a robot raises at a gate shows the client prefix, the scope and the token line (`idLines` in `src/reducer.js`); the tier medal and the tier line ("Gold badge · may speak for the company") are on the agent card and the agent sheet. Tick only if that is judged to satisfy the check; otherwise record the difference here.
- [x] the agent sheet never shows JSON unless the details are opened (checked by: Claude, builder C's c3/04 frame: sentences, chips, buttons, the JSON behind a closed details element)
- [x] the four buttons have their subtitles (checked by: Claude, every 1280x720 frame since 7:40 PM)
- [x] the help sheet reads in under a minute (checked by: Claude, the help frame: six lines and the keys)

**6. Recording and docs**

- [x] a fresh recording of the full story (section 1 of `docs/BUILD3.md`): `replay/demo3.json`, the Factory run on AWS (run 7; 56 rows, chain `chain-20261108T035444Z`; the island's chain check and the gateway's `verify_chain` both pass on it). It lives beside `replay/demo.json`, which stays the build-2 recording (checked by: run 7, `docs/LIVE_RUN.md`; the two chain checks re-run by Claude Saturday night)
- [x] docs refreshed to it (checked by: Claude, the build-3 docs refresh: README, EXPLAIN, QA, SECURITY_REVIEW, INTERFACES, DEMO_SCRIPT, VIDEO_SCRIPT, DEVPOST, SLIDES, slides.html, ISLAND_ACCEPTANCE, ISLAND_ANSWERS, island README and ASSETS; written, critiqued against the code (51 findings) and fixed)
