# The table demo (3 minutes, Sunday 9:15)

Who drives: Bob types and clicks; whoever is explaining a beat says its sentence (Bob for the gateway beats, Ozi for what the island draws, teammate #3 for the agent and the close). The numbers quoted are from the first live run (`docs/LIVE_RUN.md`); on the day, read the real numbers off the island's card and the terminal and say those.

All commands run in PowerShell from the repo root:

```powershell
cd "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia"
```

## Pre-flight (from 8:45 AM, then between every judge group)

| # | Do | Expect |
|---|---|---|
| 1 | Refresh the Workshop keys at 8:45 (`docs/AWS_SETUP.md` step 8): dashboard, **Get AWS CLI credentials**, save as `Desktop\creds.txt`, then `.venv\Scripts\python scripts\aws_creds.py` | `OK [ws]: account 624381486966, ...`; `creds.txt` deleted |
| 2 | `.venv\Scripts\python scripts\whoami.py gateway` | `OK [gateway]: account 624381486966, arn:aws:sts::624381486966:assumed-role/mytopia-gateway-role/mytopia-gateway` |
| 3 | `.venv\Scripts\python scripts\bedrock_key.py` (a fresh Bedrock token into `agent\.env`) | one line with the token's prefix; do not show it to anyone |
| 4 | Terminal A (gateway, can sit behind the browser): `.venv\Scripts\python -m uvicorn gateway.app:app --host 127.0.0.1 --port 8787` | uvicorn running on `http://127.0.0.1:8787`; later one stderr line per decision |
| 5 | Any terminal: `curl.exe -s http://127.0.0.1:8787/healthz` | `{"ok":true,"mode":"aws","tools_mode":"lambda","token_mode":"cognito"}` (if it says `local`, `gateway\.env` is wrong: stop) |
| 6 | Browser: open `http://127.0.0.1:8787/`. Snap it to the left 62 percent of the screen (full-screen the page with F11 inside that half if the browser allows, else hide the bookmarks bar). Adjust browser zoom (Ctrl+minus / Ctrl+plus) until the whole island, the card, the ticker and the buttons (REVOKE, RESTORE, KILL, RESET, SAVE REPLAY) are visible with no scroll | Badge top right: LIVE, "gateway answering". Research Bot's tab highlighted |
| 7 | Terminal B (the demo terminal): the right 38 percent, font 18 to 20 px, `cd` to the repo. Type the launcher command once so Up-arrow brings it back | Prompt in the repo folder |
| 8 | Terminal C (a second tab of B): run the bypass proof once, `powershell -ExecutionPolicy Bypass -File .\scripts\replay.ps1`, then RESET (step 9) | ends with `replay proof OK`; the badge is ACTIVE again |
| 9 | Click the island's **RESET** button (it POSTs `/demo/reset` and reloads the page) | Both robots grey, ticker "waiting for the gateway...", a new chain |
| 10 | Browser tab 2: the AWS console on DynamoDB, table `mytopia_events`, "Explore items" (the proof if asked) | Rows of the current chain |
| 11 | Laptop on power, notifications off (Windows Focus), wifi or the hotspot connected | AWS mode needs the network; without it every call is refused with `registry-unavailable` |

After RESET, start a run before restarting anything (a gateway restart right after a reset resumes the previous chain: `docs/CONTRACT_QUESTIONS.md`, gateway answer 4).

## The script, second by second

Launch timing from the live run: the first `tools/list` came 3 s after `run_started`, the `send_email` deny 15 s after it, then a `read_file` poll about every 5.4 s (`docs/LIVE_RUN.md`, seq 1 to 10). The launcher itself needs a few seconds before `run_started` (token, Python, Strands); that part was not timed.

### Beat 1, 0:00 to 0:25: authenticate an agent

Type in terminal B (or Up-arrow, Enter):

```powershell
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json
```

Terminal prints:

```text
token OK: client s2ch2ppk..., scope mytopia/tools, expires in 300 s [cognito token eyJraWQiOiJ...]
launcher: run-xxxx started research-bot (model) pid NNNNN
agent research-bot run-xxxx mode model
tools/list: 4 tools (read_file, search_files, create_issue, list_issues)
catalog: +2 not listed (send_email, delete_file); model offered 6 tools
```

Island draws: banner AUTHENTICATED, Research Bot's chest plate turns green, the card shows `client s2ch2ppk` and "badge: 4 of 6 tools".

Say (Bob): "Companies are giving AI agents real access to tools. Here every agent is its own OAuth client in Amazon Cognito: the launcher just got a five-minute token for Research Bot, and the gateway checked it against Cognito's public keys. The gateway's tool list gave it four of the six tools on its badge."

### Beat 2, 0:25 to 1:05: allow selected MCP tools, and refuse the one it was not given

Terminal prints:

```text
ALLOW read_file 2820 ms
ALLOW search_files 2385 ms
ALLOW create_issue 2395 ms
DENY send_email: send_email is not on badge research-bot [rule: allow-list]
AGENT: I read the Q3 planning file, found the action items, and created a GitHub issue for them. Sending the email was denied because my badge does not allow it.
ALLOW read_file ...
```

(The agent-side milliseconds include the gateway's 2 s demo pace. The gateway's own decision time was 157 to 178 ms per call, nearly all of it the DynamoDB read from this laptop to us-east-1.)

Island draws: green sparks from the gatehouse to Files and GitHub, the robot walking to each building, the ticker filling. On `send_email`: a red fizzle at the gatehouse barrier, a DENIED stamp, BLOCKED 1, smoke over Mail, a speech bubble with the reason.

Say (teammate #3, while the allows draw): "The model is Nova 2 Lite on Bedrock. We gave it a stale tool catalog on purpose: it was offered all six tools, because real agents carry cached tool lists."

Say (Bob, on the deny): "Nova tried to send the email the task asked for. The list said four tools; the call for the fifth was refused at the gateway. Filtering the list is hygiene, the check on every call is the control. And no model decides this: it is one function, an allow-list and a status flag. About 160 to 180 milliseconds per decision, and that is a strongly consistent DynamoDB read on every single call."

### Beat 3, 1:05 to 1:40: revoke access mid-task

Wait for a fresh `ALLOW read_file` line, then click **REVOKE** on the island (or hand the mouse to a judge: "pull its badge").

Island draws: the button reads "sent..." until the gateway's `revoked` event comes back; then the plate turns red, banner REVOKED, the robot stops at the OFF LIMITS rope. On the next poll: DENIED read_file, and the card reads "blocked N ms after REVOKE" (494 ms in the first live run).

Terminal prints, on the next poll:

```text
DENY read_file: badge REVOKED at hh:mm:ss by operator (token: signature OK, expires in NNN s) [rule: status-revoked]
```

Say (Bob): "Read the card: blocked about half a second after the click. Now read the terminal: the token's signature is still OK and it has" (read the number; 254 in the first run) "seconds left. Cognito cannot revoke a machine access token, it says so in its documentation. It did not need to: the badge is read on every call. The token was still good and it didn't matter."

### Beat 4, 1:40 to 2:05: KILL


Click **KILL** on the island.

Terminal B prints:

```text
launcher: KILLED -> taskkill in NNN ms
launcher: run-xxxx stopped, exit 1 (killed by harness)
```

Island draws: card KILLED, the robot's plate dark, fire on the building of the last denial, the ticker "run stopped N ms after KILL, exit 1 (killed by harness)" (1274 ms in the first live run).

Say (teammate #3): "Two stops. The gateway refuses everything for this badge from the next call. And the launcher that started the agent polls its badge every second; it killed the whole process tree, about 1.3 seconds after the click. The fire is drawn only when the launcher reports the exit."

### Beat 5, 2:05 to 2:40: block subsequent requests (the bypass proof)

The agent is dead and its badge is KILLED. Now prove that a stolen token, a forged token and a direct call to the tools all fail, with nothing running in the background to confuse the picture.

Switch to terminal C and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\replay.ps1
```

(`-ExecutionPolicy Bypass` because this laptop's policy blocks `.ps1` files; it changes no setting, `docs/AWS_SETUP.md`.)

What the script does (read `scripts/replay.ps1` before the demo; it is self-contained and changes the badge): step 0 restores Research Bot to ACTIVE if it is not (it is KILLED after beat 4, so this also resets the badge for the next judge group); step 1 mints its own fresh Research Bot token with `GetClientToken` and makes one allowed `read_file`; step 2 revokes the badge; step 3 replays that same, still-valid token: `tools/call` refused with "badge REVOKED", `tools/list` empty; step 4 flips one character of the token's signature: HTTP 401 with `WWW-Authenticate`; step 5 is skipped; step 6 runs `aws lambda invoke mytopia-tools` from a child process whose environment was emptied (no AWS variables, empty config and credentials files): "Unable to locate credentials", and with `--profile gateway`: "could not be found"; step 7 restores the badge to ACTIVE. It ends with `replay proof OK`. Its output lines, in order:

```text
0 precondition -> research-bot was KILLED; restored to ACTIVE at seq NN
1 read_file    -> ALLOW with a fresh Cognito token eyJraWQi...: ...
2 revoke       -> status REVOKED at seq NN
3 same token   -> tools/call read_file: isError, DENIED: badge REVOKED at hh:mm:ss by operator (token: signature OK, expires in NNN s) [rule: status-revoked]
3 same token   -> tools/list: 0 tools
4 tampered     -> HTTP 401, WWW-Authenticate: Bearer error="invalid_token"; invalid_token: ...
5 expired      -> skipped (not needed: step 3 refused a token that had not expired)
6 no creds     -> aws lambda invoke mytopia-tools: exit 255, Unable to locate credentials. ...
6 no profile   -> aws lambda invoke --profile gateway: exit 255, The config profile (gateway) could not be found
7 restore      -> status ACTIVE at seq NN (read back from the registry: ACTIVE)
replay proof OK
```

(Formats taken from the script and from its recorded runs in `docs/PROOF.md`: `replay.ps1` ran at 21:49:31 UTC on Saturday, exit 0, in 13 s, with the badge idle, which is exactly its situation here: the agent is already dead, as `docs/PROOF.md` requires.)

Island draws: the plate goes green (restored), one green spark, red again (revoked), a fizzle for the replayed call and one for the empty list, a fizzle at the gatehouse for the tampered token, then green again (restored). The agent is gone, so nothing else moves; the badge ends ACTIVE, ready for the next group.

Say (Bob, one sentence per step as it prints): "This script starts the badge clean and takes its own token for Research Bot: allowed. Revoke. The same token, still valid: refused, and its tool list is empty. One character changed in the signature: HTTP 401. And from a shell with no AWS keys, like the agent's, invoking the tools' Lambda directly fails: of the processes here, only the gateway holds credentials that can. The script puts the badge back at the end: that was RESTORE, and the island is ready for the next group."

If `scripts\replay.ps1` fails, stop it (it restores the badge on failure), and use these lines instead (checked on this laptop on Saturday), in terminal C:

```powershell
$env:AWS_CONFIG_FILE="$PWD\launcher\empty.ini"; $env:AWS_SHARED_CREDENTIALS_FILE="$PWD\launcher\empty.ini"
$aws = "C:\Users\bobvu\AppData\Local\awscli-venv\Scripts\aws.cmd"
& $aws lambda invoke --region us-east-1 --function-name mytopia-tools out.json
& $aws lambda invoke --region us-east-1 --profile gateway --function-name mytopia-tools out.json
```

Expect `Unable to locate credentials.` and `The config profile (gateway) could not be found` (both exit 255; `out.json` is not written). (`aws` is not on PATH on this laptop, hence the full path; PowerShell also wraps the CLI's stderr in a red `NativeCommandError` block, which is expected.) This only works in a terminal with no other `AWS_*` variables set; close terminal C afterwards. Say: "This shell is set up like the agent's: no keys, no gateway profile."

### Close, 2:40 to 3:00

Say (teammate #3): "Who buys this: the platform security team that lets agents use MCP tools and today has static keys, unreviewed `mcp.json` files, and logs read after the incident. One honest limit: the agent and the gateway run as the same user on this laptop; in production the agent gets its own sandbox. Click any robot for the raw decision, or press T for the whole log."

Then click RESET before the next group (pre-flight step 9) and relaunch.

## If a judge asks for more

- **T**: the same stream as a table. Click a robot: its latest event as raw JSON.
- The DynamoDB tab: the same rows, with `prev_hash` and `hash`.
- The chain check (`docs/QA.md`, question 10): `.venv\Scripts\python -c "import json; from gateway.events import verify_chain; print(verify_chain(json.load(open('replay/demo.json'))['events']))"` prints `True`.
- RESTORE: the badge returns to ACTIVE and the next poll is allowed again (only before KILL; after KILL the agent process is gone).
- Ops Bot: `.venv\Scripts\python launcher\run.py --agent ops-bot --task tasks\q3.json` shows one tool in its list (the list is per identity). Not rehearsed; only if time allows.

## When to switch

| Condition | Do | Say |
|---|---|---|
| The launcher prints a Bedrock or model error (`AGENT ERROR: ...`), or no `DENY send_email` line 45 s after Enter | Ctrl+C in terminal B (the launcher kills the agent's tree and logs the stop), click RESET, run `.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json --scripted` | "The model is slow right now, so this is the scripted client: the same calls through the same live gateway, no model. The island's card says 'scripted client'." |
| The scripted run also fails, or the badge reads STALE for more than 10 s, or the launcher prints a token error, or the agent exits before REVOKE | Switch to the recording (below) | "Switching to the recording of our first live run." |
| Any command prints `ExpiredToken` | The thirty-second refresh (below), then restart the run | "Our event credentials just expired; thirty seconds." |

### The recording

The island's R key replays the file named in its `?replay=` parameter, or `island/fixture.json` (the contract's 21 synthetic example events) when there is none. The gateway serves the `replay/` folder itself, so the real recording (`replay/demo.json`, the 16 events of `docs/LIVE_RUN.md`) is one URL away, with no second server:

```text
http://127.0.0.1:8787/?replay=/replay/demo.json
```

Keep it in a bookmark; opening it starts playback. The recording plays one event every 1.5 s, the badge reads REPLAY with "recorded 2026-11-07", and the four control buttons are disabled (SAVE REPLAY stays on; it only downloads a file). The card still shows the recorded numbers (blocked 494 ms after REVOKE, run stopped 1274 ms after KILL), because they come from the events. Never call it live: say "this is the recording of our 1:40 PM run".

### The thirty-second credential refresh (`docs/AWS_SETUP.md` step 8, `infra/README.md`)

1. Workshop dashboard: **Get AWS CLI credentials**, save the block as `Desktop\creds.txt`.
2. `.venv\Scripts\python scripts\aws_creds.py` (saves profile `ws`, deletes the file).
3. `.venv\Scripts\python scripts\whoami.py gateway` must show `assumed-role/mytopia-gateway-role/...`. The running gateway picks up the new keys at its next refresh; restart it only if its role session already expired.
4. `.venv\Scripts\python scripts\bedrock_key.py`, then relaunch the agent (the launcher reads `agent\.env` at start).

Cognito is unaffected: the agents use client secrets, not AWS keys.

## The one-minute version (a hurried judge)

Pre-flight as above; the agent already running and past its `send_email` deny before the judge arrives (launch it when the previous group leaves).

| Time | Do | Say |
|---|---|---|
| 0:00 to 0:15 | Point at the red fizzle and BLOCKED 1 on Mail, and the `DENY send_email` line | "This agent is its own Cognito client. Its badge allows four tools; it just tried to send email, and the gateway refused it at the call, not just in the list." |
| 0:15 to 0:35 | Click REVOKE; wait for the next DENY | "I pulled its badge. Refused" (read the card) "milliseconds later, while its token still has" (read the terminal) "seconds to live. Cognito cannot revoke that token; we read the badge on every call." |
| 0:35 to 0:50 | Click KILL | "And the launcher killed the process tree in about 1.3 seconds. Every pixel is a row in a hash-chained log." |
| 0:50 to 1:00 | | "Same-user limit on this laptop; production gets a sandbox. Happy to show the bypass test or the log." |

If the run was already killed by the previous group: RESET, relaunch, and give the version above from the `send_email` deny (15 s after `run_started` in the live run, `docs/LIVE_RUN.md`; the launch time before `run_started` was not measured, so allow an estimated 20 to 30 s after Enter).

## Open items to settle before 9:15

- Rehearse the 45-second switch rule once: the first live run reached the `send_email` deny 15 s after `run_started`.
- Time beat 5 once in rehearsal (13 s with the badge idle on Saturday; it is budgeted 35 s).
- The wifi-off rehearsal (island acceptance test 5 and the `registry-unavailable` deny) is still to be done on the real laptop: turn the radio off during a run, watch the next call refuse with rule `registry-unavailable`, turn it back on.
