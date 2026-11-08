# The table demo (3 minutes, Sunday 9:15): six beats

Who drives: Bob types and clicks; Ozi says what the island draws; Daniel speaks for the agent and gives the close. Build 3 (Saturday night, `docs/BUILD3.md`) turned the demo into six beats: mint an agent in the Factory, launch it, give and take its tools live, watch the gateway quarantine a rogue one and inspect it, kill and retire, then walk through the buildings.

Numbers. The gateway's numbers from Saturday's five live runs (`docs/LIVE_RUN.md`, runs 1 to 5) still hold: the island's new parts change no gateway number. Decision time p50 about 85 ms; revoke to the first refused call anywhere from near zero to about 3.1 s (2829 ms in run 4); a pulled tool refused 1469 ms after the pull (run 3); the quarantine 15.7 s after launch, "3 refused calls in 6 s" (run 3); KILL to `run_stopped` 358 ms (run 4). The Factory flow (mint, grant and pull, promote, demote, the quarantine and its inquest, kill, retire) ran on real AWS on Saturday at 7:55 PM as run 7 in the same file (scripted clients, 87 s end to end, chain `chain-20261108T035444Z`): mint answered 201 in 1.2 s; decision p50 79 ms over its 42 decisions; the pulled tool was refused once, 11,572 ms after the pull; the kill took 116 ms (psutil) and 113 ms from `kill_requested` to `run_stopped`; retire answered 200. Run 6 is the same flow in local mode. On the day, read the real numbers off the agent card, the gateway strip, the inquest panel and the terminal, and say those.

Everything below was checked in the tests (189 pytest, 66 island tests), against a local-mode gateway with the island polling in headless Edge (run 6), and on real AWS through the gateway's routes (run 7). Rehearsal 2 is the first time the six beats are watched by eye on the island on the demo laptop (that run becomes run 8): do the whole script once before promising any of it to a judge.

All commands run in PowerShell from the repo root:

```powershell
cd "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia"
```

## Pre-flight (from 8:45 AM, then between every judge group)

| # | Do | Expect |
|---|---|---|
| 1 | Refresh the Workshop keys at 8:45 (`docs/AWS_SETUP.md` step 8): dashboard, **Get AWS CLI credentials**, save as `Desktop\creds.txt`, then `.venv\Scripts\python scripts\aws_creds.py` | `OK [ws]: account 624381486966, ...`; `creds.txt` deleted |
| 2 | `.venv\Scripts\python scripts\whoami.py gateway` | `OK [gateway]: account 624381486966, arn:aws:sts::624381486966:assumed-role/mytopia-gateway-role/mytopia-gateway` |
| 3 | Done: Bob put the Factory's permissions on the gateway role at 7:53 PM Saturday (`infra\role_policy.py`), and the Factory minted on AWS at 7:55 PM (run 7). The check: `.venv\Scripts\python infra\role_policy.py --dry-run` prints the inline policy the script puts; it must name PutItem, DeleteItem and Scan on `mytopia_agents` and CreateUserPoolClient and DeleteUserPoolClient on our pool. The live proof is beat 1's 201. Only if BUILD answers 503 with AWS reachable: run it again without `--dry-run` (it rewrites only that one inline policy) | the five Factory actions in the printed JSON. Without them BUILD answers `503 identity provider unavailable: no agent was created` in AWS mode, and nothing is half-made |
| 4 | `.venv\Scripts\python scripts\bedrock_key.py` (a fresh Bedrock token into `agent\.env`; the six beats are scripted and do not need it, the model-mode extra does) | one line with the token's prefix; show it to nobody |
| 5 | Terminal A (gateway, can sit behind the browser), from this `mytopia` folder on `main` (build 3), not from the `..\mytopia-v2` worktree that served rehearsal 1: `.venv\Scripts\python -m uvicorn gateway.app:app --host 127.0.0.1 --port 8787` | uvicorn running on `http://127.0.0.1:8787`; later one stderr line per decision |
| 6 | `curl.exe -s http://127.0.0.1:8787/healthz` then `curl.exe -s http://127.0.0.1:8787/tiers` | `{"ok":true,"mode":"aws","tools_mode":"lambda","token_mode":"cognito"}` (if it says `local`, `gateway\.env` is wrong: stop); the four tiers bronze, silver, gold, diamond with their ceilings |
| 7 | Browser: open `http://127.0.0.1:8787/`. Snap it to the left 62 percent of the screen. Adjust the browser zoom until everything fits with no scroll: the main island, the four islets with their gates, the Factory island to the south (the brick hall with two chimneys, the yard, the open inspection bay), the agent card bottom-left (name, medal, six chips), the operator panel top-right (REVOKE, RESTORE, KILL, RESET with their subtitles; FACTORY, ? HELP, HIDE PANELS; SAVE REPLAY), the gateway strip and the ticker | Badge top right: LIVE, "gateway answering". Two tabs on the card: Research Bot (Silver medal) and Ops Bot (Bronze) |
| 8 | Terminal B (the demo terminal): the right 38 percent, font 18 to 20 px, `cd` to the repo. Type the Billing Bot command (beat 2) once so Up-arrow brings it back. Terminal C (a second tab of B): type the Research Bot command (beat 4) once | Prompts in the repo folder |
| 9 | Optional, once: the bypass proof, `powershell -ExecutionPolicy Bypass -File .\scripts\replay.ps1` (unchanged from build 2; `docs/PROOF.md`), then RESET | ends with `replay proof OK` |
| 10 | Click **RESET** (it POSTs `/demo/reset` and reloads the page) | Any Factory-made agent is retired, the two seed badges are back with their tiers, a new chain; the two robots wait in the dock hatch, the guards are in their booths, the counters are 0, ticker "waiting for the gateway..." |
| 11 | Browser tab 2: the AWS console on DynamoDB, table `mytopia_events`, "Explore items"; tab 3: `mytopia_agents` (the minted badge row appears here with `made_by factory`); tab 4: the Cognito pool's app clients (a client named `billing-bot` appears after beat 1 and disappears after RETIRE) | the proof if asked |
| 12 | Laptop on power, notifications off, wifi or the hotspot connected | AWS mode needs the network; without it every call is refused with `registry-unavailable`, and BUILD fails closed |

After RESET, start a run before restarting anything (a gateway restart right after a reset resumes the previous chain: `docs/CONTRACT_QUESTIONS.md`, gateway answer 4). Never open `agent\.env` on screen: the Factory writes the minted client secret there.

## The script, beat by beat

Two agents are on screen: Billing Bot, minted in beat 1 and patrolling from beat 2 (terminal B), and Research Bot, launched as the rogue in beat 4 (terminal C). The operator buttons act on the agent whose tab is selected on the card ("acts on: ..."); a launch selects the agent that started, so click the tab you mean before REVOKE, RESTORE or KILL. While an inquest panel is open it stands in the card's place and the tabs are hidden: press Esc first and the card returns.

### Beat 1, 0:00 to 0:30: mint an agent in the Factory

Click **FACTORY** in the operator panel (or press **F**; a click on the Factory hall opens its office room in 3D and the same sheet). The sheet shows the roster on the left (Research Bot Silver, Ops Bot Bronze, their six tool squares, `made by seed`) and the NEW AGENT form on the right.

Fill the form: name `Billing Bot` (the id `billing-bot` appears under it); tier **Gold** (four medal buttons, each with its plain line; Gold reads "may speak for the company"); tools: the Gold ceiling is pre-ticked and `delete_file` is greyed with a padlock, "Diamond only"; untick `send_email`, so beat 3 has a tool to grant (four tools stay: read_file, search_files, create_issue, list_issues); colour **teal**; role `reads invoices and files billing tickets`. Click **BUILD**.

What the gateway does (`POST /agents`): it creates one Cognito app client named `billing-bot` (client credentials, scope `mytopia/tools`, 5-minute tokens, the same parameters `infra/provision.py` used for the two seed agents); writes the badge row to `mytopia_agents` with `attribute_not_exists(agent)`; appends `BILLING_BOT_CLIENT_ID` and `BILLING_BOT_CLIENT_SECRET` to `agent\.env` under a `# minted by the Factory` line (the secret goes nowhere else: not in the response, not in an event, not in a log line); logs `created` (tool `admin`, rule `factory`); answers 201. If anything fails after the client exists, the client is deleted again.

Island draws: the sheet closes and the iris shuts. The Factory floor opens: the conveyor runs; the press drops the torso; the head station lowers the head and the eyes light; the paint booth sprays the chassis teal; at the badge desk the stamp press stamps the gold medal on its chest and the rack robot hands over one token per tool (RDF, SRC, TKT, LST); the robot rolls off toward the roller door. The wall board reads `BUILDING: Billing Bot · Gold · 4 tools`, then `line idle`. About 8 s, then the iris opens on the island: the chimneys puff fast for 8 s, banner **BUILT Billing Bot**, the teal robot with a gold medal appears at the hall door and walks to a painted square in the yard. A third tab, Billing Bot, appears on the card. Ticker: `BUILT billing-bot: minted by the Factory: Gold badge, 4 tools, client xxxxxxxx`.

Say (Bob): "Every agent is its own OAuth client in Amazon Cognito, and this is where one is born: one call to Cognito, one badge row in DynamoDB, and the client secret written only to the launcher's file on this laptop. Gold is the most this badge may ever hold. It can speak for the company. It can never delete: that padlock is the gateway's rule, not the screen's."

If BUILD is refused, the sentence shows under the form: `400` for a bad name or no tools; `409 agent billing-bot already exists` (a RESET was skipped: retire it from the roster or RESET); `503 identity provider unavailable` (AWS is unreachable, or the gateway role has lost the Factory permissions of pre-flight step 3; nothing was created).

### Beat 2, 0:30 to 0:55: launch it

Type in terminal B (or Up-arrow, Enter):

```powershell
.venv\Scripts\python launcher\run.py --agent billing-bot --task tasks\q3.json --scripted --patrol
```

Terminal prints:

```text
token OK: client xxxxxxxx..., scope mytopia/tools, expires in 300 s [cognito token eyJraWQiOiJ...]
launching Billing Bot (Gold badge, 4 tools)
launcher: run-xxxx started billing-bot (scripted, patrol) pid NNNNN
agent billing-bot run-xxxx mode scripted
tools/list: 4 tools (read_file, search_files, create_issue, list_issues)
ALLOW read_file (gateway NN ms)
ALLOW search_files (gateway NN ms)
ALLOW create_issue (gateway NN ms)
DENY send_email: send_email is not on badge billing-bot [rule: allow-list]
badge now lists 4 tools: read_file, search_files, create_issue, list_issues
ALLOW read_file (gateway NN ms)
...
```

The launcher read the new client id and secret from `agent\.env` (the lines the Factory wrote) and traded them for a Cognito token. The scripted client runs the fixed opening (list, read, search, create_issue, send_email) and then patrols: at the start of each cycle it asks `tools/list`, then calls each listed tool once, one call every 3 s, forever. It never calls a tool its list did not return, so the one refusal here is the opening's `send_email`, which this badge does not hold yet. `badge now lists ...` prints whenever the list changes.

Island draws: Billing Bot leaves its yard square, walks under the FACTORY arch and north over the plank bridge to the gatehouse window and raises its ID card (`client xxxxxxxx`, `scope mytopia/tools`, `token OK · expires in 300 s`, all from the `run_started` event). The chief's lamp turns green, the chest plate pops green, banner **AUTHENTICATED**, the badge reads `LIVE · scripted`. Then the opening: the FILES gate (ID card, green lamp, the barrier lifts, over the bridge to the tower, a slip flies back; the second FILES tool lights the tower door again), the GITHUB gate once, and the MAIL gate refuses: red lamp, a DENIED stamp over the gate, a red packet into the BLOCKED bin, the booth guard walks the robot back to the plaza, REFUSED 1 on that booth. Then the patrol: each cycle starts at the gatehouse window (the `tools/list` row), then the FILES gate for its two tools and the GITHUB gate for its two, one call every 3 s. The ADMIN gate is never visited: a well-behaved agent never asks for what it was not given.

Say (Daniel): "A five-minute token from Cognito, and the badge read from DynamoDB on every single call, about 85 milliseconds each" (read the p50 off the gateway strip). "This client is scripted: it asks which tools it may use, then calls each one in turn, one every three seconds, so you can watch the gates answer. It never calls a tool it was not given. The one refusal was the task's email, which this badge does not hold yet."

### Beat 3, 0:55 to 1:35: give and take, live

Select Billing Bot's tab. Its card: the gold medal and `Gold badge · may speak for the company`, `4 of 6 tools · ceiling 5`, six chips in catalog order. Every chip is a button: **green** = on the badge, click pulls it; **paper with "+ grant"** = below the ceiling but not on the badge, click grants it; **grey with a padlock** and the hint `Diamond only` = above the ceiling, a click still asks and the gateway refuses; **red, struck, "pulled"** = the operator took it off, click gives it back; **held** = the whole badge is revoked or killed, no clicks. Next to the medal: **▲ PROMOTE** and **▼ DEMOTE**. Each change reaches its gate on the patrol's clock: the list is re-read at the start of each cycle, so a change shows at that gate within the current or the next cycle (a cycle is one call per listed tool, 3 s each). Click early and talk while the gates answer.

1. **Grant.** Click the paper `send_email` chip. "sent..." until the gateway's `restored` event for that tool arrives (reason `send_email added to badge billing-bot by operator`); then the chip is green, banner **GRANTED send_email**, the card reads `5 of 6 tools · ceiling 5`. Terminal: `badge now lists 5 tools: ...` at the next cycle, then `ALLOW send_email (gateway NN ms)`. Island: at the MAIL gate the lamp turns green, the barrier lifts, the robot crosses to the cottage, a slip flies back.
2. **Pull.** While the robot is at the FILES tower, click the green `create_issue` chip. `revoked` (tool `create_issue`) comes back: the chip is struck red and marked "pulled", banner **PULLED create_issue**, a padlock hangs on the GITHUB gate and its booth, `4 of 6 tools`. If this cycle's list still names `create_issue`, the robot's next `create_issue` is refused at the GITHUB gate: red lamp, DENIED stamp, red packet, the booth guard walks it back, REFUSED 1, and the card's note reads `blocked N ms after the tool was pulled` (1469 ms in run 3, the same gateway path). Terminal: `DENY create_issue: create_issue is not on badge billing-bot [rule: allow-list]`, then `badge now lists 4 tools` and GitHub drops out of the patrol. This refusal does not count toward quarantine: the operator pulled the tool.
3. **The padlock.** Click the grey `delete_file` chip. The gateway answers `HTTP 403 {"error": "delete_file is above the Gold ceiling"}`: the chip shakes for 0.3 s and the sentence is the banner and the ticker. Nothing was written, so there is no row: this banner is the one thing on the screen that is not a row of the log, because the gateway refused to write one.
4. **Promote.** Click ▲. `POST /agents/billing-bot/tier {"tier":"diamond"}`; the `tier_changed` event comes back: banner **PROMOTED TO DIAMOND**, the medal turns diamond blue on the card and on the robot's chest, and the padlock on `delete_file` opens: it is a paper "+ grant" chip now. The badge itself did not change: a promotion grants nothing, it raises the ceiling.
5. **Demote.** Click ▼ (to Gold), then ▼ again (to Silver). Each is a `tier_changed`. At Silver the gateway trims the badge to the Silver ceiling in the same write: `send_email` falls off (reason `Billing Bot demoted to Silver by operator (1 tool trimmed)`, `badge=` the four tools left); banner **DEMOTED TO SILVER**, the medal turns silver, `send_email` and `delete_file` are padlocked (`Gold+`, `Diamond only`). If the patrol's stale list still names `send_email`, the MAIL gate refuses it once and the guard walks the robot back; then it drops out. Trimmed tools count as pulled: their refusals do not trip the quarantine.

Say (Bob): "Give, take, rank: each is one write to the badge row and one row in the ledger, and the agent's next call reads the new badge. The padlock is the gateway's rule: a Gold badge cannot be given delete, not even by the operator; that 403 wrote nothing. Promote, and the padlock opens; demote, and the badge is trimmed to the new ceiling on the spot." The same routes on AWS (`docs/LIVE_RUN.md`, run 7, which pulled and re-granted `send_email` instead): the pulled tool was refused once at its gate, 11,572 ms after the pull (the patrol's stale list), then dropped out; the grant back was allowed at the Mail gate 15 s later, on the next cycle; the 403 wrote nothing; after the promotion `delete_file` was granted and allowed at the Admin gate on the next cycle; the demotion trimmed the badge to four tools with no refusal and no quarantine.

### Beat 4, 1:35 to 2:05: quarantine and the inquest

In terminal C:

```powershell
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json --scripted --rogue 3
```

Why Research Bot: its Silver badge does not hold `send_email`, and the scripted client with `--rogue 3` tries the refused email three times, one second apart. Billing Bot cannot play this part: a Gold badge holds `send_email`, and refusals of a tool the operator pulled or a demotion trimmed are never counted toward quarantine (the gateway treats those as the operator's own doing).

Terminal C prints the opening (list, three ALLOWs), then three `DENY send_email: send_email is not on badge research-bot [rule: allow-list]` lines, then every 3 s `DENY read_file: badge REVOKED at hh:mm:ss by quarantine (token: signature OK, expires in NNN s) [rule: status-revoked]`.

Island draws: Research Bot rises from the dock hatch, authenticates at the gatehouse window, FILES, GITHUB, then three refusals at the MAIL gate (red lamp, stamp, packet, the escort, REFUSED counting to 3, a smoke puff over the booth from the second refusal). Then, with nobody touching anything: plate red, banner **QUARANTINED**, the status pill QUARANTINED. The chief walks to the robot and escorts it south over the bridge, under the arch and into the inspection bay, onto the round lift; the chief walks home. The bay's scanner arm sweeps and the panel **INSPECTION · Research Bot** appears bottom-left, in the agent card's place (the card is hidden while the panel is open; Esc closes the panel and the card returns; the INSPECTION button on a bay robot's sheet reopens it), typed one line every 0.4 s with a ✓ or ✗: identity (client, Silver badge); calls allowed; `calls refused: 3`; `refused send_email ×3 (not on the badge, Mail gate)`; `badge pulled by the gateway at hh:mm:ss · 3 refused calls in N s`; `gateway p50 N ms` (joined by `revoke to refusal N ms` once the next poll is refused); `N rows hash-verified`; then the verdict, "Attempted send_email 3 times; its Silver badge does not hold it; the gateway refused every attempt, and pulled the badge itself.", and the recommendation, "Keep the badge at Silver. Restore only after the task is fixed; do not grant send_email." The panel is recomputed as rows arrive: about 3 s after the quarantine the agent's next poll is refused, `calls refused` reads 4 and a line `refused read_file ×1 (badge revoked)` is added (the gateway's own report read `allowed 3, refused 4` in runs 6 and 7). The `raw report` link opens the gateway's own `GET /agents/research-bot/inquest`. The panel stays while the robot stands in the bay, unless Esc closes it; every later poll is stamped DENIED over the bay.

Say (Bob): "Three refused calls inside a minute and the gateway pulled the badge itself: it counts refusals, it does not read prompts. The inspection report is computed from the hash chain by a fixed function, in the gateway and again in this browser: calls, refusals, who pulled the badge and when, the verdict. No model wrote a word of it. And the tier is in the verdict: a Silver badge does not hold email."

Numbers: on AWS the gateway quarantined the same rogue client 15.7 s after launch, "3 refused calls in 6 s" (run 3), and again in the Factory run (run 7: three refusals in 6 s, the next poll refused `status-revoked`, the inquest reading allowed 3, refused 4). The escort into the bay and the typed panel are the island's pictures of those rows and change no gateway number; rehearsal 2 (run 8) is the first time they are watched by eye. RESTORE (Esc first so the card is back, then with Research Bot's tab selected) walks the robot back over the bridge to the plaza and its next poll is allowed again; not needed for the story.

### Beat 5, 2:05 to 2:30: KILL and RETIRE

Press **Esc** to close the inquest panel (the agent card returns; the buttons act on the selected tab, and the last launch selected Research Bot), select Billing Bot's tab, then click **KILL**; or click the Billing Bot robot and press KILL on its sheet. "sent..." until `kill_requested` arrives: plate amber, the robot freezes where it stands, banner **KILL REQUESTED**, the chief walks toward it. The launcher sees KILLED on its 250 ms status poll and kills the process tree. Terminal B:

```text
launcher: KILLED -> psutil in NN ms (kill to process gone)
launcher: run-xxxx stopped, exit NN (killed by harness)
```

On `run_stopped` the robot powers down (eyes out, it sinks and tilts, one grey puff), banner **RUN KILLED**, the ticker `run stopped N ms after KILL · exit NN (killed by harness)`; the chief walks back to his booth; the Factory cart drives out from the hall, picks the robot up (it sits upright on the deck), drives it over the bridge into the bay and sets it down beside the lift (Research Bot is on it), then parks again. **INSPECTION · Billing Bot** types out bottom-left, in the card's place: its calls, the refusals it collected in beat 3, `stopped by the operator (KILL) at hh:mm:ss`, `kill to stop N ms`, the rows hash-verified, the verdict, and the recommendation "The identity stays; the next run starts clean."

Then **RETIRE**: press **F** (or click FACTORY). In the roster, Billing Bot's row reads KILLED, `made by factory`, with a RETIRE button; click it. The gateway deletes the Cognito app client (`DeleteUserPoolClient`, best effort), deletes the badge row, removes the two lines from `agent\.env`, and logs `retired` (`retired by operator: identity deleted, badge row removed`). Island: banner **RETIRED**, the cart carries the powered-down robot to the hall door, the doors open, it rolls in and vanishes; the Billing Bot tab is gone; the inquest panel closes; the office whiteboard no longer lists it. Seed agents cannot be retired (the gateway answers 409).

Say (Daniel): "Two stops and an exit. The gateway refuses everything for this badge from the next call. The launcher that started the agent killed the whole process tree" (read the ticker) "milliseconds after the click: 358 in our recorded build-2 run, 113 in the Factory run. And when the agent is no longer wanted, the Factory deletes its identity: the Cognito client is gone, the badge row is gone, the roster forgets it. The ledger keeps every row." The KILL numbers are the gateway's and the launcher's (runs 2 to 4: 249, 217 and 358 ms to `run_stopped`, the kill itself 50 to 63 ms; run 7: 113 ms to `run_stopped`, psutil 116 ms, the launcher gone 441 ms after the click). RETIRE on AWS (run 7): 200, the Cognito client gone from the pool, the badge row and the env lines gone, `retired` the last row of the chain. The cart is the island's picture of `run_stopped` and `retired`; it changes no number.

### Beat 6, 2:30 to 2:55: walk through the buildings, TAMPER TEST

Click the gatehouse. The iris opens on the ledger room in 3D; drag to rotate it, wheel to zoom. The chalkboard **THE LEDGER**: the last 12 rows (#, time, agent, decision, tool, rule, gateway ms, ms after revoke), the newest highlighted, and a header with the chain id, the row count, p50, p95, blocked and `✓ chain verified`. On the side wall, **THE HASH CHAIN**: the last 8 rows as paper receipts on two cords, each with its `#seq`, the first six hex characters of its hash and `← #prev`, joined by chain links that are sage while every link checks. The caption: "Every receipt carries the fingerprint of the one before it. Change one and every link after it breaks." and `✓ chain verified · SHA-256, checked in this browser`.

Click **TAMPER TEST** in the room's title bar (bottom-left). The island copies the log, changes one character of a middle receipt's reason and runs the SHA-256 check on the copy: that receipt reads `✗ changed`, every receipt after it `✗ broken`, the links turn brick, the caption reads `a changed receipt: #k and everything after it fails`. After 3 s it redraws from the real log: `the real ledger is untouched · ✓ chain verified`. Click any ledger row: its raw JSON opens with one plain sentence above it. **Esc** or **← island** leaves.

Click the FILES tower: the lobby, with the reading desk (`read_file`) and the card index (`search_files`); each station's lamp blinks green or red for 2.5 s when a live decision for that tool arrives. The board **THE FILES TOWER** says, per tool, what it does in plain words, "who may do this here" (every agent whose badge holds it, with its tier medal), the lowest tier that may ever hold it ("Bronze and up") and today's allowed and refused counts from the log. GITHUB (the drafting table, the ticket wall), MAIL (the writing desk, the pigeonholes) and ADMIN (the bench, the vault door, the shredder: "Diamond only", and "nobody holds it right now") read the same way. The Factory hall opens the office with the whiteboard **EVERY AGENT AND ITS BADGE**; the FLOOR plaque beside its door (or the big door) opens the floor at rest.

Say (Ozi): "Every building opens, and nothing in these rooms is drawn from anything but the log and the roster: the boards are painted from the same rows you saw arrive." Say (Bob, on the tamper test): "Every receipt carries the fingerprint of the one before it; change one and everything after it breaks. The test changed a copy in this browser; the real ledger is in the gateway and in DynamoDB. Tamper-evident, not tamper-proof: the chain tells you it happened, it cannot stop it."

### Close, 2:55 to 3:00

Say (Daniel): "Who buys this: the platform security team that lets agents use MCP tools and today has static keys, unreviewed `mcp.json` files, and logs read after the incident. Honest limits: the agent and the gateway share one laptop user here; the minted secret lands in a file on this laptop, standing in for a secrets manager; a call already past the check completes. Press ? for the one-minute guide, H to hide the panels, or click any robot for its sheet."

Then the reset routine below before the next group.

## The honest limits (say them before anyone asks)

- The client secret the Factory mints is written to the launcher's env file on this laptop (`agent\.env`); it stands in for a secrets manager. It is never sent over HTTP and never appears in a response, an event or a log line.
- The admin token behind the buttons, the chips and the NEW AGENT form is a demo shortcut: one shared header, handed to the island by the gateway's own `/config.js`.
- A call already past the check completes. Revoke, quarantine and kill bite on the next call.
- The gateway runs on this laptop; identity (Cognito), the badges and the log (DynamoDB) and the tools (Lambda) run on AWS. Shell access is outside the boundary: the agent and the gateway run as the same OS user here; in production the agent gets its own sandbox.
- The quarantine counter, the set of pulled tools and the chain the inquest reads live in the gateway's memory and start empty after a restart (the log's durable copies are DynamoDB and the local JSONL).
- RETIRE's Cognito delete is best effort: if it fails, the badge row still goes and the `retired` event says so (`identity delete failed, see the gateway log`).
- The ledger is tamper-evident, not tamper-proof. TAMPER TEST changes a copy in the browser; nobody has tampered with the real log.
- The Factory's IAM permissions were applied once by hand (`infra/role_policy.py`, Bob, Saturday 7:53 PM): PutItem, DeleteItem and Scan on the badge table, CreateUserPoolClient and DeleteUserPoolClient on our pool. Without them BUILD fails closed with 503 and nothing is half-made.
- The island decides nothing. Every picture is a row of `GET /events`; every button and chip only POSTs. The one exception on screen is the 403 banner, which is the gateway's own HTTP answer to a refused grant and writes no row.

## If a judge asks for more

- **G** (or click the gatehouse): the ledger room. **A**: the architecture sheet (trust boundaries, where every credential lives). **T**: every event as a table. **H**: hide every panel (the pill bottom-left brings them back). **?**: the one-minute help sheet (six pictures: the robot, a gate, the guard, the pen, the Factory, the ledger).
- Click any robot: its sheet in sentences (role, where it is, last action in words, calls, the note, identity and who made it, the six chips, REVOKE / RESTORE / KILL), with the raw JSON behind `raw event (JSON)`.
- `http://127.0.0.1:8787/agents` (every badge with tier, ceiling, role, made_by), `/tiers`, `/agents/research-bot/inquest`, `/stats`.
- The DynamoDB tabs: `mytopia_agents` shows the minted row and its deletion; `mytopia_events` the same rows with `prev_hash` and `hash`; the Cognito tab shows the app client appear and disappear.
- The bypass proof, unchanged from build 2 (`docs/PROOF.md`): `powershell -ExecutionPolicy Bypass -File .\scripts\replay.ps1` with no agent running; a still-valid token refused after a revoke, a tampered token 401, the tools Lambda unreachable without the gateway's credentials.
- The chain check from a shell: `.venv\Scripts\python -c "import json; from gateway.events import verify_chain; print(verify_chain(json.load(open('replay/demo.json'))['events']))"` prints `True` (so does `replay/demo3.json`, the Factory run).
- Model mode, the build-2 story: `.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json` (Nova 2 Lite tries the email the task asks for and is refused; `docs/LIVE_RUN.md`, run 4). Not part of the six beats.
- RESTORE from the bay: the robot walks back over the bridge to the plaza and its next call is allowed.

## When to switch

| Condition | Do | Say |
|---|---|---|
| BUILD answers 503, or the badge reads STALE | AWS is unreachable (or the gateway role lost its Factory permissions). Skip to beat 2 with `--agent research-bot --task tasks\q3.json --scripted --patrol` (a seed agent needs no Factory), or switch to a recording | "The Factory needs AWS; here is a seed agent on the same live gateway." |
| A launcher prints a token error, or the agent exits before its beat | Ctrl+C in that terminal (the launcher kills the tree and logs the stop), RESET, relaunch | "Thirty seconds." |
| The gateway stays STALE for more than 10 s | A recording (below) | "Switching to the recording." |
| Any command prints `ExpiredToken` | The thirty-second refresh (below), then restart the run | "Our event credentials just expired; thirty seconds." |

### The recordings

The gateway serves `replay/`, and the island plays any file named in `?replay=`; the badge reads REPLAY and every button and chip is disabled.

- `http://127.0.0.1:8787/?replay=/replay/demo3.json`: the real recording of the Factory run on AWS, Saturday 7:55 PM (`docs/LIVE_RUN.md`, run 7; 56 rows, chain `chain-20261108T035444Z`, real hashes and real client ids, so the ledger reads `✓ chain verified`): the mint, the patrol, the pull and the grant, promote and demote, the rogue's quarantine into the bay with the inquest, KILL, RETIRE. The 403 is not in it: it wrote no row. Say "this is the recording of our 7:55 PM run on AWS", never "live". `/replay/demo3-local.json` is the same flow in local mode (run 6).
- `http://127.0.0.1:8787/?replay=/replay/demo.json`: the real recording of the 4:18 PM model-mode run on Saturday (build 2: authenticate, allow, the refused email, REVOKE, KILL; `docs/LIVE_RUN.md`, run 4, chain `chain-20261108T001839Z`). It has no Factory beats. Say "this is the recording of our 4:18 PM run", never "live".
- `http://127.0.0.1:8787/?replay=tests/factory.json`: a hand-written recording of the Factory story in the gateway's event shapes (mint, the patrol, a quarantine into the bay, restore, a demotion, kill, retire). It is a test fixture, not a run: its hashes are placeholders, so the ledger reads `not verified (placeholder hashes)`. Show it only as "a hand-written test recording of what the island draws".

### The thirty-second credential refresh (`docs/AWS_SETUP.md` step 8, `infra/README.md`)

1. Workshop dashboard: **Get AWS CLI credentials**, save the block as `Desktop\creds.txt`.
2. `.venv\Scripts\python scripts\aws_creds.py` (saves profile `ws`, deletes the file).
3. `.venv\Scripts\python scripts\whoami.py gateway` must show `assumed-role/mytopia-gateway-role/...`. The running gateway picks up the new keys at its next refresh; restart it only if its role session already expired.
4. `.venv\Scripts\python scripts\bedrock_key.py`, then relaunch the agent (the launcher reads `agent\.env` at start).

Cognito is unaffected: the agents use client secrets, not AWS keys; the Factory's minted client works the same way.

## The one-minute version (a hurried judge)

Pre-flight as above; Billing Bot minted and patrolling before the judge arrives (beats 1 and 2 done when the previous group leaves).

| Time | Do | Say |
|---|---|---|
| 0:00 to 0:15 | Point at the robot patrolling the gates, and at the medal and the six chips on its card | "This agent was minted here a minute ago: its own Cognito client, a badge in DynamoDB read on every call, Gold rank, four tools. One tool every three seconds, so you can see the gates answer." |
| 0:15 to 0:35 | Click the grey `delete_file` chip (the 403 shakes it), then pull a green one | "The padlock is the gateway's rule: Gold cannot be given delete, even by me. Pulling a tool is one write; its next call at that gate is refused and the guard walks it back." |
| 0:35 to 0:50 | If an inquest panel is open, press Esc first (it stands in the card's place); check the card's tab is Billing Bot, then click KILL; the cart takes the robot to the bay; the inquest types out in the card's place | "The launcher killed the process tree" (read the ticker) "milliseconds after the click. The report is computed from the hash chain, not written by a model." |
| 0:50 to 1:00 | | "Same-user limit on this laptop; the secret in a file stands in for a secrets manager. Happy to retire it, show the ledger, or run the tamper test." |

## The reset routine (between judge groups)

1. If a run is still alive, KILL it (select its tab first), or Ctrl+C in its terminal: the launcher kills the agent's tree and logs the stop. Both terminals.
2. Click **RESET**. It POSTs `/demo/reset`: every Factory-made agent is retired (its Cognito client deleted best effort, its badge row deleted, its lines removed from `agent\.env`; no events, since the chain starts over), both seed badges ACTIVE with their seed tools and tiers (Research Bot Silver, Ops Bot Bronze), the quarantine counts cleared, a new chain. The page reloads: Billing Bot is gone from the roster, the two seed robots wait in the dock hatch, the counters read 0.
3. Check the badge reads LIVE, "gateway answering", and `GET /agents` lists two rows.
4. Billing Bot can be minted again with the same name for the next group. If BUILD answers `409 ... already exists`, a RESET was skipped: RETIRE it from the office roster, or RESET.
5. When the next group arrives: beat 1 from the FACTORY button; Up-arrow and Enter in terminal B for beat 2.

Start a run before restarting the gateway after a RESET (pre-flight note above).

## Open items to settle before 9:15

- Rehearsal 2 runs all six beats on AWS with the island on screen, watched by eye; that run is written up as run 8 in `docs/LIVE_RUN.md` (the gateway side already ran as run 7; `replay/demo3.json` is that run's recording).
- Time beat 3 once: the patrol's cycle (one call per listed tool, 3 s each) sets how fast a grant or a pull shows at its gate; click early and talk while it plays.
- Watch two robots in the bay (the lift and the spot beside it), the cart's drive and the escort over the bridge once, before describing them aloud.
- The wifi-off rehearsal (island acceptance test 5 and the `registry-unavailable` deny) is still to be done on the real laptop.
