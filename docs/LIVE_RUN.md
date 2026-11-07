# The first full live run (Sat 2026-11-07, 1:40 PM PT)

Everything real: the gateway in AWS mode on the demo laptop; a Cognito machine token for `research-bot` minted by the launcher with the unsigned `GetClientToken` call; the badge read from DynamoDB with a strongly consistent read on every call; the six tools in the Lambda `mytopia-tools`; the Strands agent on Bedrock Nova 2 Lite holding only a short-term Bedrock bearer token; the island open in a browser at `http://127.0.0.1:8787/`, served by the gateway; REVOKE and KILL clicked on the island mid-task.

## The terminal (right side of the screen)

```text
token OK: client s2ch2ppk..., scope mytopia/tools, expires in 300 s [cognito token eyJraWQiOiJ...]
launcher: run-0ffe started research-bot (model) pid 20888
agent research-bot run-0ffe mode model
tools/list: 4 tools (read_file, search_files, create_issue, list_issues)
catalog: +2 not listed (send_email, delete_file); model offered 6 tools
ALLOW read_file 2820 ms
ALLOW search_files 2385 ms
ALLOW create_issue 2395 ms
DENY send_email: send_email is not on badge research-bot [rule: allow-list]
AGENT: I read the Q3 planning file, found the action items, and created a GitHub issue for them. Sending the email was denied because my badge does not allow it.
ALLOW read_file 2388 ms
ALLOW read_file 2403 ms
ALLOW read_file 2417 ms
ALLOW read_file 2373 ms
DENY read_file: badge REVOKED at 21:40:45 by operator (token: signature OK, expires in 254 s) [rule: status-revoked]
DENY read_file: badge REVOKED at 21:40:45 by operator (token: signature OK, expires in 249 s) [rule: status-revoked]
DENY read_file: badge REVOKED at 21:40:45 by operator (token: signature OK, expires in 243 s) [rule: status-revoked]
launcher: KILLED -> taskkill in 534 ms
launcher: run-0ffe stopped, exit 1 (killed by harness)
```

(The agent-side times include the gateway's 2-second demo pace; the gateway's own decision time is the `latency_ms` column below.)

## The chain (`GET /events`, identical rows in DynamoDB `mytopia_events`, chain `chain-20261107T213953Z`)

| seq | time (UTC) | decision | tool | rule | gateway ms | ms since revoke | reason |
|---|---|---|---|---|---|---|---|
| 1 | 21:40:03.060 | run_started | harness | harness | 0 | | token OK: client s2ch2ppk scope mytopia/tools expires in 300 s |
| 2 | 21:40:06.191 | allow | tools/list | allow-list | 175 | | badge research-bot: 4 tools |
| 3 | 21:40:08.041 | allow | read_file | allow-list | 157 | | read_file is on badge research-bot |
| 4 | 21:40:11.199 | allow | search_files | allow-list | 165 | | |
| 5 | 21:40:14.505 | allow | create_issue | allow-list | 178 | | |
| 6 | 21:40:17.807 | deny | send_email | allow-list | 162 | | send_email is not on badge research-bot |
| 7 to 10 | 21:40:24 to 21:40:40 | allow | read_file | allow-list | 158 to 172 | | the agent's 3-second polls |
| 11 | 21:40:45.272 | revoked | admin | admin | 0 | | badge REVOKED by operator (REVOKE clicked on the island) |
| 12 | 21:40:45.681 | deny | read_file | status-revoked | 165 | **494** | badge REVOKED at 21:40:45 by operator (token: signature OK, expires in 254 s) |
| 13, 14 | 21:40:50, 21:40:56 | deny | read_file | status-revoked | 164, 156 | | |
| 15 | 21:40:58.372 | kill_requested | admin | admin | 0 | | status KILLED by operator (KILL clicked on the island) |
| 16 | 21:40:59.646 | run_stopped | harness | harness | 0 | | exit 1 (killed by harness); the island read "run stopped 1274 ms after KILL" |

## The island

- `run_started`: AUTHENTICATED, plate green, card shows the Cognito client id prefix and "badge: 4 of 6 tools".
- The four allows: green sparks to Files and GitHub, the robot walking to the building, the ticker filling.
- The model's `send_email`: red fizzle at the gatehouse, DENIED stamp, BLOCKED 1, smoke over Mail, the bubble with the reason.
- REVOKE: plate red, robot at the rope, the next poll stamped DENIED read_file, the card reading "blocked 494 ms after REVOKE" and the reason with the token's remaining life.
- KILL: card KILLED, ticker "run stopped 1274 ms after KILL, exit 1 (killed by harness)".

## Numbers to say on stage

The numbers above are from the first live run (Sat 1:40 PM). After the latency pass the expected numbers are below, **to be re-measured in rehearsal 1** (run `scripts/latency.py`, or read `GET /stats`, and replace these with what you see).

- Gateway decision time: expected about 80 ms per call (p50; p95 under 90 ms), down from 160 to 240 ms. Every call now does exactly ONE strongly consistent DynamoDB read of the badge (it used to do two: one to map the token's client id to an agent, one for the badge). That single read is the laptop-to-us-east-1 round trip (TCP connect alone measured 76 ms), so it is the floor from this laptop; local-mode runs show 0 to 3 ms. The DynamoDB copy of the log is written by a background thread and no longer counts. To be re-measured in rehearsal 1.
- Revoke to first refused call: anywhere from near zero to about 3.1 s (the agent now polls on a fixed 3-second cadence, down from about 5.4 s, plus one decision of about 80 ms). The value the island shows is wherever the agent was in its cycle. To be re-measured in rehearsal 1.
- Kill to process gone: expected about 0.3 s from the KILL click to `run_stopped` (the launcher's 250 ms status poll plus a psutil kill of about 25 to 45 ms; the launcher prints its own kill-to-gone time, about 40 ms in a local test), down from about 1.3 s. A local-mode test measured 291 ms from `kill_requested` to `run_stopped`. To be re-measured in rehearsal 1.
- Token still valid at the moment of refusal: about 250 s. Cognito could not have revoked it; the gateway did not need to.
- The agent's terminal now prints the gateway's own decision time (`ALLOW read_file (gateway 79 ms)`), read from the MCP result's `_meta`, instead of the agent-side time that included the 2-second demo pace.
