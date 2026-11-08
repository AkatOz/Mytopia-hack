# MYTOPIA

MYTOPIA is identity and access management for AI agents, drawn as an island. Each agent has its own Amazon Cognito identity and a badge listing the tools it may use. Each tool is a building on its own islet, reached over one bridge with a gate and a guard. An MCP gateway checks the badge on every call. When an operator pulls the badge mid-task, the agent's next call is refused at the gate, on the island and in the terminal, even though the agent's token is still valid.

AWS x A10 Hack 2026, Santa Clara University ACM. **A10 track, Prompt 1: Agentic Identity.** Built Saturday 2026-11-07 during the event (see "Built versus used" below).

## What you will see

All numbers below come from the model-mode live run on AWS, Sat 2026-11-07 at 4:18 PM PT, on the gateway after its latency work: the fourth run in [docs/LIVE_RUN.md](docs/LIVE_RUN.md), recorded as `replay/demo.json` (chain `chain-20261108T001839Z`, 15 events). The first live run (1:40 PM, before the latency work) is kept as `replay/demo-first-run.json`; its numbers are in LIVE_RUN.md for comparison. Build 3 (Saturday night) added the Factory, described in its own section below; the gateway's decision path and its numbers did not change. The Factory flow ran live twice on Saturday night: run 6 in LIVE_RUN.md in local mode and run 7 on real AWS (chain `chain-20261108T035444Z`, recorded as `replay/demo3.json`). The Factory section quotes run 7.

1. **Authenticate.** The launcher gets a 5-minute Cognito machine token for `research-bot` (`token OK: client s2ch2ppk..., scope mytopia/tools, expires in 300 s`). On the island the robot rises from the dock and shows its ID card at the gatehouse window (the card shows the real client prefix, the scope and the token's expiry). Its chest plate turns green and the banner reads AUTHENTICATED.
2. **Allow selected tools.** `tools/list` returns the 4 tools on the badge. `read_file`, `search_files` and `create_issue` are allowed. For each one the robot walks to that islet's gate and shows its ID, the booth lamp turns green, the barrier lifts, the robot crosses the bridge to the door, and a paper slip flies back to the gatehouse (the log entry). The terminal prints the gateway's own time, for example `ALLOW read_file (gateway 89 ms)`. Gateway decision time: p50 87 ms on allows (one 271 ms outlier on the first read after a reset).
3. **Block a disallowed action.** The model (Nova 2 Lite) tries `send_email`. The answer is `DENY send_email: send_email is not on badge research-bot [rule: allow-list]`. At the Mail gate the booth lamp turns red, a DENIED stamp appears over the gate, a red packet drops into the BLOCKED bin, and the booth guard escorts the robot back to the plaza. Deny decisions: p50 83 ms.
4. **Revoke mid-task.** The operator pulls the badge with REVOKE (on stage, a button on the island; the log records it as `badge REVOKED by operator`). The plate turns red and the chief guard escorts the robot into the OFF LIMITS pen. The agent's next call came **2829 ms** later and was refused, while its token still had **269 s** left: `badge REVOKED at 00:19:04 by operator (token: signature OK, expires in 269 s)`. That gap is wherever the agent was in its 3-second poll, so it can be anywhere from near zero to about 3.1 s (494 ms in the first run). The island's card reads "blocked 2829 ms after REVOKE".
5. **Block what follows and stop the run.** Every later call is refused, and the robot shows its ID from inside the pen. KILL flips the badge to KILLED: the plate turns amber and the robot freezes. The launcher kills the agent's process tree with psutil (63 ms), the robot powers down, and the island reads `run stopped 358 ms after KILL` with the reason `exit 15 (killed by harness)`.

Also measured on real AWS, in the third live run (4:16 PM): **per-tool revoke** takes one tool, such as `read_file`, off a badge and leaves the rest working; the agent's next call of that tool was refused 1469 ms after the pull. **Auto-quarantine**: after 3 refused calls inside 60 s the gateway pulls the badge itself; with `launcher\run.py --scripted --rogue 3` it did so 15.7 s after launch, with the reason `badge pulled by quarantine after 3 refused calls in 6 s`. On the island, click a green tool chip on the agent card to pull that tool (a padlock appears under that islet's gate sign) and click the red "pulled" chip to put it back; a quarantine is drawn under the banner QUARANTINED (since build 3 the chief escorts the robot into the Factory's inspection bay, not the pen).

## The required flow and where each step is met

Prompt 1 asks for four steps. We add two more, a blocked disallowed action and a hard stop, labelled "borrowed" below. The "proof" column quotes the 4:18 PM model-mode run: the terminal lines are in [docs/LIVE_RUN.md](docs/LIVE_RUN.md), and the seq numbers are the rows of `replay/demo.json`.

| Step | Component | File and function | Proof in LIVE_RUN.md |
|---|---|---|---|
| 1. Authenticate an agent | Launcher mints a Cognito client-credentials token. Gateway verifies it offline against the pool's JWKS. | `launcher/run.py` `mint_token`; `gateway/tokens.py` `CognitoVerifier.verify`, `check_claims` | terminal `token OK: client s2ch2ppk..., scope mytopia/tools, expires in 300 s`; chain seq 1 `run_started` |
| 2. Allow selected MCP tools | Gateway filters `tools/list` by the badge and checks every `tools/call` against the badge | `gateway/mcp.py` `McpHandler._tools_list`, `_tools_call`; `gateway/decide.py` `decide` | terminal `tools/list: 4 tools (read_file, search_files, create_issue, list_issues)`, `ALLOW read_file (gateway 89 ms)`; seq 2 to 5 `allow` |
| Borrowed: block a disallowed action | Same `decide`, rule `allow-list`. The model was offered `send_email` from a stale local catalog. | `gateway/decide.py` `decide`; `agent/main.py` `catalog_tools` | seq 6 `deny send_email ... allow-list`, 82 ms |
| 3. Revoke access mid-task | Island button POSTs to the gateway, which runs DynamoDB `UpdateItem` on the badge row (`status=REVOKED`) | `island/src/main.js` `press`; `gateway/app.py` `admin_action`; `gateway/registry.py` `DynamoRegistry.set_status` | seq 10 `revoked`, `badge REVOKED by operator` |
| 4. Block subsequent requests | Every call does a strongly consistent badge read, then `decide` returns `status-revoked` | `gateway/registry.py` `DynamoRegistry.get` (`ConsistentRead=True`); `gateway/decide.py` `decide` | seq 11 `deny read_file status-revoked`, **2829** ms since revoke, `expires in 269 s`; seq 12, 13 |
| Borrowed: stop the run | KILL sets `status=KILLED` (soft stop at the gateway). The launcher sees it within one 250 ms status poll and kills the process tree with psutil (hard stop). | `gateway/app.py` `admin_action`; `launcher/run.py` `own_run`, `kill_tree` | seq 14 `kill_requested`, seq 15 `run_stopped exit 15 (killed by harness)` 358 ms later; psutil kill 63 ms (terminal `launcher: KILLED -> psutil in N ms (kill to process gone)`) |

## Build 3: the Factory

Build 3 (Saturday night, commit a446d49; the spec is [docs/BUILD3.md](docs/BUILD3.md)) made MYTOPIA the place where a company manages its agents' identities from start to end: mint an agent, rank it, give and take tools, stop it, inspect it, retire it. The gateway's decision path did not change: every call still reads one badge row with a strongly consistent read and runs `decide()`, so the numbers in [docs/LIVE_RUN.md](docs/LIVE_RUN.md) runs 1 to 5 still hold. The Factory flow's own live runs are run 6 (local mode, no AWS) and run 7 (real AWS: Cognito, DynamoDB, Lambda; chain `chain-20261108T035444Z`, 56 rows, recorded as `replay/demo3.json`), both with scripted clients. The numbers in this section are run 7's.

**Tiers.** A tier is the most a badge may ever hold: a ceiling of tools by rank. The table lives in `gateway/tiers.py`; the island carries the same table (`island/src/tiers.js`) and reads it from `GET /tiers` when the gateway is up.

| Tier | Rank | Ceiling (the most a badge of this tier may hold) | In plain words |
|---|---|---|---|
| Bronze | 1 | `read_file`, `search_files` | looks, never changes anything |
| Silver | 2 | + `create_issue`, `list_issues` | reads and files tickets |
| Gold | 3 | + `send_email` | may speak for the company |
| Diamond | 4 | + `delete_file` | may delete: the only tier that can |

Research Bot is Silver (its four tools are the Silver ceiling) and Ops Bot is Bronze. A badge's tools are always a subset of its tier's ceiling. The ceiling binds the operator too: a grant above it is refused with HTTP 403 and no event, a mint with a tool above it is refused with 400, and a demotion trims the badge to the new ceiling in the same write. A Bronze badge can never hold `delete_file`, whoever asks.

**The lifecycle routes.** Every admin route needs `X-Admin-Token` (the two GETs need none); the exact shapes are in [contract/README.md](contract/README.md).

| Step | Route | What the gateway does | Logged as |
|---|---|---|---|
| mint | `POST /agents` `{agent, name, tier, tools, color, role}` | checks the form (id `^[a-z][a-z0-9-]{2,23}$`, name 1 to 24 characters, a known tier, tools inside its ceiling, one of six colours, a role of at most 60 characters); creates a Cognito app client with the same parameters provisioning uses (`CreateUserPoolClient`: client credentials, scope `mytopia/tools`, 5-minute tokens; in local token mode the id `local-<agent>` and no secret); writes the badge row with `PutItem if attribute_not_exists(agent)`; appends the client id and secret to the launcher's env file under a `# minted by the Factory` line; answers 201 with the row and the event. The secret is in no response, event or log line. Any failure after the identity exists deletes it again: 409 for a duplicate, 400 for bad input, 503 when Cognito, DynamoDB or the file fails, and nothing is left half-made | `created`, tool `admin`, rule `factory`, `tier=gold tools=... color=teal`, reason `minted by the Factory: Gold badge, 5 tools, client <8 chars>` |
| grant or pull one tool | `POST /agents/{id}/tools/{tool}/restore`, `/revoke` | `restore` now also grants a tool that was never on the badge, when the tier's ceiling holds it. Above the ceiling it answers HTTP 403 `{"error": "delete_file is above the Gold ceiling", "tier": "gold", "ceiling": [...]}` and logs nothing | `restored` / `revoked`, tool = the tool's name, `badge=<the tools now on the badge>`; a first-time grant's reason reads `added to badge` |
| promote or demote | `POST /agents/{id}/tier` `{"tier": "silver"}` | one write of tier and tools together. A demotion trims the badge to the new ceiling; the trimmed tools count as pulled by the operator, so their refusals never trip the quarantine. A promotion adds no tool: the badge stays, the ceiling grows. The same tier changes nothing and logs nothing | `tier_changed`, `tier=silver was=gold badge=<tools left>`, reason `Billing Bot demoted to Silver by operator (1 tool trimmed)` or `promoted to Diamond by operator` |
| inspect | `GET /agents/{id}/inquest` (no token) | the report of the agent's latest run, computed from that agent's rows in the chain in memory: calls allowed and refused, refused tools by rule and gate, the trigger (quarantine by the gateway, or REVOKE or KILL by the operator), the timings the chain holds, whether the chain verifies, a verdict and a recommendation. It is deterministic: no model writes it, and the same rows always give the same report | nothing: it is a read |
| retire | `POST /agents/{id}/retire` | Factory-made agents only (a seed agent answers 409). Deletes the Cognito client (best effort: the row goes either way and the reason says if the delete failed), deletes the badge row, forgets the agent in the gateway's memory, removes its two env lines. The ledger rows stay, and the inquest still answers from them. A retired agent's token is refused, because no row names its client | `retired`, `made_by=factory client=<8 chars>` |
| reset | `POST /demo/reset` | retires every Factory-made agent first (identities deleted best effort, no events: the chain is about to start over), then puts the two seed badges back ACTIVE with their seed tools and tiers, then starts a new chain. The island sees the new chain id and forgets the retired robots | (the chain starts again) |

One-line examples (bash; on Windows PowerShell write `curl.exe`; `$ADMIN` is the `ADMIN_TOKEN` of `gateway/.env`):

```bash
curl -s -X POST http://127.0.0.1:8787/agents -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" -d '{"agent":"billing-bot","name":"Billing Bot","tier":"gold","tools":["read_file","search_files","create_issue","list_issues","send_email"],"color":"teal","role":"reads invoices and emails customers"}'
curl -s -X POST http://127.0.0.1:8787/agents/billing-bot/tools/send_email/revoke -H "X-Admin-Token: $ADMIN"       # pull one tool
curl -s -X POST http://127.0.0.1:8787/agents/billing-bot/tools/send_email/restore -H "X-Admin-Token: $ADMIN"      # give it back, or grant it
curl -s -X POST http://127.0.0.1:8787/agents/billing-bot/tools/delete_file/restore -H "X-Admin-Token: $ADMIN"     # 403: delete_file is above the Gold ceiling
curl -s -X POST http://127.0.0.1:8787/agents/billing-bot/tier -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" -d '{"tier":"silver"}'
curl -s http://127.0.0.1:8787/agents/billing-bot/inquest
curl -s -X POST http://127.0.0.1:8787/agents/billing-bot/retire -H "X-Admin-Token: $ADMIN"
```

**The one-time IAM step.** The gateway role needs five more actions for the Factory: `dynamodb:PutItem`, `DeleteItem` and `Scan` on the agents table, and `cognito-idp:CreateUserPoolClient` and `DeleteUserPoolClient` on the one pool. Why: a mint writes a row and an identity, a retire deletes both, and `GET /agents` now lists every badge with one strongly consistent Scan, because the roster is no longer two fixed names. `infra/provision.py` writes this policy for a fresh setup. For a role provisioned before build 3, `.venv\Scripts\python infra\role_policy.py` puts the inline policy and nothing else (`--dry-run` prints it without calling AWS). Until it has run, `GET /agents` falls back to the two seed rows and a mint answers 503. The events table keeps `PutItem` and `Query` only, so the log's rules are unchanged.

**The launcher and a well-behaved patrol.** `launcher\run.py --agent billing-bot --task tasks\q3.json --scripted --patrol`. The launcher reads the new agent's client id and secret from the lines the Factory wrote, prints `launching Billing Bot (Gold badge, 5 tools)` from `GET /agents`, and passes the name to the agent. `--patrol` sets one variable, `AGENT_PATROL=1`, and nothing else. With it, after its opening calls, the scripted agent asks `tools/list` each cycle and calls each listed tool once with harmless arguments, one call every 3 s. It never calls a tool the list did not return. So a grant reaches its gate within one cycle; a tool pulled mid-cycle is refused at most once (the list was taken before the pull) and then drops out; refusals never pile up toward quarantine on their own. That is what a well-behaved agent looks like. `--rogue 3` stays the misbehaving one: it retries a refused `send_email`, so it quarantines a badge that lacks `send_email` (Research Bot, or a Bronze or Silver agent), not a Gold one.

**Measured on real AWS (run 7 in [docs/LIVE_RUN.md](docs/LIVE_RUN.md), scripted clients).** `POST /agents` answered 201 in 1.2 s: one Cognito `CreateUserPoolClient` and one DynamoDB write; `run_started` came 1.5 s after the mint. A grant of `delete_file` to the Gold badge answered 403 and logged nothing. After `send_email` was pulled, the patrol's stale list tried it once: refused at the Mail gate 11,572 ms after the pull (`ms_since_revoke` on seq 14), then gone from its list. Granted back, it was allowed at the Mail gate on the next cycle, 15 s later. Promoted to Diamond and granted `delete_file`, the patrol was allowed at the Admin gate on the next cycle; demoted to Silver, its next `tools/list` said `4 of 6 tools visible` and it never called the trimmed tools. `research-bot --scripted --rogue 3` beside it was quarantined after three refused `send_email` calls in 6 s. The gateway's own decision time over the run's 42 decisions: p50 79 ms, p95 110 ms, so the Factory rows in the chain did not move it (p50 81 to 87 ms in runs 2 to 4). KILL: the launcher's psutil kill 116 ms; `kill_requested` to `run_stopped` 113 ms for Billing Bot (354 ms for Research Bot, killed first). Retire answered 200: the Cognito client deleted, the row and the env lines gone, `retired` at seq 56.

**On the island.** The Factory island lies to the south over a bridge with no gate: it is the operator's own ground. A mint from the browser irises into the Factory floor, where the line builds the robot (press, head, paint, the tier medal stamped on the chest, one token per tool) and it rolls out to the yard; a run started from the yard walks over the bridge to the gatehouse window and shows its ID card there; the tier shows as a medal on the robot's chest and on its agent card. Every chip on the agent card is a button: a green one pulls the tool, a paper one grants it, a padlocked one is above the tier and shows the gateway's 403 sentence as a banner when clicked. PROMOTE and DEMOTE sit next to the tier medal. A quarantine or a KILL now ends in the inspection bay, not the pen: the chief escorts a quarantined robot there, the Factory cart collects a killed one, and the inquest is typed out line by line in a panel bottom-left, in the agent card's place (the card is hidden while the panel is open; Esc closes the panel and brings the card back; the bay's scanner arm sweeps meanwhile); the operator's own REVOKE still uses the pen, and the guard walks home after every escort. RETIRE (in the Factory office) sends the robot into the Factory, walking, or on the cart when it is powered down, and the roster forgets it. Every building opens into a 3D room that rotates with the mouse; the gatehouse holds THE LEDGER on a chalkboard, the HASH CHAIN as receipts linked by chain links, and a TAMPER TEST button that changes one character of one copied receipt in the browser, shows every link after it break, and then says the real ledger is untouched. New keys: **H** hides every panel (a small pill brings them back), **F** opens the Factory office, **?** the help sheet; **G**, **T**, **A**, **R** and **Esc** stay. As before, every picture is a row of `GET /events` and every button only POSTs.

## Architecture

```text
 OPERATOR ZONE: the demo laptop                          |  AGENT ZONE: one child process
                                                         |
  Browser: the island at http://127.0.0.1:8787/          |   agent/main.py  (Strands Agents, Nova 2 Lite)
    |  GET /events?since_seq=N (every 300 ms)            |     holds: the current 5-min Cognito access
    |  POST /agents/{id}/revoke|restore|kill, /demo/reset|            token (re-read from a file per
    |  POST /agents/{id}/tools/{tool}/revoke|restore     |            request), a Bedrock bearer token
    |  POST /agents (mint), /agents/{id}/tier, /retire   |
    |       (X-Admin-Token)                              |
    |  GET /agents (on load and after each badge event), |
    |      /tiers, /agents/{id}/inquest                  |
    v                                                    |     never: Cognito client secret, AWS access
  GATEWAY  gateway/app.py  (uvicorn on 127.0.0.1:8787) <-|------    keys, admin token
    holds: the narrow IAM role's 1-hour session          |     POST /mcp  JSON-RPC tools/list, tools/call
           (via credential_process), the admin token     |          Authorization: Bearer <token>
    ^                                                    |
    |  POST /runs/{id}/started|stopped,                  |
    |  GET /agents/{id}/status (every 250 ms)            |
  LAUNCHER launcher/run.py  -- spawns with a scrubbed environment, rewrites the token file
    holds: Cognito client secret, admin token  every 240 s, psutil kill of the tree on KILLED --> agent
=====================================================================================================
 AWS us-east-1 (event account)
  Cognito pool "mytopia" <-- GetClientToken (unsigned call: client id + secret) ------- launcher
                         --- JWKS public keys (cached by the gateway) ---------------> gateway
                         <-- CreateUserPoolClient / DeleteUserPoolClient (the Factory) --- gateway
  STS AssumeRole mytopia-gateway-role (1 h) <-- infra/gateway_creds.py, from profile ws (session keys)
  DynamoDB mytopia_agents <-- gateway: GetItem with ConsistentRead, UpdateItem (the buttons),
                              PutItem if attribute_not_exists(agent), DeleteItem, Scan (the Factory)
  DynamoDB mytopia_events <-- gateway: PutItem if attribute_not_exists(seq), Query
  Lambda mytopia-tools    <-- gateway: Invoke {"tool": name, "arguments": {...}}
  CloudWatch Logs         <-- the Lambda's own execution role (its logs only)
  Bedrock Nova 2 Lite (us.amazon.nova-2-lite-v1:0) <-- agent: model calls with the bearer token
```

What each arrow carries:
- The island sends GETs and admin POSTs to the gateway and nothing else: the four buttons (revoke, restore, kill and `/demo/reset`), the six tool chips (per-tool revoke, restore and, since build 3, grant) and the Factory's buttons (BUILD is `POST /agents`, PROMOTE and DEMOTE are `POST /agents/{id}/tier`, RETIRE is `POST /agents/{id}/retire`). It never calls AWS and draws only events it reads from `GET /events`.
- The agent can reach two things: the gateway's `/mcp`, and Bedrock's model endpoint. The six tools run in a Lambda that only the gateway's role may invoke.
- The launcher talks to Cognito (to mint tokens) and to the gateway's control API (to report runs and read the badge status). It is the agent's parent process.

The operator API (`X-Admin-Token` required; the full contract is in [contract/README.md](contract/README.md)):

| Route | What it does | Logged as |
|---|---|---|
| `POST /agents/{id}/revoke`, `/restore`, `/kill` | sets the whole badge REVOKED, ACTIVE or KILLED (`set_status`) | `revoked` / `restored` / `kill_requested`, tool `admin` |
| `POST /agents/{id}/tools/{tool}/revoke` | takes one of the six tools off the badge (`set_tools`); the rest keeps working. 200 with `changed: false` if it was already off | `revoked`, tool = the tool's name, `args_summary` `badge=<tools left>` |
| `POST /agents/{id}/tools/{tool}/restore` | puts the tool back on the badge, or (since build 3) grants a tool that was never on it, when the tier's ceiling holds it. 200 with `changed: false` if it was already on; 403 and no event above the ceiling | `restored`, tool = the tool's name |
| `POST /agents` | build 3: mints an agent (a Cognito app client, a badge row, the launcher's env lines); see "Build 3: the Factory" | `created`, tool `admin`, rule `factory` |
| `POST /agents/{id}/tier` | build 3: promotes or demotes; a demotion trims the badge to the new ceiling | `tier_changed` |
| `POST /agents/{id}/retire` | build 3: Factory-made agents only; deletes the identity (best effort) and the row; the ledger rows stay | `retired` |
| `POST /demo/reset` | every Factory-made agent retired (no events), both seed badges ACTIVE with their seed tools and tiers, new chain | (the chain starts again) |
| (no route: the gateway itself) | auto-quarantine: 3 `allow-list` refusals in 60 s set the badge REVOKED by `quarantine` (`QUARANTINE_AFTER`, `QUARANTINE_WINDOW_S`). The write is conditional on the badge still being ACTIVE, so it never overwrites a KILL. Refusals of a tool the operator pulled do not count | `revoked`, tool `admin`, `quarantine: 3 refused calls in 6 s` |

`GET /stats` needs no token and is served from memory with no AWS call: the chain id, the number of records, count, p50, p95 and max of `latency_ms` for allows and denies, the blocked count, every revoke-to-first-deny time and every KILL-to-`run_stopped` time. `GET /tiers` (the tier table) and `GET /agents/{id}/inquest` (the deterministic report, from the chain in memory) need no token either.

Where every credential lives (details in [docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md) and [infra/README.md](infra/README.md)):

| Credential | Lives in | Never in |
|---|---|---|
| Workshop Studio session keys (profile `ws`, expire after a few hours) | `gateway/.aws-credentials` (git-ignored), written by `scripts/aws_creds.py` | `~/.aws`, user environment variables, the agent's environment, the repo |
| Gateway role session (`mytopia-gateway-role`, 1 hour, re-minted by botocore before expiry) | the gateway process's memory, produced by `infra/gateway_creds.py` as a `credential_process` | any file, the agent |
| Cognito client secret per agent | `agent/.env` (git-ignored), read only by the launcher. The two seed agents' secrets are written by `infra/provision.py`; a Factory-made agent's by the gateway, under a `# minted by the Factory` line, through a temp file and an atomic replace. This file on this laptop stands in for a secrets manager | the agent process, the browser, any HTTP response, event or log line, the repo (`agent/.env.example` has empty values) |
| Cognito access token (5 minutes) | the launcher; `launcher/.token-<run_id>` (git-ignored, deleted when the run ends); the agent's environment | the terminal (at most the first 12 characters are printed) |
| Bedrock bearer token (Bedrock only, us-east-1, at most 12 hours) | `agent/.env`, written by `scripts/bedrock_key.py`; the agent's environment | the gateway |
| Admin token (`X-Admin-Token`, a demo shortcut) | `gateway/.env`, `agent/.env`; served to the browser by `GET /config.js` on 127.0.0.1 | the agent's environment, any public URL |

The launcher builds the agent's environment from scratch (`launcher/run.py` `child_env`). It points `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` at the empty `launcher/empty.ini`, so the agent cannot pick up an AWS profile or access keys. The organizers forbid long-lived IAM keys, and none are created anywhere ([docs/AWS_SETUP.md](docs/AWS_SETUP.md)).

## AWS services used and why

| Service | Role in MYTOPIA | Why this one | What we learned today |
|---|---|---|---|
| Amazon Cognito | One user pool `mytopia`, one app client per agent (`research-bot`, `ops-bot`, and one for every agent the Factory mints), scope `mytopia/tools`, 5-minute access tokens. Since build 3 the gateway itself calls `CreateUserPoolClient` on a mint and `DeleteUserPoolClient` on a retire | Each agent becomes its own OAuth client. The gateway verifies RS256 tokens offline against the pool's JWKS. The Factory creates and deletes the client with the same parameters provisioning uses, so an agent's identity is born and dies with its badge, and no human touches the console. | The unsigned `GetClientToken` call issues a machine token with no hosted domain, and returns `ExpiresIn` 300, the app client's 5-minute access-token validity (proven by `scripts/probe.py`, [docs/INTERFACES.md](docs/INTERFACES.md) section 11). Cognito cannot revoke a machine access token: it stays valid until `exp`. So revocation has to live in the gateway ([docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md)). |
| Amazon DynamoDB | `mytopia_agents`: the badge rows (status, allowed tools and, since build 3, tier, role and who made the row). `mytopia_events`: the hash-chained decision log. Both on-demand. Since build 3 the Factory also uses `PutItem if attribute_not_exists(agent)` (mint), `DeleteItem` (retire) and one consistent `Scan` (`GET /agents`) on the agents table | A strongly consistent `GetItem` on every call returns the latest badge, so a revoke takes effect on the next call. The conditional `PutItem` means a mint can never overwrite a badge; the `Scan` is there because the roster is dynamic now (any number of agents), where before the gateway read two fixed rows by id. | `agent` and `status` are reserved words. An unaliased condition expression made REVOKE return 503 until fixed ([docs/ISLAND_ACCEPTANCE.md](docs/ISLAND_ACCEPTANCE.md)). From the gateway role, `list-tables` is refused ([infra/README.md](infra/README.md)). |
| AWS Lambda | `mytopia-tools` (python3.12) runs the six fake tools | The tools sit outside both the laptop process and the agent. Only the gateway role holds `lambda:InvokeFunction` on this one ARN. | Right after `CreateRole`, Lambda can refuse the role ("cannot be assumed by Lambda"), so `infra/provision.py` retries for 60 s. |
| AWS IAM and STS | `mytopia-gateway-role`: GetItem/UpdateItem and (since build 3) PutItem/DeleteItem/Scan on the agents table, PutItem/Query on the events table, InvokeFunction on the function, CreateUserPoolClient/DeleteUserPoolClient on the pool, nothing else; the five build 3 actions are put by `infra/role_policy.py`. `mytopia-tools-exec`: CloudWatch Logs only. | The organizers forbid long-lived keys. A role assumed from the session keys gives the gateway temporary, narrow credentials. | Role chaining caps the session at 1 hour. `credential_process` lets botocore re-mint it before expiry with no restart ([docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md)). |
| Amazon Bedrock | The agent's model: Nova 2 Lite through the `us.` inference profile, called by Strands' `BedrockModel(api_key=...)`, temperature 0 | An Amazon model needs no Marketplace subscription. A short-term Bedrock API key lets the agent call the model while holding no AWS credentials. | Nova 2 Lite has no in-region option in us-east-1, hence `us.amazon.nova-2-lite-v1:0` (fallback `amazon.nova-lite-v1:0`). The bearer key works for Bedrock only, in one region ([docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md)). |
| Amazon CloudWatch Logs | The Lambda's own log | Comes with Lambda. Its execution role can write logs and nothing else. | Not shown in the live run; it is an independent record of tool executions. |

## Run it

Windows 11, from the repo root, Python 3.14 in `.venv` (`.venv\Scripts\python -m pip install -r requirements.txt` once). The gateway listens on 127.0.0.1:8787 and serves the island at `/`.

**1. Local twins, no AWS.** In local mode the registry is a dict, the log is in memory plus a JSONL file, tokens are HS256 from `gateway/issuer_local.py`, and the tools run in-process. The agent runs scripted (no model). The Factory works here too: a minted agent gets the identity `local-<agent>` with no secret, its lines are still written to `agent/.env`, and the launcher can start it with `--token-mode local`.

PowerShell's `copy` overwrites without asking: if `infra/provision.py` has already written these `.env` files, back them up first.

```powershell
copy gateway\.env.example gateway\.env
copy agent\.env.example agent\.env
.venv\Scripts\python -m uvicorn gateway.app:app --port 8787
# second terminal
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json --scripted --token-mode local
# open http://127.0.0.1:8787/ and click REVOKE, then KILL
```

Other checks: `.venv\Scripts\python -m pytest -q` (no AWS needed), `node --test island/tests/*.test.mjs`, `powershell -ExecutionPolicy Bypass -File scripts\curl_demo.ps1` (the four steps with curl against a running gateway). `.venv\Scripts\python tools\mock_gateway.py` stands in for the gateway and plays `contract/fixture.json`.

**2. Against AWS.** From [infra/README.md](infra/README.md) and [agent/README.md](agent/README.md):

```powershell
.venv\Scripts\python scripts\aws_creds.py            # saves the Workshop Studio keys as profile ws (reads Desktop\creds.txt, then deletes it)
.venv\Scripts\python infra\provision.py --dry-run    # prints the plan
.venv\Scripts\python infra\provision.py              # creates or finds everything; writes gateway\.env and agent\.env
.venv\Scripts\python infra\role_policy.py            # one time, for a role provisioned before build 3: the Factory's five IAM actions (--dry-run prints them)
.venv\Scripts\python scripts\whoami.py gateway       # expect assumed-role/mytopia-gateway-role/mytopia-gateway
.venv\Scripts\python scripts\bedrock_key.py          # writes AWS_BEARER_TOKEN_BEDROCK into agent\.env
.venv\Scripts\python -m uvicorn gateway.app:app --port 8787        # now MODE=aws, TOOLS_MODE=lambda, TOKEN_MODE=cognito
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json   # second terminal; add --scripted for no model
.venv\Scripts\python launcher\run.py --agent billing-bot --task tasks\q3.json --scripted --patrol   # an agent the Factory minted, on patrol
```

Delete everything afterwards with `.venv\Scripts\python infra\teardown.py --yes`.

**3. Replay only.** `replay/demo.json` is the recording of the 4:18 PM model-mode live run (15 events, one hash chain, `chain-20261108T001839Z`); `replay/demo-first-run.json` is the 1:40 PM run (16 events). Build 3 has two recordings: `replay/demo3.json` is the Factory run on real AWS (run 7 in LIVE_RUN.md: 56 rows, chain `chain-20261108T035444Z`, real hashes and real Cognito client ids; mint, the patrol, a pull and a grant, promote, demote, a quarantine into the bay, two kills, retire), and `replay/demo3-local.json` is the same flow in local mode (run 6: 70 rows, local client ids). With the gateway running, the island plays a recording at `http://127.0.0.1:8787/?replay=/replay/demo.json` (or `?replay=/replay/demo3.json`), with the badge reading REPLAY and the buttons and chips disabled. `replay/demo.json` spans 33 s from `run_started` to `run_stopped`; the island lets each ritual finish, so playback runs a little longer. Without the gateway:

```powershell
.venv\Scripts\python -m http.server 5300 --bind 127.0.0.1
# open http://127.0.0.1:5300/island/index.html?replay=../replay/demo.json
```

This serves the whole repo folder, git-ignored `.env` files included, so keep `--bind 127.0.0.1` and stop the server when done.

Pressing **R** on the island plays `island/fixture.json` instead: the contract's 21 example events, not a live run. `POST /demo/replay` on the gateway does not re-run anything; it answers with a pointer to `/replay/demo.json`, which the island plays with `?replay=/replay/demo.json`.

## Demo script

The three-minute table demo and the fallbacks are in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Built versus used, and what an assistant wrote

- **The engine** (`gateway/`, `tools_lambda/`, `agent/`, `launcher/`, `infra/`, `scripts/`, `tools/`, `tests/`, `contract/`, `docs/`) was written today, Saturday 2026-11-07, by Claude Code (Anthropic) under the team's direction. The team chose the design, ran the probe and the live run, and reviewed the code. [docs/EXPLAIN.md](docs/EXPLAIN.md) is the walkthrough each of us studied so we can explain every file. Build 3 (Saturday night) added `gateway/tiers.py`, `gateway/factory.py`, `gateway/identity.py` and `infra/role_policy.py` the same way.
- **The island** (`island/`) was first built today by Ozi's Claude Code agent. On Saturday afternoon Claude Code (Opus builder agents directed by a Fable session, the same session that wrote the engine) rebuilt it as "the archipelago" (`docs/ISLAND_V2.md`) and added round two (`docs/ISLAND_V2_ADDITIONS.md`: tool chips, QUARANTINED, the ID card, the ledger rows' JSON, the architecture sheet). On Saturday night build 3 (`docs/BUILD3.md`) added the Factory island (`island/src/factory.js`), an interior for every building (`island/src/rooms.js`, which absorbed the ledger room of `room.js`), the tier table (`island/src/tiers.js`) and the plain-word panels. Its renderer (`island/three-d-stage.js`), the palette and the building and robot recipes come from Mytopia, Ozi's earlier personal project (October 2026); the renderer was untouched until build 3 added one method to it, `setPixel`, so the rooms render at full resolution. The line between pre-existing and new is drawn file by file in [island/ASSETS.md](island/ASSETS.md) (its table says byte-identical until build 3 added `setPixel`).
- **Libraries we use but did not write:** strands-agents 1.64.0, mcp 2.3.0, boto3 1.43.126, PyJWT 2.15.1 (with cryptography), starlette 1.10.0, uvicorn 0.54.0, httpx 0.28.1, psutil 7.2.2, aws-bedrock-token-generator 1.1.0, python-dotenv, requests, pytest 9.2.0 (`requirements.txt`); three.js 0.184.0, vendored; the fonts Pixelify Sans and VT323. Licences are in [ASSETS.md](ASSETS.md).
- **What we wrote by hand instead of taking a framework:** the MCP endpoint is a hand-written JSON-RPC handler for `initialize`, `ping`, `tools/list` and `tools/call` over Streamable HTTP (`gateway/mcp.py`), not the MCP SDK's server. All allow/deny logic is in one function, `decide()` (`gateway/decide.py`).
- **Prior art.** MCP gateways and proxies already exist: Kong, LiteLLM, Cloudflare, and Amazon Bedrock AgentCore Gateway with Policy. We add two things: a per-call, strongly consistent badge read that acts as the kill switch, and the island as a wall display that draws only the gateway's log.

## Known limits and what's next

Limits, stated plainly:
- The agent and the gateway run as the same OS user on one laptop. A process that knows a file's path could read `agent/.env`. In production the agent belongs on a separate sandbox or host whose only exit is the gateway.
- A call already past the check completes. Revoke stops the next call, not one in flight.
- The admin token is a demo shortcut: it is served to the browser on 127.0.0.1 by `/config.js`.
- The client secret in a file stands in for an attested workload identity.
- The gateway's memory is authoritative for the island. The DynamoDB copy of the log is best effort: a failed `PutItem` is logged and does not block the call. On restart the gateway resumes its chain from a local JSONL twin, because its role cannot scan the table.
- The JWKS is cached by PyJWT's `PyJWKClient`: the key set for 300 s, signing keys by key id. An unknown key id triggers one refetch, at most once per 30 s (PyJWT's default cooldown). Between fetches the gateway trusts the cached keys.
- Filtering `tools/list` is hygiene. The `tools/call` check is the control.
- The log is tamper-evident, not tamper-proof. The gateway role has only PutItem and Query on the events table, the gateway's code makes each write conditional on `attribute_not_exists(seq)`, and the SHA-256 chain makes a rewrite visible. IAM cannot force that condition, so whoever holds the role's credentials could still overwrite a row with a plain PutItem; the change would show against the gateway's memory and the JSONL twin. An account administrator could still rewrite the table and recompute the hashes.
- Each call adds one strongly consistent DynamoDB read from the laptop to us-east-1: decision p50 about 85 ms in the model-mode run (87 ms on allows, 83 ms on denies; the first run did two reads and measured 160 to 180 ms), against 0 to 3 ms in local mode ([docs/LIVE_RUN.md](docs/LIVE_RUN.md)). Nearly all of it is that one network round trip (one consistent `GetItem` measured 77.6 ms p50 on its own in the profile behind commit d1cc066), so rewriting the gateway in a faster language would barely change it.
- The quarantine counter and the set of pulled tools live in the gateway's memory and reset when it restarts. Per-tool changes are serialised under one lock in the gateway process.
- Machine tokens carry no audience claim. The scope, the issuer and the registered-client check stand in for audience binding.
- Build 3: a minted agent's client secret is written to the launcher's env file on this laptop. It never leaves the gateway over HTTP, but the file is readable by any process running as this Windows user. It stands in for a secrets manager.
- Build 3: the same admin token gates mint, promote, demote and retire; `GET /tiers` and `GET /agents/{id}/inquest` need no token, like `/events`. The Factory's events say "by operator", not who.
- Build 3: the gateway role grew by five actions (rows and app clients). Whoever held its one-hour session could now mint an identity in the pool or delete a badge row, where before they could only flip and edit two rows. The events table's permissions are unchanged.
- Build 3: on retire, `DeleteUserPoolClient` is best effort. The row is deleted and `retired` is logged either way; a leftover client's tokens are refused because no badge row names it, and `infra/teardown.py` deletes the pool.
- Build 3: tier ceilings are a table in code, mirrored in the island, not a policy engine. Changing one is a code change and a restart.
- Build 3: the Factory flow was measured live twice, in local mode (run 6) and on real AWS (run 7, [docs/LIVE_RUN.md](docs/LIVE_RUN.md)), both with scripted clients and no model; no model-mode run of a Factory-made agent has been done.

Next:
- Amazon Bedrock AgentCore Gateway with Policy as the managed path for the same checks.
- Task-scoped badges with an expiry, so access ends with the task even if nobody clicks.
- DynamoDB Streams and a WebSocket in place of the island's 300 ms and the launcher's 250 ms polling.
- Sender-constrained tokens, so a copied token is useless on another machine.
- A separate sandbox host for the agent.
- A secrets manager for the secrets the Factory mints, and operator sign-in in front of the Factory, so `created`, `tier_changed` and `retired` name a person.

## Assets and licences

See [ASSETS.md](ASSETS.md) for what was made today, what was pre-existing and what is third-party, with licences. The island's detail is in [island/ASSETS.md](island/ASSETS.md).

## Team

**Bob** explains the gateway, the tokens, the badge and the AWS setup: how a Cognito machine token is checked, why every call reads the badge with a strongly consistent read, and how the gateway runs on a narrow role with no long-lived keys. Since build 3, also the Factory: how a mint creates an identity and a badge in one step, why the tier ceiling binds the operator too, why the inquest is deterministic, and which five IAM actions the role gained and why.

**Ozan "Ozi"** explains the island. Its renderer, palette and building recipes come from Mytopia, his earlier personal project; his Claude Code agent built the first island this weekend, and Claude Code rebuilt it on Saturday afternoon as the archipelago and added the Factory on Saturday night. He explains the reducer that turns each logged event into a ritual (the ID check at a gate, the guard's escort, the pen for REVOKE, the bay for a quarantine or a kill, the power-down), the interiors and their boards drawn from the log, the ledger room that re-checks the hash chain in the browser and the TAMPER TEST that only changes a copy, and why the buttons and chips only POST.

**Daniel** explains the agent, the launcher and the business plan: what the agent process holds and does not hold, how the launcher rotates its token and kills its process tree, what `--patrol` does and what a well-behaved agent looks like, why the task is deterministic, why Nova, and who would buy this.

Repository layout: `contract/` the event and API contract between engine and island; `gateway/` the MCP gateway; `tools_lambda/` the six tools; `agent/` the Strands agent; `launcher/` the harness that owns it; `infra/` AWS provisioning; `island/` the face; `scripts/` setup, probe and demo scripts; `tools/` the mock gateway and fixture checker; `tests/` pytest; `replay/` recordings; `docs/` everything else.
