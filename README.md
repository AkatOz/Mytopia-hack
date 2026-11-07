# MYTOPIA

MYTOPIA is identity and access management for AI agents, drawn as an island. Each agent has its own Amazon Cognito identity and a badge listing the tools it may use. Each tool is a building. An MCP gateway checks the badge on every call. When an operator pulls the badge mid-task, the agent's next call is refused at the gate, on the island and in the terminal, even though the agent's token is still valid.

AWS x A10 Hack 2026, Santa Clara University ACM. **A10 track, Prompt 1: Agentic Identity.** Built Saturday 2026-11-07 during the event (see "Built versus used" below).

## What you will see

All numbers below come from the first full live run on AWS, Sat 2026-11-07 at 1:40 PM PT ([docs/LIVE_RUN.md](docs/LIVE_RUN.md)).

1. **Authenticate.** The launcher gets a 5-minute Cognito machine token for `research-bot` (`token OK: client s2ch2ppk..., scope mytopia/tools, expires in 300 s`). The robot's chest plate turns green and the island shows AUTHENTICATED.
2. **Allow selected tools.** `tools/list` returns the 4 tools on the badge. `read_file`, `search_files` and `create_issue` are allowed, and green sparks fly to Files and GitHub. Each gateway decision took 157 to 178 ms.
3. **Block a disallowed action.** The model (Nova 2 Lite) tries `send_email`. The answer is `DENY send_email: send_email is not on badge research-bot [rule: allow-list]`: a red fizzle at the gatehouse and smoke over Mail.
4. **Revoke mid-task.** An operator clicks REVOKE on the island. The agent's next call came **494 ms** later and was refused, while its token still had **254 s** left: `badge REVOKED at 21:40:45 by operator (token: signature OK, expires in 254 s)`.
5. **Block what follows and stop the run.** Every later call is refused. KILL flips the badge to KILLED. The launcher kills the agent's process tree (`taskkill in 534 ms`), and the island reads `run stopped 1274 ms after KILL, exit 1 (killed by harness)`.

## The required flow and where each step is met

Prompt 1 asks for four steps. We add two more, a blocked disallowed action and a hard stop, labelled "borrowed" below. The "proof" column quotes lines from [docs/LIVE_RUN.md](docs/LIVE_RUN.md).

| Step | Component | File and function | Proof in LIVE_RUN.md |
|---|---|---|---|
| 1. Authenticate an agent | Launcher mints a Cognito client-credentials token. Gateway verifies it offline against the pool's JWKS. | `launcher/run.py` `mint_token`; `gateway/tokens.py` `CognitoVerifier.verify`, `check_claims` | terminal `token OK: client s2ch2ppk..., scope mytopia/tools, expires in 300 s`; chain seq 1 `run_started` |
| 2. Allow selected MCP tools | Gateway filters `tools/list` by the badge and checks every `tools/call` against the badge | `gateway/mcp.py` `McpHandler._tools_list`, `_tools_call`; `gateway/decide.py` `decide` | terminal `tools/list: 4 tools (read_file, search_files, create_issue, list_issues)`; seq 2 to 5 `allow` |
| Borrowed: block a disallowed action | Same `decide`, rule `allow-list`. The model was offered `send_email` from a stale local catalog. | `gateway/decide.py` `decide`; `agent/main.py` `catalog_tools` | seq 6 `deny send_email ... allow-list`, 162 ms |
| 3. Revoke access mid-task | Island button POSTs to the gateway, which runs DynamoDB `UpdateItem` on the badge row (`status=REVOKED`) | `island/src/main.js` `press`; `gateway/app.py` `admin_action`; `gateway/registry.py` `DynamoRegistry.set_status` | seq 11 `revoked ... (REVOKE clicked on the island)` |
| 4. Block subsequent requests | Every call does a strongly consistent badge read, then `decide` returns `status-revoked` | `gateway/registry.py` `DynamoRegistry.get` (`ConsistentRead=True`); `gateway/decide.py` `decide` | seq 12 `deny read_file status-revoked`, **494** ms since revoke, `expires in 254 s`; seq 13, 14 |
| Borrowed: stop the run | KILL sets `status=KILLED` (soft stop at the gateway). The launcher sees it within one 1-second poll and kills the process tree (hard stop). | `gateway/app.py` `admin_action`; `launcher/run.py` `own_run`, `kill_tree` | seq 15 `kill_requested`, seq 16 `run_stopped exit 1 (killed by harness)`; terminal `launcher: KILLED -> taskkill in 534 ms` |

## Architecture

```text
 OPERATOR ZONE: the demo laptop                          |  AGENT ZONE: one child process
                                                         |
  Browser: the island at http://127.0.0.1:8787/          |   agent/main.py  (Strands Agents, Nova 2 Lite)
    |  GET /events?since_seq=N, GET /agents  (every 1 s) |     holds: the current 5-min Cognito access
    |  POST /agents/{id}/revoke|restore|kill, /demo/reset|            token (re-read from a file per
    |       (X-Admin-Token)                              |            request), a Bedrock bearer token
    v                                                    |     never: Cognito client secret, AWS access
  GATEWAY  gateway/app.py  (uvicorn on 127.0.0.1:8787) <-|------    keys, admin token
    holds: the narrow IAM role's 1-hour session          |     POST /mcp  JSON-RPC tools/list, tools/call
           (via credential_process), the admin token     |          Authorization: Bearer <token>
    ^                                                    |
    |  POST /runs/{id}/started|stopped,                  |
    |  GET /agents/{id}/status (every 1 s)               |
  LAUNCHER launcher/run.py  -- spawns with a scrubbed environment, rewrites the token file
    holds: Cognito client secret, admin token  every 240 s, taskkill /PID <pid> /T /F on KILLED --> agent
=====================================================================================================
 AWS us-east-1 (event account)
  Cognito pool "mytopia" <-- GetClientToken (unsigned call: client id + secret) ------- launcher
                         --- JWKS public keys (cached by the gateway) ---------------> gateway
  STS AssumeRole mytopia-gateway-role (1 h) <-- infra/gateway_creds.py, from profile ws (session keys)
  DynamoDB mytopia_agents <-- gateway: GetItem with ConsistentRead, UpdateItem (the buttons)
  DynamoDB mytopia_events <-- gateway: PutItem if attribute_not_exists(seq), Query
  Lambda mytopia-tools    <-- gateway: Invoke {"tool": name, "arguments": {...}}
  CloudWatch Logs         <-- the Lambda's own execution role (its logs only)
  Bedrock Nova 2 Lite (us.amazon.nova-2-lite-v1:0) <-- agent: model calls with the bearer token
```

What each arrow carries:
- The island sends GETs and four admin POSTs (revoke, restore, kill and `/demo/reset`) to the gateway and nothing else. It never calls AWS and draws only events it reads from `GET /events`.
- The agent can reach two things: the gateway's `/mcp`, and Bedrock's model endpoint. The six tools run in a Lambda that only the gateway's role may invoke.
- The launcher talks to Cognito (to mint tokens) and to the gateway's control API (to report runs and read the badge status). It is the agent's parent process.

Where every credential lives (details in [docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md) and [infra/README.md](infra/README.md)):

| Credential | Lives in | Never in |
|---|---|---|
| Workshop Studio session keys (profile `ws`, expire after a few hours) | `gateway/.aws-credentials` (git-ignored), written by `scripts/aws_creds.py` | `~/.aws`, user environment variables, the agent's environment, the repo |
| Gateway role session (`mytopia-gateway-role`, 1 hour, re-minted by botocore before expiry) | the gateway process's memory, produced by `infra/gateway_creds.py` as a `credential_process` | any file, the agent |
| Cognito client secret per agent | `agent/.env` (git-ignored), read only by the launcher | the agent process, the browser, the repo (`agent/.env.example` has empty values) |
| Cognito access token (5 minutes) | the launcher; `launcher/.token-<run_id>` (git-ignored, deleted when the run ends); the agent's environment | the terminal (at most the first 12 characters are printed) |
| Bedrock bearer token (Bedrock only, us-east-1, at most 12 hours) | `agent/.env`, written by `scripts/bedrock_key.py`; the agent's environment | the gateway |
| Admin token (`X-Admin-Token`, a demo shortcut) | `gateway/.env`, `agent/.env`; served to the browser by `GET /config.js` on 127.0.0.1 | the agent's environment, any public URL |

The launcher builds the agent's environment from scratch (`launcher/run.py` `child_env`). It points `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` at the empty `launcher/empty.ini`, so the agent cannot pick up an AWS profile or access keys. The organizers forbid long-lived IAM keys, and none are created anywhere ([docs/AWS_SETUP.md](docs/AWS_SETUP.md)).

## AWS services used and why

| Service | Role in MYTOPIA | Why this one | What we learned today |
|---|---|---|---|
| Amazon Cognito | One user pool `mytopia`, one app client per agent (`research-bot`, `ops-bot`), scope `mytopia/tools`, 5-minute access tokens | Each agent becomes its own OAuth client. The gateway verifies RS256 tokens offline against the pool's JWKS. | The unsigned `GetClientToken` call issues a machine token with no hosted domain, and returns `ExpiresIn` 300, the app client's 5-minute access-token validity (proven by `scripts/probe.py`, [docs/INTERFACES.md](docs/INTERFACES.md) section 11). Cognito cannot revoke a machine access token: it stays valid until `exp`. So revocation has to live in the gateway ([docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md)). |
| Amazon DynamoDB | `mytopia_agents`: the badge rows (status and allowed tools). `mytopia_events`: the hash-chained decision log. Both on-demand. | A strongly consistent `GetItem` on every call returns the latest badge, so a revoke takes effect on the next call. | `agent` and `status` are reserved words. An unaliased condition expression made REVOKE return 503 until fixed ([docs/ISLAND_ACCEPTANCE.md](docs/ISLAND_ACCEPTANCE.md)). From the gateway role, `list-tables` is refused ([infra/README.md](infra/README.md)). |
| AWS Lambda | `mytopia-tools` (python3.12) runs the six fake tools | The tools sit outside both the laptop process and the agent. Only the gateway role holds `lambda:InvokeFunction` on this one ARN. | Right after `CreateRole`, Lambda can refuse the role ("cannot be assumed by Lambda"), so `infra/provision.py` retries for 60 s. |
| AWS IAM and STS | `mytopia-gateway-role`: GetItem/UpdateItem on the agents table, PutItem/Query on the events table, InvokeFunction on the function, nothing else. `mytopia-tools-exec`: CloudWatch Logs only. | The organizers forbid long-lived keys. A role assumed from the session keys gives the gateway temporary, narrow credentials. | Role chaining caps the session at 1 hour. `credential_process` lets botocore re-mint it before expiry with no restart ([docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md)). |
| Amazon Bedrock | The agent's model: Nova 2 Lite through the `us.` inference profile, called by Strands' `BedrockModel(api_key=...)`, temperature 0 | An Amazon model needs no Marketplace subscription. A short-term Bedrock API key lets the agent call the model while holding no AWS credentials. | Nova 2 Lite has no in-region option in us-east-1, hence `us.amazon.nova-2-lite-v1:0` (fallback `amazon.nova-lite-v1:0`). The bearer key works for Bedrock only, in one region ([docs/AWS_CREDENTIAL_DESIGN.md](docs/AWS_CREDENTIAL_DESIGN.md)). |
| Amazon CloudWatch Logs | The Lambda's own log | Comes with Lambda. Its execution role can write logs and nothing else. | Not shown in the live run; it is an independent record of tool executions. |

## Run it

Windows 11, from the repo root, Python 3.14 in `.venv` (`.venv\Scripts\python -m pip install -r requirements.txt` once). The gateway listens on 127.0.0.1:8787 and serves the island at `/`.

**1. Local twins, no AWS.** In local mode the registry is a dict, the log is in memory plus a JSONL file, tokens are HS256 from `gateway/issuer_local.py`, and the tools run in-process. The agent runs scripted (no model).

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
.venv\Scripts\python scripts\whoami.py gateway       # expect assumed-role/mytopia-gateway-role/mytopia-gateway
.venv\Scripts\python scripts\bedrock_key.py          # writes AWS_BEARER_TOKEN_BEDROCK into agent\.env
.venv\Scripts\python -m uvicorn gateway.app:app --port 8787        # now MODE=aws, TOOLS_MODE=lambda, TOKEN_MODE=cognito
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json   # second terminal; add --scripted for no model
```

Delete everything afterwards with `.venv\Scripts\python infra\teardown.py --yes`.

**3. Replay only.** `replay/demo.json` is the recording of the 1:40 PM live run (16 events, one hash chain). The island plays it with the badge reading REPLAY and the buttons disabled.

```powershell
.venv\Scripts\python -m http.server 5300 --bind 127.0.0.1
# open http://127.0.0.1:5300/island/index.html?replay=../replay/demo.json
```

This serves the whole repo folder, git-ignored `.env` files included, so keep `--bind 127.0.0.1` and stop the server when done.

Pressing **R** on the island plays `island/fixture.json` instead: the contract's 21 example events, not a live run. `POST /demo/replay` on the gateway is not built (it answers 501).

## Demo script

The three-minute table demo and the fallbacks are in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Built versus used, and what an assistant wrote

- **The engine** (`gateway/`, `tools_lambda/`, `agent/`, `launcher/`, `infra/`, `scripts/`, `tools/`, `tests/`, `contract/`, `docs/`) was written today, Saturday 2026-11-07, by Claude Code (Anthropic) under the team's direction. The team chose the design, ran the probe and the live run, and reviewed the code. [docs/EXPLAIN.md](docs/EXPLAIN.md) is the walkthrough each of us studied so we can explain every file.
- **The island** (`island/`) was built today by Ozi's Claude Code agent. Its renderer (`island/three-d-stage.js`, unchanged) and its building and robot shapes come from Mytopia, Ozi's earlier personal project (October 2026). The line between pre-existing and new is drawn file by file in [island/ASSETS.md](island/ASSETS.md).
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
- Each call adds the strongly consistent DynamoDB reads from the laptop to us-east-1: about 160 to 180 ms per decision in the live run, against 1 to 3 ms in local mode ([docs/LIVE_RUN.md](docs/LIVE_RUN.md)).
- Machine tokens carry no audience claim. The scope, the issuer and the registered-client check stand in for audience binding.

Next:
- Amazon Bedrock AgentCore Gateway with Policy as the managed path for the same checks.
- Task-scoped badges with an expiry, so access ends with the task even if nobody clicks.
- DynamoDB Streams and a WebSocket in place of the island's and the launcher's 1-second polling.
- Sender-constrained tokens, so a copied token is useless on another machine.
- A separate sandbox host for the agent.

## Assets and licences

See [ASSETS.md](ASSETS.md) for what was made today, what was pre-existing and what is third-party, with licences. The island's detail is in [island/ASSETS.md](island/ASSETS.md).

## Team

**Bob** explains the gateway, the tokens, the badge and the AWS setup: how a Cognito machine token is checked, why every call reads the badge with a strongly consistent read, and how the gateway runs on a narrow role with no long-lived keys.

**Ozan "Ozi"** explains the island. Its renderer comes from Mytopia, his earlier personal project, and his Claude Code agent built the island this weekend: the reducer that turns each logged event into a drawing, the gatehouse, the robots, and why the buttons only POST.

**[teammate #3's name]** explains the agent, the launcher and the business plan: what the agent process holds and does not hold, how the launcher rotates its token and kills its process tree, why the task is deterministic, why Nova, and who would buy this.

Repository layout: `contract/` the event and API contract between engine and island; `gateway/` the MCP gateway; `tools_lambda/` the six tools; `agent/` the Strands agent; `launcher/` the harness that owns it; `infra/` AWS provisioning; `island/` the face; `scripts/` setup, probe and demo scripts; `tools/` the mock gateway and fixture checker; `tests/` pytest; `replay/` recordings; `docs/` everything else.
