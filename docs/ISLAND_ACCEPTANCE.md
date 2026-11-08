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
