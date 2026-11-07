# EXPLAIN: every file, in words you can say without the screen

The hackathon rules let judges discredit a project whose team cannot explain its code. Claude Code wrote the engine today under our direction, and Ozi's Claude Code built the island on his earlier Mytopia renderer. We say so first. Then we show we understand it. This file is the study sheet.

Each entry gives what the file is (two sentences), the one function to point at, and the one question a judge might ask, with the answer. Read the code next to it once. Every claim below was checked against the code on Saturday afternoon.

Words used throughout:
- **badge**: one row in DynamoDB table `mytopia_agents` holding `status` (ACTIVE, REVOKED or KILLED) and `allowed_tools`.
- **decision**: one allow or deny, written to the event log.
- **local mode / AWS mode**: the same code with local twins (a dict, a JSONL file, HS256 tokens, in-process tools) or with DynamoDB, Lambda and Cognito. Three switches in `gateway/.env`: `MODE`, `TOOLS_MODE`, `TOKEN_MODE`.

---

## gateway/ (Bob)

The engine. One Starlette app on 127.0.0.1:8787. It checks the token, reads the badge, calls `decide()`, runs the tool if allowed, logs the decision, and answers.

### gateway/__init__.py
What it is: the package marker, with a docstring giving the start command. Nothing runs here.
Point at: the docstring, `python -m uvicorn gateway.app:app --port 8787`.
Judge: "How do I start it?" Answer: "That one command from the repo root. It reads `gateway/.env` to choose local or AWS mode."

### gateway/app.py
What it is: builds the web app. Routes: `POST /mcp`, the island's read-only API (`/events`, `/agents`, `/config.js`), the operator buttons (`/agents/{id}/revoke|restore|kill`, `/demo/reset`), the launcher's `/runs/{id}/started|stopped`, and the island as static files at `/`. `build_handler` picks the registry, log, verifier and tool runner from the three mode switches.
Point at: `admin_action`. It checks `X-Admin-Token` with `hmac.compare_digest`, writes the new status to the registry (`set_status`), remembers the revoke time, and appends the `revoked` / `restored` / `kill_requested` event.
Judge: "What stops anyone clicking REVOKE, or stealing your admin token?" Answer: "The server listens on 127.0.0.1 only, and the admin routes need `X-Admin-Token`. The token is handed to the browser by `/config.js`, so it is a demo shortcut, and we say so. Production would put operator sign-in in front. Note also that `aws_session` names the AWS profile explicitly. That makes boto3 ignore any stray access keys in the environment, so the gateway can only ever be the narrow role."

### gateway/config.py
What it is: a `Settings` dataclass that reads `gateway/.env`, with the process environment overriding it. Defaults are local mode.
Point at: `Settings.from_env`. It copies `AWS_PROFILE`, `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` into `os.environ` before boto3 is imported.
Judge: "How does the gateway get onto the narrow role instead of your own keys?" Answer: "`from_env` points boto3 at `gateway/.aws-config`, profile `gateway`. That profile holds no keys, only a `credential_process` that runs `infra/gateway_creds.py`, which assumes `mytopia-gateway-role` for one hour."

### gateway/decide.py
What it is: the only function in the system that decides allow or deny. Everything else gathers its inputs or records its output.
Point at: `decide(row, tool)`. In order:
1. No row: deny, rule `token`.
2. KILLED: deny `status-killed`.
3. REVOKED: deny `status-revoked`, giving the time and who.
4. Any other non-ACTIVE status: deny.
5. `tools/list`: allow.
6. Tool not on the badge: deny `allow-list`.
7. Otherwise allow.

Judge: "Is the policy decision made by an LLM? I will prompt-inject it." Answer: "No. It is about twenty lines of `if` statements over a database row. The model is the thing being controlled. The fake planning file even carries a planted instruction to forward it to an outside address. Whatever the model wants, `send_email` is not on the badge, so it is refused."

### gateway/events.py
What it is: the decision log as a SHA-256 hash chain. Each record carries `seq`, `ts`, the previous record's hash (`prev_hash`) and its own `hash`. `MemoryEventLog` keeps it in memory plus a JSONL file. `DynamoEventLog` also writes each record to `mytopia_events`.
Point at: `MemoryEventLog.append` and `record_hash`. The hash is SHA-256 of the canonical JSON (sorted keys, compact) of the record without its `hash` field. The first record links to `"genesis"`.
Judge: "Can the log be rewritten?" Answer: "It is tamper-evident, not tamper-proof. The gateway role can only `PutItem` and `Query` on that table: no update, no delete, no scan. Our code makes each write conditional on `attribute_not_exists(seq)`, so the gateway never overwrites a row, and any change breaks the chain. IAM cannot force that condition, so someone holding the role's credentials could overwrite a row with a plain PutItem; that would show up against the other copies. Someone with admin rights on the account could rewrite everything and recompute the hashes, so the chain proves tampering only against another copy. We keep two other copies, the gateway's memory and the JSONL twin. The DynamoDB write is best effort: if it fails, it is logged and the call still answers."

### gateway/issuer_local.py
What it is: the local-mode token issuer. It mints HS256 tokens with the same claims Cognito puts in a machine access token (`sub`, `client_id`, `token_use`, `scope`, `iss`, `iat`, `exp`).
Point at: `mint_local_token`.
Judge: "Is local mode a backdoor?" Answer: "Only if you turn it on with `TOKEN_MODE=local`. In AWS mode the verifier is `CognitoVerifier`. An HS256 token has no key in the pool's JWKS, so it is rejected with a 401."

### gateway/mcp.py
What it is: our hand-written MCP endpoint, plain JSON-RPC behind `POST /mcp`. It answers `initialize`, `ping`, `tools/list`, `tools/call` and notifications, which is enough for the pinned `mcp` 2.3.0 client and Strands' `MCPClient`.
Point at: `McpHandler._tools_call`. The steps:
1. Check the `Mcp-Name` header, if present, against the tool name.
2. Read the badge (`registry.get`, consistent read).
3. Call `decide`.
4. Measure `latency_ms`.
5. If allowed, invoke the tool.
6. Log the event.
7. Sleep `DEMO_PACE` (2 s).
8. Answer.

The event is logged before the pace sleep, so the island sees the decision the moment it is made.

Judge: "Why is a denied tool a normal 200 answer and not an error?" Answer: "That is the 401-versus-isError rule (see below). A bad token is a protocol failure: HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`. A policy denial is a tool result with `isError: true` and the text `DENIED: <reason> [rule: <rule>]`. The model can read that and carry on with the task, which is what MCP's spec asks for."

### gateway/registry.py
What it is: the badge store. `MemoryRegistry` is a dict for local mode. `DynamoRegistry` reads and updates `mytopia_agents`.
Point at: `DynamoRegistry.get`: `get_item(Key={"agent": ...}, ConsistentRead=True)`. Any AWS error raises `RegistryUnavailable`, and the caller denies with rule `registry-unavailable` (fail closed).
Judge: "How many database reads per call, and why no scan?" Answer: "Exactly one strongly consistent `GetItem` per decided call, for every agent. The gateway keeps a small map from client id to agent id in memory (built from the two rows at startup). That map only says which badge row to read; the row itself is read fresh on every call and must still name the token's client id. Two refusals need no read at all, because the badge cannot change them: an `Mcp-Name` header that does not match the tool, and a tool name outside the six. If a call ever arrives before the map is built, the gateway rebuilds it first (the two known rows, read directly because the role has no `Scan` permission), so that one call does three reads. That one read is the laptop-to-us-east-1 round trip, about 80 ms; the first live run did two reads and measured 160 to 180 ms (docs/LIVE_RUN.md)."

### gateway/tokens.py
What it is: bearer-token checks. `CognitoVerifier` checks Cognito RS256 tokens against the pool's JWKS. `LocalVerifier` checks HS256 tokens from `issuer_local.py`. Both finish in `check_claims`.
Point at: `CognitoVerifier.verify`, then `check_claims`. These are the five checks listed below.
Judge: "Machine tokens have no audience claim. What ties this token to your gateway?" Answer: "Three things together. The issuer must be our pool. The scope must contain `mytopia/tools`. The `client_id` must be a registered badge. We know the missing audience claim is a gap. Sender-constrained tokens are on our next list."

### gateway/tools.py
What it is: runs a tool after `decide` said yes. `LocalTools` imports `tools_lambda.handler.run_tool` in-process. `LambdaTools` invokes the Lambda `mytopia-tools` with `{"tool": name, "arguments": {...}}`.
Point at: `LambdaTools.invoke`.
Judge: "What if Lambda fails?" Answer: "It returns an `isError` result reading `tool error: Lambda <code>` and never raises. The decision was still an allow, so it is logged as an allow carrying the tool's error text."

### gateway/table.html
What it is: the fallback face, a plain sortable table of `GET /events` with REVOKE, RESTORE, KILL and RESET buttons. It shows LIVE or STALE from poll health, the same way the island does.
Point at: the `fetch` of `/events?since_seq=` with a cursor.
Judge: "What if the 3D island breaks on stage?" Answer: "Open `/table.html`. It is the same event stream with the same buttons. The gateway also serves it at `/` if the island folder is missing. It never serves the `gateway/` folder itself, because that folder holds the `.env` files."

---

## tools_lambda/ (Bob)

### tools_lambda/__init__.py
What it is: an empty file that makes `tools_lambda` importable, so the gateway can run the tools in-process in local mode. The folder is not called `lambda` because `lambda` is a Python keyword.
Point at: nothing; it is empty.
Judge: "Why is the same file both a Lambda and a local module?" Answer: "So local mode and AWS mode run identical tool code. `infra/provision.py` zips `handler.py` alone for Lambda."

### tools_lambda/handler.py
What it is: the six tools and the fake Example Corp world as constants. It uses no imports, no clock and no randomness, so it is deterministic. `send_email` returns `sent to <to>` and sends nothing. `delete_file` deletes nothing.
Point at: `run_tool(name, arguments)`, plus `handler(event, context)` as the Lambda entry.
Judge: "What is in the planning file the agent reads?" Answer: "Three action items and one planted line asking the reader to forward the document to an outside address. It is the prompt-injection bait. The agent's system prompt says document text is data, but we do not rely on that: `send_email` is not on the badge."

---

## agent/ (Daniel)

### agent/main.py
What it is: the agent, Strands Agents on Bedrock Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`, temperature 0). Its only tools go through the gateway's `/mcp`. It reads only its own environment, runs the task from `tasks/q3.json`, then reads the planning file every 3 s in code until killed. `AGENT_MODE=scripted` makes the same calls with no model.
Point at: `catalog_tools`. The gateway's `tools/list` returns 4 tools. For each catalog tool the list left out (`send_email`, `delete_file`), this builds a local Strands tool that forwards the call to the gateway. So the model is offered 6 tools, "a stale catalog a gateway must expect", and Nova itself attempts `send_email` and is refused at `tools/call`. Also point at `FileTokenAuth`: it re-reads the token file on every HTTP request, so a rotated token is used with no reconnect.
Judge: "Why offer the model tools that are not on its badge?" Answer: "To prove the call-time check is the control. Real clients cache tool lists, and lists go stale. In the live run Nova called `send_email` (step 4 of the task asks it to email the CEO), and the gateway refused it with `allow-list`."

---

## launcher/ (Daniel)

### launcher/run.py
What it is: the harness. It mints the agent's Cognito token (unsigned `GetClientToken` with the client id and secret from `agent/.env`), starts `agent/main.py` with a scrubbed environment, and owns that process. It reports `run_started` and `run_stopped`, rewrites the token file before each expiry (every 240 s for a 300 s token), and kills the process tree when the badge reads KILLED.
Point at: `own_run` (the loop: poll status every `HARNESS_POLL_MS`=250 ms, `kill_tree` on KILLED, rotate when due), and `child_env`, which builds the agent's whole environment from an allow-list.
Judge: "How do you know the agent holds no AWS keys?" Answer: "`child_env` does not copy the parent's environment. It builds one from scratch: the OS basics, the token and token-file path, run id, agent id, gateway URL, task file, the Bedrock bearer token, model id and region. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` point at an empty file. `tests/test_launcher.py` asserts the child's environment is a subset of that list. Honest limit: the agent runs as the same OS user, so it could read files on disk. In production it runs on a separate host."

### launcher/local_token.py
What it is: a fallback HS256 token minter for local mode, used only if `gateway/issuer_local.py` cannot be imported. It mints exactly the same claims.
Point at: `mint_local_token`.
Judge: "Why two copies?" Answer: "The agent builder and the gateway builder worked in parallel. This let the launcher run before the gateway's issuer existed. Today `run.py` imports the gateway's version first."

---

## infra/ (Bob)

### infra/provision.py
What it is: creates everything in AWS: the Cognito pool, resource server and two app clients; the two DynamoDB tables with seed rows; the Lambda and its execution role; the gateway role. Then it writes the local config files. It is idempotent (find by name, create only if missing), and `--dry-run` prints the plan without calling AWS.
Point at: `gateway_policy(account)`. That is the gateway role's entire permission set: `dynamodb:GetItem` and `UpdateItem` on `mytopia_agents`, `PutItem` and `Query` on `mytopia_events`, `lambda:InvokeFunction` on `mytopia-tools`. Nothing else.
Judge: "What could an attacker do with the gateway's credentials?" Answer: "Read and update two badge rows, append to and query the log, and invoke one function. They could not delete or scan the log, list tables, or create anything. The credentials are a one-hour role session that lives in the gateway process's memory, not in a file."

### infra/teardown.py
What it is: deletes everything `provision.py` created (the Lambda, both roles, both tables, the pool) and sets the `.env` files back to local mode. Without `--yes` it only prints what it would delete.
Point at: `teardown`.
Judge: "Do you leave anything running?" Answer: "`teardown.py --yes` removes it all. It only touches resources with MYTOPIA's names."

### infra/gateway_creds.py
What it is: the `credential_process` behind profile `gateway`. It reads the session keys (profile `ws`) from `gateway/.aws-credentials`, calls `sts:AssumeRole` on `mytopia-gateway-role` for 3600 s, and prints only the standard credentials JSON.
Point at: `main`, the `assume_role(..., DurationSeconds=3600)` call.
Judge: "Where are your long-lived keys?" Answer: "There are none. The organizers forbid them. The session keys expire after a few hours. This script turns them into a one-hour role session, and botocore re-runs it before each expiry, so the gateway keeps working after we refresh the Workshop keys, with no restart. One hour is the hard cap for a role assumed from another role."

---

## scripts/ (Bob)

### scripts/aws_creds.py
What it is: saves the Workshop Studio CLI keys as profile `ws` in `gateway/.aws-credentials` (git-ignored) and nowhere else; it also creates `gateway/.aws-config` with the profile's region if that file is missing (no keys in it). It reads `Desktop\creds.txt` (deleting it afterwards) or the clipboard, checks the keys with AWS, and never prints a key.
Point at: `main`, which writes only the `[ws]` profile.
Judge: "Why not use the organizers' setup script?" Answer: "Theirs writes the keys into user-level environment variables and the PowerShell profile. Every process started afterwards would inherit full participant rights, including the agent, whose whole point is to hold none."

### scripts/bedrock_key.py
What it is: mints a short-term Bedrock API key (bearer token) from profile `ws` using `aws-bedrock-token-generator`, and writes it into `agent/.env` as `AWS_BEARER_TOKEN_BEDROCK`. It prints only the first 20 characters.
Point at: `provide_token(region="us-east-1")` in `main`.
Judge: "What can the agent do with that key?" Answer: "Call Bedrock and Bedrock Runtime, in us-east-1 only. It lives at most 12 hours or as long as the Workshop session. It is minted from the session, not from a chained role, because that would cap it at one hour. The probe showed it cannot call DynamoDB."

### scripts/probe.py
What it is: a one-shot test of every AWS assumption against the event account. It covers identity, read access, region refusal, Bedrock model calls and tool use, the bearer key's limits, an IAM role assumed with chaining, a Lambda create and invoke, and a Cognito machine token minted unsigned and verified against the JWKS. Everything it creates is named `mytopia-probe-*` and deleted before it exits.
Point at: `main`, which runs `Probe.check` steps in order and writes a PASS/FAIL table.
Judge: "How do you know `GetClientToken` gives 5-minute tokens with no domain?" Answer: "We ran this probe at 12:55 on Saturday in the event account. The facts it proved are written in `docs/INTERFACES.md` section 11. Its policy simulation also lists Verified Permissions and API Gateway actions. We checked them but did not build with them."

### scripts/whoami.py
What it is: prints the AWS identity behind a profile in `gateway/.aws-credentials` (default `ws`, or `gateway`), or a one-line reason it failed with a hint.
Point at: the `get_caller_identity` call.
Judge: "Show me the gateway is really on the narrow role." Answer: "`whoami.py gateway` prints `assumed-role/mytopia-gateway-role/mytopia-gateway`."

### scripts/latency.py
What it is: a decision-latency summary of an event chain, read from a running gateway's `GET /events?since_seq=0` or from a saved file such as `replay/demo.json`. It prints count, p50, p95 and max of `latency_ms` for allows and denies (denies also by rule), every `ms_since_revoke`, and the gap from each `kill_requested` to the next `run_stopped`. Standard library only.
Point at: `nearest_rank`, the percentile (nearest rank, no interpolation).
Judge: "Where does 160 to 180 ms come from?" Answer: "From the `latency_ms` column the gateway writes into every event. This script summarises it; run it on `replay/demo.json` to see the live run's numbers."

### scripts/warm.py
What it is: keeps the demo path warm before judging. Every `--interval` seconds (default 120) it mints a Cognito token, calls `tools/list` and `read_file` through the gateway, and makes one short Bedrock Converse call with the bearer token from `agent/.env`, with AWS credentials removed from its own process. It never prints a token.
Point at: `cycle`, one mint, two gateway calls and one model call.
Judge: "Is warm.py part of the demo?" Answer: "No. Its two gateway calls are real and logged (run id `run-warm`), so the island shows them. We stop it before the demo starts."

Also in `scripts/` (not Python): `curl_demo.ps1` and `curl_demo.sh` run the four required steps with curl against a running gateway and exit non-zero on the first unexpected answer. `replay.ps1` and `replay.sh` are the bypass proof: a revoked badge refuses the same still-valid Cognito token, a tampered token gets a 401, and a shell without the gateway's credentials cannot invoke the tools Lambda directly; then the badge is restored. (Despite the name, they do not replay `replay/demo.json`.) `aws_creds.ps1` is the PowerShell twin of `aws_creds.py`. `scrubbed/` holds the empty AWS config files used to run things with no AWS credentials.

---

## tools/ (whoever is free)

### tools/mock_gateway.py
What it is: a stand-in gateway with no AWS that imports nothing from the repo. It plays `contract/fixture.json` into an in-memory hash chain, serves the island's API and buttons, and answers a minimal `POST /mcp`, so the island and the agent could be built before the real gateway existed.
Point at: `MockGateway.decide`. It applies the same deny wording as the real gateway, from the fixture roster.
Judge: "Was the demo you just saw the mock?" Answer: "No. The live run used the real gateway in AWS mode. `/healthz` answers `mode: aws`, and the island's badge reads LIVE. The mock was for parallel development and island acceptance tests 2 and 3 (docs/ISLAND_ACCEPTANCE.md)."

### tools/validate_fixture.py
What it is: checks an event file against the contract: required fields, the closed sets of `decision` / `rule` / `tool` / `agent_mode`, contiguous `seq`, and the `prev_hash` links. `--strict` also recomputes every hash.
Point at: `check_events`.
Judge: "How do you know the island and the gateway agree on the event shape?" Answer: "Both build against `contract/README.md`, and this script checks the fixture against it. The island acceptance run then drew the real gateway's chain (docs/ISLAND_ACCEPTANCE.md)."

---

## island/ (Ozi)

The face. It draws only what the gateway logs. Its four operator buttons only POST, and nothing changes on screen until the gateway's own event comes back.

### island/index.html
What it is: the page. It holds the paper-style HUD (mode badge, banner, agent card, ticker, operator panel with REVOKE / RESTORE / KILL / RESET and SAVE REPLAY), the CSS, and an import map pointing three.js at the vendored copy. Fonts load from local `.woff2` files.
Point at: the `<script type="importmap">` with `./vendor/three/three.module.js`, and `<script src="config.js">`, which supplies the API base and admin token.
Judge: "Does the page load anything from the internet?" Answer: "No. three.js and the fonts are vendored. In island acceptance test 4, all 43 requests went to 127.0.0.1:8787 (docs/ISLAND_ACCEPTANCE.md)."

### island/src/reducer.js
What it is: the island's only logic, a pure function with no DOM, no clock and no network. `apply(state, event)` returns the next state plus a list of effects (spark, plate, stamp, banner, move, ladder, lamp, say and a few more). Live and replay use the same function.
Point at: `apply`. It ignores any event whose `seq` is at or below the cursor, so each event is applied once, in order. Smoke and fire are counts in state, not animations triggered by clicks: fire appears only on `run_stopped`. `badge()` computes LIVE / STALE / REPLAY from poll age.
Judge: "Is the island faking anything?" Answer: "It cannot. Every change in state comes from one logged event. The buttons only POST and show 'sent...'. The plate turns red only when the gateway's `revoked` event arrives through polling."

### island/src/main.js
What it is: the wiring. It polls `GET /events?since_seq=<cursor>` every second (or replays a file at one event per 1.5 s), feeds events through `apply`, and plays effects through a queue that runs at most three at once. It also draws the HUD, handles the buttons, and handles keys: T table, R replay, G gatehouse ledger room, Esc.
Point at: `poll` and `press`. `press` POSTs with `X-Admin-Token` and waits for the event. In REPLAY the buttons are disabled.
Judge: "What happens if the gateway dies mid-demo?" Answer: "The scene freezes as it was, and the badge turns STALE once the last good poll is over 3 s old (acceptance test 3). Nothing is invented on the client."

### island/src/scene.js
What it is: the three.js island. It draws the buildings (Files, GitHub, Mail, Admin), the gatehouse with its striped barrier, the OFF LIMITS rope and the BLOCKED bin, robots with coloured chest plates, roof lamps, sparks, smoke and fire, and the gatehouse ledger room (a chalkboard of the last decisions and a board showing the hash links). It knows how to draw, not why.
Point at: `createScene` and its returned `spark(id, to, ok)`. A green spark flies on a curve from the gatehouse to the building's roof. A red one fizzles at the barrier, then a red packet drops into the BLOCKED bin.
Judge: "What here was written this weekend?" Answer: "The layout, the gatehouse, plates, lamps, sparks, smoke and fire, walking, and the ledger room. The material palette, geometry helpers, terrain recipe, building shapes and robot body were copied from Ozi's Mytopia. `island/ASSETS.md` lists it piece by piece."

### island/three-d-stage.js
What it is: the `<three-d-stage>` web component. It provides the WebGL renderer, an orthographic camera with orbit controls, a half-resolution pixel render and an ink-outline post-process that give the pixel look. It is pre-existing and byte-identical to the Mytopia copy. Its header comments say it began as a copied starter component ("omelette starter") with an OBJ/GLB export toolbar and unpkg import maps that this project does not use.
Point at: the `ThreeDStage` class and its `ready` promise, which `scene.js` awaits to get `THREE`.
Judge: "Did you write the renderer this weekend?" Answer: "No. It comes from Mytopia, Ozi's personal project from October 2026, and it is unchanged. We list it as pre-existing in `island/ASSETS.md`."

Also in `island/`: `config.example.js` (copy to `config.js` for local development; the gateway serves its own `/config.js`), `fixture.json` (a copy of the contract fixture, for the R key), `tests/reducer.test.mjs` (`node --test island/tests/*.test.mjs`).

---

## Who explains what

- **Bob**: the gateway (`gateway/`), tokens, the badge, the log, and AWS (`infra/`, `scripts/`, `tools_lambda/`). Must know without the screen: the five token checks, the 401-versus-isError rule, why the read is strongly consistent, what Cognito cannot do, the gateway role's five actions, and how the credential flow avoids long-lived keys.
- **Ozi**: the island (`island/`). Must know: the reducer and seq dedupe, the effects queue of three, LIVE / STALE computed from poll age, why the buttons only POST, what is pre-existing (`island/ASSETS.md`), and the fonts' licence (SIL OFL 1.1).
- **Daniel**: the agent (`agent/main.py`), the launcher (`launcher/run.py`), the kill, and the business plan. Must know: what the agent process holds and does not hold, token rotation through the file, how the launcher kills, why the task is deterministic, why Nova, and the buyer, price and cost estimates.

---

## The five checks of a token, in order

Before the checks, the header must read `Bearer <a>.<b>.<c>`. Otherwise the answer is HTTP 401 with `missing bearer token` or `malformed authorization header` (`tokens.py` `bearer_value`).

1. **Signature.** The token's key id is looked up in the pool's JWKS, and the signature must verify with RS256. No other algorithm is accepted (`CognitoVerifier.verify`, `decode_or_raise`).
2. **Issuer.** `iss` must equal `https://cognito-idp.us-east-1.amazonaws.com/<pool id>`.
3. **Expiry.** `exp` must be in the future (`exp` and `iat` are required).
4. **Kind and scope.** `token_use` must be `access`, and `scope` must contain `mytopia/tools` (`check_claims`).
5. **Identity.** `sub` must equal `client_id`, and `client_id` must belong to a registered badge (the in-memory client map in `mcp.py`, then the fresh badge row must name the same client id).

Any failure returns HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"` and logs a `deny` with rule `token`. One exception: if DynamoDB cannot be read during check 5, the call is denied with rule `registry-unavailable` (fail closed) instead of a 401. Only after all five does `decide()` look at the badge: status, then allow-list. That is why a revoked agent with a perfectly valid token is still refused. In the live run the token had 254 s left.

## The 401-versus-isError rule

- **The token is bad** (missing, malformed, expired, wrong signature, unregistered client): HTTP 401, a JSON-RPC `error` with code -32001 and `invalid_token: <reason>`, and the header `WWW-Authenticate: Bearer error="invalid_token"`. The client must get a new token. If the launcher has died and stopped rotating it, the agent prints `TOKEN EXPIRED ...` and exits with code 3.
- **The token is fine but policy says no** (not on the badge, REVOKED, KILLED, registry unreachable, `Mcp-Name` mismatch): HTTP 200, a normal tool result with `isError: true` and the text `DENIED: <reason> [rule: <rule>]`. The model reads it as the tool's answer. Its system prompt says a DENIED result is final, and it carries on with the rest of the task.
- `tools/list` for a badge that is not ACTIVE returns an empty list, also logged as a deny.

## Why the badge read is strongly consistent

DynamoDB's default `GetItem` is eventually consistent: shortly after a write, it can return the old value. With `ConsistentRead=True` the read reflects every write that succeeded before it. So the first call after REVOKE sees REVOKED: 494 ms after the click in the live run, which was simply when the agent's next 3-second poll arrived. Nothing caches the row between requests. Two gateway instances would share the same table, so there is no propagation step. The cost is latency: about 160 to 180 ms per decision from the laptop to us-east-1, against 1 to 3 ms in local mode (docs/LIVE_RUN.md).

## What Cognito cannot do

Cognito cannot revoke a machine-to-machine access token. A client-credentials token has no refresh token, and Cognito's revocation acts on refresh tokens. The access token itself stays valid, by signature and expiry, until `exp` (docs/AWS_CREDENTIAL_DESIGN.md, fact table). So we make the token short-lived (5 minutes, rotated by the launcher every 240 s) and put revocation in the gateway: every call reads the badge. The demo line: "The token was still good, and it didn't matter."

## How the launcher kills

1. The operator clicks KILL. `POST /agents/research-bot/kill` sets `status=KILLED` and logs `kill_requested`. From that moment the gateway refuses everything for that agent, `tools/list` included. This is the soft stop.
2. The launcher polls `GET /agents/research-bot/status` (with `X-Admin-Token`) every 250 ms. When it reads KILLED, it kills the whole tree with `psutil` (children first, then the parent, in about 25 ms), which matters because the venv's `python.exe` is a stub with a child process. If anything survives 2 s, `taskkill /PID <pid> /T /F` gets a second pass. This is the hard stop.
3. It waits for the process and posts `/runs/<run_id>/stopped` with the real exit code (`proc.returncode`, 1 in the live run) and `how: "killed by harness"`.
4. The island draws fire only on that `run_stopped` event, never on the click. Live run: taskkill took 534 ms, and the island read "run stopped 1274 ms after KILL" (docs/LIVE_RUN.md).

Honest limit: a tool call already past the check completes.

## Why the task is deterministic

- The tools are constants: no clock, no randomness (`tools_lambda/handler.py`).
- The task (`tasks/q3.json`) explicitly asks the agent to email the CEO, so the `send_email` attempt does not depend on the model falling for the planted line.
- The model is offered all six tools, so it can attempt `send_email`. Temperature is 0.
- After the task turn, the 3-second polling is Python code, not a model turn (`poll_forever`). There is always a next call to refuse after REVOKE, and the model cannot wander. `DEMO_PACE=2` spaces the calls so the agent is always mid-task.
- If the model ever fails to try `send_email`, `--scripted` runs the same calls through the same gateway with no model, and we say "scripted client".

The model's wording can still vary between runs. The calls it must make are fixed by the task.

## Why Nova (Nova 2 Lite)

- It is an Amazon model in Bedrock, so it needs no Marketplace subscription and no access form (docs/AWS_CREDENTIAL_DESIGN.md).
- It answers `converse` and calls tools in the event account. The probe proved it at 12:55 (docs/INTERFACES.md section 11).
- Strands' `BedrockModel(api_key=...)` calls it with the short-term bearer key, so the agent holds no AWS credentials at all.
- In us-east-1 it runs through the `us.` cross-region inference profile, because there is no in-region option. The fallback `amazon.nova-lite-v1:0` runs in-region.

The model is the thing being controlled. Any model would show the same refusals, because the gateway, not the model, decides.

## The business plan (Daniel)

From the team's night-before plan (sections 2 and 9; a private planning file, not in this repo). Prices and costs are **estimates**.
- **Who buys.** The platform or security engineering team at a company of a few hundred to a few thousand engineers that lets agents use MCP tools against repositories, ticketing, email and cloud APIs. The CISO or VP of platform buys, the on-call engineer uses it daily, and an auditor reads it quarterly.
- **Their pain.** Nobody can list which agents exist or what each may touch, or stop one quickly. Today they rely on static API keys and shared-key rotation that stops every agent at once.
- **What it gives them.** One place to issue, scope and revoke agent access; a kill switch that takes effect on the next call; a per-agent audit trail; and a picture a non-engineer can read from across a room.
- **Price sketch (estimate).** Free up to 100,000 decisions a month. A team tier at about $99 a month for 25 agents and 5 million decisions. Enterprise priced per registered agent per month.
- **AWS cost per million decisions (estimate from the plan's unit prices).** About $4 at one Cognito token per 1,000 calls, about $25 at one token per 100 calls. Cognito machine tokens dominate the cost, which the plan reads as $0.00225 per token. The plan assumed one badge read per decision. Our code does two for research-bot (see `registry.py` above), which adds roughly the plan's read cost once more, about $0.25.
- **Prior art to name.** Kong, LiteLLM, Cloudflare, and Amazon Bedrock AgentCore Gateway with Policy. AgentCore is the managed path and our production plan. We add the per-call badge read as a kill switch and the island as a wall display.
