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
