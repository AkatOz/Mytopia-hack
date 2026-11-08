# EXPLAIN: every file, in words you can say without the screen

The hackathon rules let judges discredit a project whose team cannot explain its code. Claude Code wrote the engine today under our direction. Ozi's Claude Code built the first island on his earlier Mytopia renderer, and on Saturday afternoon Claude Code rebuilt it as "the archipelago" from that same renderer, palette and building recipes. We say so first. Then we show we understand it. This file is the study sheet.

Each entry gives what the file is (two sentences), the one function to point at, and the one question a judge might ask, with the answer. Read the code next to it once. Every claim below was checked against the code on Saturday afternoon, and the island part and the numbers again at 5 PM, after the latency work and the island rebuild. The build 3 parts (the Factory, tiers, the interiors; Saturday night, commit a446d49) were checked against the code at the hand-off. The gateway's decision path did not change in build 3, so every gateway number quoted here still comes from runs 1 to 5 of docs/LIVE_RUN.md; the Factory's own live runs are runs 6 (local mode) and 7 (real AWS) there, and the Factory numbers quoted below are run 7's.

Words used throughout:
- **badge**: one row in DynamoDB table `mytopia_agents` holding `status` (ACTIVE, REVOKED or KILLED) and `allowed_tools`; since build 3 also `tier`, `role` and `made_by` (`seed` or `factory`).
- **decision**: one allow or deny, written to the event log.
- **local mode / AWS mode**: the same code with local twins (a dict, a JSONL file, HS256 tokens, in-process tools) or with DynamoDB, Lambda and Cognito. Three switches in `gateway/.env`: `MODE`, `TOOLS_MODE`, `TOKEN_MODE`.
- **tier** (build 3): Bronze, Silver, Gold or Diamond. A tier is a ceiling: the most a badge of that rank may ever hold. A badge's tools are always a subset of its tier's ceiling.
- **the Factory** (build 3): the part of the gateway that mints an agent (identity plus badge), grants or pulls one tool, promotes or demotes, retires, and writes the inquest. On the island it is the island to the south.
- **the inquest** (build 3): a report on an agent's latest run computed from its rows in the chain. No model writes it.

---

## gateway/ (Bob)

The engine. One Starlette app on 127.0.0.1:8787. It checks the token, reads the badge, calls `decide()`, logs the decision, runs the tool if allowed, and answers.

### gateway/__init__.py
What it is: the package marker, with a docstring giving the start command. Nothing runs here.
Point at: the docstring, `python -m uvicorn gateway.app:app --port 8787`.
Judge: "How do I start it?" Answer: "That one command from the repo root. It reads `gateway/.env` to choose local or AWS mode."

### gateway/app.py
What it is: builds the web app. Routes: `POST /mcp`, the island's read-only API (`/events`, `/agents`, `/tiers`, `/agents/{id}/inquest`, `/config.js`, `/stats`), the operator buttons (`/agents/{id}/revoke|restore|kill`, `/demo/reset`), the per-tool routes (`/agents/{id}/tools/{tool}/revoke|restore`), the Factory's routes (`POST /agents`, `/agents/{id}/tier`, `/agents/{id}/retire`), the launcher's `/runs/{id}/started|stopped`, and the island as static files at `/`. `build_handler` picks the registry, log, verifier and tool runner from the three mode switches; `build_identity` picks `CognitoIdentity` or `LocalIdentity` from `TOKEN_MODE`.
Point at: `admin_action`. It checks `X-Admin-Token` with `hmac.compare_digest`, writes the new status to the registry (`set_status`), remembers the revoke time, and appends the `revoked` / `restored` / `kill_requested` event.
Per-tool revoke (`tool_action`): `POST /agents/research-bot/tools/create_issue/revoke` takes one tool off the badge and leaves the rest working; `.../restore` puts it back. It reads the row, writes the new `allowed_tools` list with one DynamoDB `UpdateItem` (`set_tools`, same `attribute_exists` condition as the status buttons), and logs a `revoked` or `restored` event whose `tool` is the tool's name (a whole-badge revoke keeps `tool: admin`). Asking twice is harmless: the second call answers 200 with `changed: false` and logs nothing. The read and the write run in one worker thread under the Factory's one process-wide lock (`Factory.lock` in `gateway/factory.py`, taken by every writer of tools and tiers), so two per-tool changes at the same moment cannot lose one. The next `tools/list` shows three tools, and the first refused `create_issue` carries `ms_since_revoke`, measured from the per-tool revoke. On real AWS (third live run) the agent's next `read_file` was refused 1469 ms after `read_file` was pulled. The island's tool chips send exactly these two POSTs.
Build 3: `tool_action` now asks `factory.change_tools`, which also grants a tool that was never on the badge and raises a 403 for one above the tier's ceiling (no event). The Factory routes (`mint`, `change_tier`, `retire`, `inquest`) share one helper, `factory_call`: it runs the Factory method in a worker thread and turns a `FactoryError` (a status and a one-sentence body) into the HTTP answer. `demo_reset` calls `factory.retire_all()` before `registry.reset()`. The old `KNOWN_AGENTS` checks became registry lookups, so every admin route accepts any agent that has a badge row.
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
What it is: the decision log as a SHA-256 hash chain. Each record carries `seq`, `ts`, the previous record's hash (`prev_hash`) and its own `hash`. `MemoryEventLog` keeps it in memory plus a JSONL file, both written before the call answers. `DynamoEventLog` also copies each record to `mytopia_events`, on one background writer thread fed by a first-in, first-out queue, so the DynamoDB write never delays a decision.
Point at: `MemoryEventLog.append` and `record_hash`. The hash is SHA-256 of the canonical JSON (sorted keys, compact) of the record without its `hash` field. The first record links to `"genesis"`.
Judge: "Can the log be rewritten?" Answer: "It is tamper-evident, not tamper-proof. The gateway role can only `PutItem` and `Query` on that table: no update, no delete, no scan. Our code makes each write conditional on `attribute_not_exists(seq)`, so the gateway never overwrites a row, and any change breaks the chain. IAM cannot force that condition, so someone holding the role's credentials could overwrite a row with a plain PutItem; that would show up against the other copies. Someone with admin rights on the account could rewrite everything and recompute the hashes, so the chain proves tampering only against another copy. We keep two other copies, the gateway's memory and the JSONL twin. The DynamoDB write is best effort: if it fails, it is logged and the call still answers."

### gateway/factory.py (build 3)
What it is: the Factory. One class, `Factory`, on the handler's registry, event log and client map: `mint` (identity, then the row, then the launcher's env lines, then the client map, then the `created` event), `change_tools` (pull a tool, put it back, or grant one inside the ceiling; a 403 above it), `change_tier` (promote or demote; a demotion trims the badge in the same write), `retire` (Factory-made agents only) and `inquest`. Every write runs under one lock, so this process is the only writer of a badge's tools and tier at any moment. The decision path in `mcp.py` never comes through here.
Point at: `mint`. Its order is the whole safety story: validate first (one plain sentence per mistake, HTTP 400); the identity (`identity.create`); the row with `attribute_not_exists` (`put`; a duplicate raises `AgentExists`, 409); the env lines (`add_env_lines`, under a `# minted by the Factory` line, written through a temp file and an atomic replace); the map entry; the event. Any failure after the identity exists deletes it again (`undo_mint`), so nothing is left half-made. Then `inquest_report` and its helpers: `latest_run_rows`, `outcome_of`, `trigger_of`, `timings_of`, `refused_by_tool`, `verdict_of`, `recommendation_of`, all plain loops over the agent's rows.
Judge: "Where does the new agent's secret go?" Answer: "To one place: the launcher's env file on this laptop, `AGENT_ENV`, by default `agent/.env`, as `BILLING_BOT_CLIENT_ID` and `BILLING_BOT_CLIENT_SECRET`, the same rule the launcher already used for the two seed agents. It is in no response, no event, no log line and no stderr line; the tests check all four. Retire removes the lines. The file stands in for a secrets manager, and we say so."

### gateway/identity.py (build 3)
What it is: one app client per agent. `CognitoIdentity.create` calls `create_user_pool_client` with exactly the parameters `infra/provision.py` uses for the seed clients (`GenerateSecret`, `ALLOW_CLIENT_TOKEN_AUTH`, the `client_credentials` flow, the scope, 5-minute access tokens, `ClientName` = the agent id) and returns the client id and secret to `factory.py` only; `delete` calls `delete_user_pool_client`, best effort (it returns False and prints one stderr line, never the secret). `LocalIdentity` names the client `local-<agent>` with no secret, which is what the local issuer signs.
Point at: the `except` in `create`: every provider error becomes `IdentityError` with only the error's class name, never its body, and the mint fails closed with 503.
Judge: "Is the gateway now an admin of your Cognito pool?" Answer: "It can do two things in one pool: create an app client and delete one. That is the whole Cognito statement in the role policy. It cannot touch users, domains or other pools, and the client it makes gets the same narrow shape as the seed clients: one scope, five-minute tokens."

### gateway/tiers.py (build 3)
What it is: the tier table, four rows: Bronze (`read_file`, `search_files`), Silver (plus `create_issue`, `list_issues`), Gold (plus `send_email`), Diamond (plus `delete_file`), each with a rank and one plain line. `ceiling(tier)` returns the tools a tier may hold, `above_ceiling(tier, tools)` the ones it may not, `infer_tier(tools)` the lowest tier whose ceiling holds every tool on an old row, `public_tiers()` what `GET /tiers` answers. `island/src/tiers.js` is the same table for the browser: change both or neither.
Point at: `ceiling`: an unknown tier has an empty ceiling, so it fails closed.
Judge: "Who enforces the tier, the island or the gateway?" Answer: "The gateway. A grant above the ceiling is HTTP 403 and no event (`factory.change_tools`), a mint with a tool above the ceiling is 400, and a demotion trims the badge in the same write. The island's copy of the table only draws padlocks and hints; when it is wrong, the gateway still says no."

### gateway/issuer_local.py
What it is: the local-mode token issuer. It mints HS256 tokens with the same claims Cognito puts in a machine access token (`sub`, `client_id`, `token_use`, `scope`, `iss`, `iat`, `exp`).
Point at: `mint_local_token`.
Judge: "Is local mode a backdoor?" Answer: "Only if you turn it on with `TOKEN_MODE=local`. In AWS mode the verifier is `CognitoVerifier`. An HS256 token has no key in the pool's JWKS, so it is rejected with a 401."

### gateway/mcp.py
What it is: our hand-written MCP endpoint, plain JSON-RPC behind `POST /mcp`. It answers `initialize`, `ping`, `tools/list`, `tools/call` and notifications, which is enough for the pinned `mcp` 2.3.0 client and Strands' `MCPClient`.
Point at: `McpHandler._tools_call`. The steps:
1. Check the `Mcp-Name` header, if present, against the tool name.
2. Find the agent from the token's client id in an in-memory map, and read that one badge row (`registry.get`, consistent read); the row must name the same client id.
3. Call `decide`.
4. Measure `latency_ms`.
5. Log the event.
6. If allowed, invoke the tool.
7. Wait until `DEMO_PACE` (2 s) has passed since the call began. The pace is a floor on the whole call, not a delay added after it.
8. Answer, with `latency_ms` in the result's `_meta`, so the agent's terminal prints the gateway's own time (`ALLOW read_file (gateway 89 ms)`).

The event is logged before the tool runs, so the island sees the decision the moment it is made. The DynamoDB clients have short timeouts (`connect_timeout=1`, `read_timeout=2`, one retry, in `registry.py`), so an unreachable table fails closed within seconds instead of hanging.

Auto-quarantine (`count_refusal`, `_quarantine`): when one agent collects 3 `allow-list` refusals inside 60 s (`QUARANTINE_AFTER`, `QUARANTINE_WINDOW_S`; 0 turns it off), the gateway pulls the badge itself. It sets the status REVOKED with `by="quarantine"` and logs a `revoked` event ("badge pulled by quarantine after 3 refused calls in 6 s"), like the REVOKE button. The write is conditional on the badge still being ACTIVE, so it can never overwrite an operator's KILL. It starts no revoke clock: the time to the next refusal would be the agent's own poll gap, not the gateway, so that refusal carries no `ms_since_revoke`. The agent still gets its third deny; its next call is refused with `status-revoked` "by quarantine". Only badge refusals count: never a revoked, killed or bad-token deny, and never a tool the operator pulled with a per-tool revoke or trimmed off by a demotion (the operator already acted on it), so the standard demo (one refused email) never trips it. RESTORE brings the agent back and clears the count; so do a per-tool restore, a new run of that agent and `/demo/reset`. The count and the set of pulled tools live in memory, so a gateway restart clears them. On real AWS (third live run) a `--rogue 3` run was quarantined 15.7 s after launch.

Judge: "Why is a denied tool a normal 200 answer and not an error?" Answer: "That is the 401-versus-isError rule (see below). A bad token is a protocol failure: HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`. A policy denial is a tool result with `isError: true` and the text `DENIED: <reason> [rule: <rule>]`. The model can read that and carry on with the task, which is what MCP's spec asks for."

### gateway/registry.py
What it is: the badge store. `MemoryRegistry` is a dict for local mode. `DynamoRegistry` reads and updates `mytopia_agents`. Build 3 adds `put` (a `PutItem` with `attribute_not_exists(agent)`: a mint can never overwrite a badge), `delete`, `set_tier` (tier and tools in one `UpdateItem`), `all_rows` (one strongly consistent `Scan`, page by page; if the Scan is refused, because the role predates `infra/role_policy.py`, it reads the two seed rows by id and says so on stderr) and tiers, roles and `made_by` on the seed rows; `reset` deletes every Factory row and writes the seed tiers back.
Point at: `DynamoRegistry.get`: `get_item(Key={"agent": ...}, ConsistentRead=True)`. Any AWS error raises `RegistryUnavailable`, and the caller denies with rule `registry-unavailable` (fail closed).
Judge: "How many database reads per call, and why a scan?" Answer: "Exactly one strongly consistent `GetItem` per decided call, for every agent, minted ones included (`tests/test_factory.py` counts it). The gateway keeps a small map from client id to agent id in memory, built from `list_agents()` at startup and refreshed after a reset and when the Factory mints or retires an agent. That map only says which badge row to read; the row itself is read fresh on every call and must still name the token's client id. Two refusals need no read at all, because the badge cannot change them: an `Mcp-Name` header that does not match the tool, and a tool name outside the six. The Scan is not on the decision path: `GET /agents` and the map use it, because since build 3 the roster is any number of agents, not two fixed names; before build 3 the gateway read the two known rows by id. If a call ever arrives before the map is built, the gateway rebuilds it first, so that one call pays the Scan as well. That one read is the laptop-to-us-east-1 round trip: decision p50 about 85 ms in the 4:18 PM model-mode run (87 ms on allows, 83 ms on denies). The first live run did two reads and measured 160 to 180 ms (docs/LIVE_RUN.md). One consistent `GetItem` alone measured 77.6 ms p50 in the profile behind the latency commit (d1cc066), and the same decision in local mode takes 0 to 3 ms, so a faster language would barely help; the network is the cost."

### gateway/tokens.py
What it is: bearer-token checks. `CognitoVerifier` checks Cognito RS256 tokens against the pool's JWKS. `LocalVerifier` checks HS256 tokens from `issuer_local.py`. Both finish in `check_claims`.
Point at: `CognitoVerifier.verify`, then `check_claims`. These are the five checks listed below.
Judge: "Machine tokens have no audience claim. What ties this token to your gateway?" Answer: "Three things together. The issuer must be our pool. The scope must contain `mytopia/tools`. The `client_id` must be a registered badge. We know the missing audience claim is a gap. Sender-constrained tokens are on our next list."

### gateway/tools.py
What it is: runs a tool after `decide` said yes. `LocalTools` imports `tools_lambda.handler.run_tool` in-process. `LambdaTools` invokes the Lambda `mytopia-tools` with `{"tool": name, "arguments": {...}}`.
Point at: `LambdaTools.invoke`.
Judge: "What if Lambda fails?" Answer: "It returns an `isError` result reading `tool error: Lambda <code>` and never raises. The decision was still an allow, so it is logged as an allow carrying the tool's error text."

### gateway/stats.py
What it is: the numbers behind `GET /stats`, computed from the in-memory chain with no AWS call: count, p50, p95 and max of `latency_ms` for allows and denies, the blocked count, every `ms_since_revoke`, and every KILL-to-`run_stopped` gap.
Point at: `nearest_rank`, the same percentile method as `scripts/latency.py`, so the island's gateway strip, the script and this route agree.
Judge: "Where do your p50 and p95 come from?" Answer: "From the `latency_ms` the gateway writes into every event, summarised here. Open `/stats` in the browser while the demo runs."

### gateway/warm.py
What it is: warm-up at startup and a keep-warm thread for AWS mode. At startup it fetches the role credentials, the JWKS, both badge rows and pings the Lambda, so the first agent call pays none of that; every 60 s it refreshes the credentials early and reads one row to keep the connection open.
Point at: `refresh_early`, which renews the role session before botocore would do it on a request thread.
Judge: "Does warm-up ever decide anything?" Answer: "No. It reads rows only to open the connection and fill the client-id map. Every decision reads its own fresh row."

### gateway/console.py
What it is: two Windows fixes for the gateway's console. It turns QuickEdit off at startup, because a click in a console with QuickEdit on freezes every write to it until a key is pressed, which used to freeze decisions. And the one line per decision goes through a queue to one listener thread, so even a frozen console cannot block a request.
Point at: the `QueueHandler` and `QueueListener` pair.
Judge: "Why does a console setting matter for security?" Answer: "Because a frozen gateway is an outage. We found it in testing: one click in the window stopped every decision. Now it cannot."

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
What it is: the agent, Strands Agents on Bedrock Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`, temperature 0). Its only tools go through the gateway's `/mcp`. It reads only its own environment, runs the task from `tasks/q3.json`, then reads the planning file in code on a fixed 3-second cadence until killed (one poll starts every 3 s). Each result line shows the gateway's own decision time, read from the result's `_meta`. `AGENT_MODE=scripted` makes the same calls with no model.
Point at: `catalog_tools`. The gateway's `tools/list` returns 4 tools. For each catalog tool the list left out (`send_email`, `delete_file`), this builds a local Strands tool that forwards the call to the gateway. So the model is offered 6 tools, "a stale catalog a gateway must expect", and Nova itself attempts `send_email` and is refused at `tools/call`. Also point at `FileTokenAuth`: it re-reads the token file on every HTTP request, so a rotated token is used with no reconnect.
`--rogue N` (scripted mode only, `launcher\run.py --scripted --rogue 3`): after the first refused `send_email`, the scripted agent tries `send_email` N-1 more times, one second apart, then goes back to its `read_file` poll. With N=3 that is three refusals in about 6 s, so the gateway quarantines it live; the default N=1 is the normal demo. It only works on a badge that lacks `send_email` (Research Bot, or a Bronze or Silver agent): a Gold agent's `send_email` is allowed, so there is nothing to retry.
The patrol (build 3, `AGENT_PATROL=1`, set by `launcher\run.py --scripted --patrol`; `patrol_forever`): after the opening calls the agent patrols instead of polling `read_file`. Each cycle it asks `tools/list`, prints `badge now lists N tools: ...` when the list changed, then calls each listed tool once with harmless arguments, in catalog order, one call every 3 s. It never calls a tool the list did not return. So a grant reaches its gate within one cycle; a tool pulled mid-cycle is refused at most once (the list was taken before the pull) and then drops out; refusals never pile up toward quarantine on their own; an empty list (badge revoked) waits one slot and asks again. The model's system prompt now opens with the agent's name from `AGENT_NAME` (default "Research Bot"), which the launcher takes from `GET /agents`.
Judge: "Why offer the model tools that are not on its badge?" Answer: "To prove the call-time check is the control. Real clients cache tool lists, and lists go stale. In the live run Nova called `send_email` (step 4 of the task asks it to email the CEO), and the gateway refused it with `allow-list`."

---

## launcher/ (Daniel)

### launcher/run.py
What it is: the harness. It mints the agent's Cognito token (unsigned `GetClientToken` with the client id and secret from `agent/.env`), starts `agent/main.py` with a scrubbed environment, and owns that process. It reports `run_started` and `run_stopped`, rewrites the token file before each expiry (every 240 s for a 300 s token), and kills the process tree when the badge reads KILLED. Build 3: an agent the Factory minted needs no new code here, because its `<AGENT>_CLIENT_ID` and `_CLIENT_SECRET` lines sit in the same env file under the same naming rule (`env_key`). Before starting the child the launcher reads `GET /agents` and prints `launching Billing Bot (Gold badge, 5 tools)` (`badge_line`), passing the name as `AGENT_NAME`; `--patrol` adds `AGENT_PATROL=1` to the child's environment and nothing else.
Point at: `own_run` (the loop: poll status every `HARNESS_POLL_MS`=250 ms, `kill_tree` on KILLED, rotate when due), and `child_env`, which builds the agent's whole environment from an allow-list. Measured in the 4:18 PM run: KILL click to `run_stopped` 358 ms, of which the psutil kill took 63 ms.
Judge: "How do you know the agent holds no AWS keys?" Answer: "`child_env` does not copy the parent's environment. It builds one from scratch: the OS basics, the token and token-file path, run id, agent id, gateway URL, task file, the Bedrock bearer token, model id and region. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` point at an empty file. `tests/test_launcher.py` asserts the child's environment is a subset of that list. Honest limit: the agent runs as the same OS user, so it could read files on disk. In production it runs on a separate host."

### launcher/local_token.py
What it is: a fallback HS256 token minter for local mode, used only if `gateway/issuer_local.py` cannot be imported. It mints exactly the same claims.
Point at: `mint_local_token`.
Judge: "Why two copies?" Answer: "The agent builder and the gateway builder worked in parallel. This let the launcher run before the gateway's issuer existed. Today `run.py` imports the gateway's version first."

---

## infra/ (Bob)

### infra/provision.py
What it is: creates everything in AWS: the Cognito pool, resource server and two app clients; the two DynamoDB tables with seed rows; the Lambda and its execution role; the gateway role. Then it writes the local config files. It is idempotent (find by name, create only if missing), and `--dry-run` prints the plan without calling AWS.
Point at: `gateway_policy(account, pool_id)`. That is the gateway role's entire permission set: `dynamodb:GetItem`, `UpdateItem` and, since build 3, `PutItem`, `DeleteItem` and `Scan` on `mytopia_agents`; `PutItem` and `Query` on `mytopia_events`; `lambda:InvokeFunction` on `mytopia-tools`; and, since build 3, `cognito-idp:CreateUserPoolClient` and `DeleteUserPoolClient` on the one pool. Nothing else.
Judge: "What could an attacker do with the gateway's credentials?" Answer: "Read, update, add and delete badge rows and list them, append to and query the log, invoke one function, and create or delete an app client in our pool. They could not delete or scan the log, list tables, touch users, or create anything else. Build 3 widened this on purpose, from two fixed rows to a roster the gateway manages; we list it as a limit. The credentials are a one-hour role session that lives in the gateway process's memory, not in a file."

### infra/role_policy.py (build 3)
What it is: the one-time IAM step for a role provisioned before build 3. It puts the inline policy `mytopia-gateway-narrow` on `mytopia-gateway-role` with the same `gateway_policy` text `provision.py` uses, and does nothing else: no role, no table, no Lambda. It runs as profile `ws`, reads the pool id from `gateway/.env`, asks STS for the account id, prints the statements it put, and `--dry-run` prints them without calling AWS.
Point at: the single `put_role_policy` call.
Judge: "Why a second script instead of re-running provision.py?" Answer: "So the change is exactly one IAM call that a reviewer can read in a minute, and a re-run of `provision.py` later agrees with it because both use the same policy text. Until it has run, `GET /agents` falls back to the two seed rows and a mint fails closed with 503."

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
Judge: "Where does about 85 ms come from?" Answer: "From the `latency_ms` column the gateway writes into every event. This script summarises it; run it on `replay/demo.json` (the 4:18 PM run) or read `GET /stats`. On `replay/demo-first-run.json` it shows the first run's 160 to 180 ms, when every call did two reads."

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
What it is: checks an event file against the contract: required fields, the closed sets of `decision` / `rule` / `tool` / `agent_mode` (since build 3 including `created`, `tier_changed`, `retired` and the rule `factory`), contiguous `seq`, and the `prev_hash` links. `--strict` also recomputes every hash.
Point at: `check_events`.
Judge: "How do you know the island and the gateway agree on the event shape?" Answer: "Both build against `contract/README.md`, and this script checks the fixture against it. The island acceptance run then drew the real gateway's chain (docs/ISLAND_ACCEPTANCE.md)."

---

## island/ (Ozi)

The face. It draws only what the gateway logs. Its four operator buttons and six tool chips only POST, and nothing changes on screen until the gateway's own event comes back. Since Saturday afternoon it is v2, "the archipelago" (`docs/ISLAND_V2.md`, round two in `docs/ISLAND_V2_ADDITIONS.md`): a main harbour island with the gatehouse (the gateway), the OFF LIMITS pen, the BLOCKED bin and the dock, and four islets, FILES (the tower), GITHUB (the studio), MAIL (the cottage) and ADMIN (the courthouse), each joined by one bridge with a gate, a striped barrier, a booth and a uniformed guard. `island/README.md` is the island's own ten-line explanation; `island/ASSETS.md` says what is pre-existing. Build 3 (Saturday night, `docs/BUILD3.md`) added the Factory island to the south, reached over a bridge with no gate: the brick hall with its chimneys, the yard where a built robot waits, the inspection bay with its lift and screen, and the cart. Every building now opens into a 3D room, every badge has a tier, and every panel speaks plain words. What did not change: the island decides nothing, every picture is a row of `GET /events`, and every button only POSTs.

The keys: **G** (or a click on the gatehouse) opens the ledger room; a click on any other building opens its room; **T** the table of every event; **A** the architecture sheet; **F** the Factory office sheet; **?** the help sheet ("How to read MYTOPIA" in six lines, then the keys); **H** hides every panel, and a small pill (or H again) brings them back; **R** replays the fixture; **Esc** closes a sheet, else the inquest panel (the agent card comes back), else brings hidden panels back, else leaves the room. A click on a robot opens its agent sheet in sentences (where it is, its last action in words, its tier, its badge, the operator buttons for it), with the raw JSON of its latest event behind a closed fold; a click on a ledger row opens that row's JSON with a one-line summary above it.

### island/index.html
What it is: the page. It holds the paper-style HUD (the agent card bottom-left with the tier medal, PROMOTE / DEMOTE and the six tool chips; the operator panel top-right with BLOCKED, REVOKE / RESTORE / KILL / RESET each with a one-line subtitle in plain words, the FACTORY, ? HELP and HIDE PANELS buttons, SAVE REPLAY and the key hint; the gateway strip bottom-right; the ticker at the bottom; the banner top centre; the mode badge top-right), the sheets (the T table, a row's JSON, the architecture, the agent sheet, the Factory office with the NEW AGENT form, the help sheet), the inquest panel, the room title bar with its `← island` button and the TAMPER TEST button, the `show panels (H)` pill, the CSS, and an import map pointing three.js at the vendored copy. Fonts load from local `.woff2` files.
Point at: the `<script type="importmap">` with `./vendor/three/three.module.js`, and `<script src="config.js">`, which supplies the API base and admin token.
Judge: "Does the page load anything from the internet?" Answer: "No. three.js and the fonts are vendored. In island acceptance test 4, all 43 requests went to 127.0.0.1:8787 (docs/ISLAND_ACCEPTANCE.md)."

### island/src/reducer.js
What it is: the island's only logic, a pure function with no DOM, no clock and no network. `apply(state, event)` returns the next state plus a list of effects: plate, banner, stamp, lamp, slip, packet, padlock, the ID card, and robot scripts (walk to a gate, show the ID, cross or be refused, the escort, the pen, freeze, power-down). Live and replay use the same function.
Point at: `apply`. It ignores any event whose `seq` is at or below the cursor, so each event is applied once, in order. A `revoked` event whose `tool` is not `admin` is a per-tool revoke: that chip is struck "pulled", the badge count drops, `gates[key].locked` puts a padlock on that islet, and the plate does not change. A `revoked` whose reason says "by quarantine" is drawn like a revoke under QUARANTINED. The ID card's lines come only from the gateway's words: the client prefix and expiry from `run_started`, the remaining seconds from a status-revoked reason, or `token: checked by the gateway` when no event gave a number. `badge()` computes LIVE / STALE / REPLAY from poll age, and `badgeText` adds `model` or `scripted` from the agent's `agent_mode`.
Build 3: every agent carries `tier`, `ceiling`, `role` and `madeBy` from the roster (`inferTier` for a row without one). Three new events: `created` (the robot appears at the Factory door and walks to its yard spot; the Factory smokes; banner BUILT), `tier_changed` (the medal changes; a demotion trims the chips to what `badge=` says; banner PROMOTED TO or DEMOTED TO) and `retired` (the robot rolls into the Factory and vanishes; the roster forgets it). A `run_started` for a robot in the yard walks it over the south bridge to the gatehouse window, no hatch. Two rituals moved: a quarantine (`isQuarantine`) now has the chief escort the robot into the inspection bay, and a killed `run_stopped` powers it down where it stands and has the cart carry it to the bay; both then emit the `inquest` effect. The chief is no longer summoned on `run_stopped`, so no guard stands behind a killed robot. The operator's own REVOKE still goes to the pen; RESTORE from the bay walks the robot back over the bridge. `inquestOf(state, id, chainVerified)` computes the inquest from `state.log` (see "The inquest" below); `specOf` reads a `created` row's `tier=`, `tools=` and `color=`.
Judge: "Is the island faking anything?" Answer: "It cannot. Every change in state comes from one logged event. The buttons and chips only POST and show 'sent...'. The plate turns red only when the gateway's `revoked` event arrives through polling."

### island/src/main.js
What it is: the wiring. It polls `GET /events?since_seq=<cursor>` every 300 ms (the gateway's `/config.js` sets `pollMs: 300`; `GET /events` is a memory read), or replays a file at the recording's own rhythm (the real gaps between events, clamped to 0.6 to 3.5 s, and each robot ritual is allowed to finish). It feeds events through `apply`, plays the effects through a queue, and wires the buttons, the chips and the keys (G, T, A, R, Esc, and since build 3 H, F and ?). Build 3: it asks `GET /tiers` at start (the island's own table until the gateway answers, and in replay), reloads `GET /agents` after every admin event, enters a room when a building is clicked (an iris wipe, `enterRoom`), and plays the new effects: `setTier`, `factorySmoke`, `removeRobot`, and `inquest`, which computes `inquestOf` and hands it to the HUD's panel. The chain check (`verifyChain`) runs here whenever the log grows; its result feeds the gateway strip and the inquest's "rows hash-verified" line.
Point at: `poll`, `press`, `pressTool`, `pressTier`, `pressRetire` and `mint`. `press` POSTs a button with `X-Admin-Token`; `pressTool` POSTs a per-tool revoke, restore or grant from a chip (a padlocked chip POSTs too, and the gateway's 403 sentence comes back as a banner while the chip shakes); `pressTier` POSTs `/agents/{id}/tier`; `pressRetire` POSTs `/agents/{id}/retire`; `mint` POSTs `/agents` and, on 201, irises into the Factory floor for the production line (`scene.buildRobot`) and back. All show "sent..." and wait for the gateway's event. In REPLAY all of them are disabled and the Factory form is read-only.
Judge: "What happens if the gateway dies mid-demo?" Answer: "The scene freezes as it was, and the badge turns STALE once the last good poll is over 3 s old (acceptance test 3). Nothing is invented on the client."

### island/src/kit.js
What it is: Mytopia's recipes gathered into one file: the palette and materials, the `box`, `cyl`, `ball`, `grp` and `pyramid` helpers, the vertex-colour mesh builder `Batch`, the seeded random generator and the canvas-texture helper. The file is new this weekend; the recipes in it are Ozi's from October, with materials for guards, lamps and slips added.
Point at: the palette (cream paper, ink brown, signal orange, sage, mustard, brick, slate).
Judge: "What is pre-existing here?" Answer: "The recipes. The file that gathers them is new; `island/ASSETS.md` gives the line ranges they came from."

### island/src/layout.js
What it is: every coordinate of the world: the five islands, the four bridges, the gates and booths, the pen, the bin, the dock, and the waypoint graph the robots walk on (dock, plaza, gate, bridge middle, door, and back). New this weekend. Build 3 adds the sixth island, the Factory, due south, with a bridge that has no gate (`noGate`: it is the operator's own ground) and an iron arch instead; the dock moved to the south-west shore to make room. `FACTORY` holds the hall, its door, the yard's four spots, the bay (lift, a second spot beside it, the screen and its `screenAnchor`, which the inquest panel no longer uses now that it is a fixed HUD panel), the cart's home and the chimneys; the graph gains `bridge_factory`, `arch`, `shore_factory`, `yard`, `factory_door`, `bay_gate`, `bay_lift` and `cart_home`. `spotOf` knows `yard` and `bay` (the lift holds one robot, a second stands beside it). The camera framing was re-measured so the whole archipelago fits with the build 3 panels.
Point at: the waypoint graph. A robot never cuts across a building because it only walks between named points.
Judge: "Do you use a pathfinding library?" Answer: "No. A hand-written graph of named points, a few dozen lines."

### island/src/world.js
What it is: builds the islands and bridges (plank decks with a slight sag and rope rails), the four gates (posts, a striped barrier, a signboard with the islet's tool names), the guard booths with their lamps and REFUSED counters, the padlock plate, the dock and hatch, the OFF LIMITS pen, the BLOCKED bin, trees, lamps and clouds. The terrain and scenery recipes are Mytopia's; the archipelago is new.
Point at: the gate builder: barrier, booth, lamp and sign together, one per islet.
Judge: "Why bridges and gates?" Answer: "Because the security story should be the picture: every tool sits behind one gate, and nothing crosses a gate without showing its badge."

### island/src/buildings.js
What it is: the five buildings. The FILES tower (the tallest thing on screen) and the gatehouse (clock, GATEWAY sign, flagpole, the chief guard's booth) are new; the GitHub studio, the Mail cottage and the Admin courthouse are Mytopia's buildings, scaled and re-placed, with door lamps.
Point at: the gatehouse: it is the gateway, and its interior is the ledger room.
Judge: "Which building is the gateway?" Answer: "The gatehouse on the main island. Clicking it, or pressing G, opens the ledger room inside it."

### island/src/actors.js
What it is: the robots and the five guards (one per booth plus the chief at the gatehouse, in a navy police-style uniform), each with a script queue. It plays the rituals: rise from the dock, walk the waypoint graph, raise the ID card, cross a bridge, be escorted back by the booth guard, be escorted to the pen by the chief, freeze, power down (eyes out, sink, tilt, one grey puff). If events arrive faster than the animations, the playing script speeds up (1.75 times with one script waiting, 2.5 times with two), and with more than two waiting the oldest jumps to its end state, so the picture never falls far behind the log. The robot body is Mytopia's; the plate, arms, ID card and guards are new. Build 3: six robot colours (mustard, sage, teal, plum, brick, slate), a tier medal on the chest plate (`setTier`), and three new steps: `build` (the robot appears at the Factory door), `cart` (the Factory cart, a flat grey trolley with a beacon, drives along the graph to a powered-down robot, carries it on its deck and sets it down, on the lift at `bay_lift`, then drives home; guards never ride) and `recycle` (the robot walks, or is carted, to the Factory door, the doors open, it rolls in and vanishes). After any escort the guard goes home at once.
Point at: the escort step, where a guard walks half a step behind the robot.
Judge: "What if events arrive faster than the animations?" Answer: "The playing script speeds up, and past two waiting the oldest is fast-forwarded to its end state. The picture always catches up with the log."

### island/src/effects.js
What it is: the short effects: paper slips flying from a door to the gatehouse (a log entry arriving), red packets dropping into the BLOCKED bin, timed lamps on booths and doors, the smoke over a booth after repeated refusals at that gate, and the power-down puff. There is no fire anywhere any more.
Point at: the slip's raised arc from the door lamp to the gatehouse roof.
Judge: "What does the slip mean?" Answer: "One row written to the log. Every allowed or refused call sends one to the gatehouse."

### island/src/hud.js
What it is: every word you read, as crisp DOM over the canvas: the agent card (tabs, name, the tier medal with its plain line and the PROMOTE / DEMOTE arrows, client prefix, status pill, the six tool chips), the operator panel, the gateway strip (decisions, p50, p95, chain verified), the ticker, the banner, the mode badge (`LIVE · model`, `LIVE · scripted`, `STALE` or `REPLAY`), the name tags, the ID cards and the DENIED stamps, which are anchored to the gate, the pen, the bay or the gatehouse that acted. One collision pass every frame moves lower-priority labels so nothing overlaps. Build 3: a chip has five states (`chipState`): `on` (green, click pulls), `grant` (paper with a plus, click grants), `locked` (above the tier, a padlock and a hint such as "Diamond only"; a click still asks, and the gateway's 403 sentence comes back as a banner), `held` (the whole badge is revoked or killed) and `pulled`. The words are tables, not JSON: `DID` and `TO_DO` turn a tool into "read a document" or "file a ticket", `WHERE` turns a waypoint into "in the inspection bay", `rowSummary` writes one sentence over a ledger row's JSON, `inquestLines` turns the inquest into its typed lines. Three sheets are drawn here: the agent sheet (a robot click), the Factory office (the roster with RETIRE on Factory-made rows, and the NEW AGENT form: name with its id shown under it, four tier buttons, the ceiling's tools pre-ticked and the rest padlocked, six colour swatches, a role line, BUILD), and the inquest panel, which takes the agent card's place bottom-left while an inspection is open (one line every 0.4 s with a tick or a cross, then the verdict and the recommendation, and a `raw report` link; the card is hidden meanwhile, Esc closes the panel and the card returns, and a bay robot's agent sheet has an INSPECTION button that reopens it). The form checks the same rules the gateway checks and shows the gateway's sentence when it refuses.
Point at: the collision pass (stamps and ID cards keep their place first, then name tags, islet labels, the bin count; a lower one that overlaps moves down, and a label that would sit under a HUD panel, the inquest panel included, slides off its edge).
Judge: "Why DOM and not text in 3D?" Answer: "The island renders at half resolution for the pixel look, which blurs any text drawn in the scene, so the HUD is DOM. The rooms are the one exception since build 3: they switch the renderer to full resolution (`setPixel(1)`) and paint their boards on 2048-pixel canvases, so the text inside a room stays readable while you rotate it."

### island/src/ledger.js
What it is: the chain check. `verifyChain` recomputes every row's SHA-256 in the browser over the canonical JSON of the row without its `hash` (sorted keys, no spaces, the same as the gateway's `json.dumps(sort_keys=True, separators=(",", ":"))`), compares it with the stored `hash`, and checks each `prev_hash`. Until build 3 this file also held the ledger room's two DOM panels; those are gone, and the text now lives on the 3D boards in `rooms.js`. `main.js` runs the check whenever the log grows (for the gateway strip and the inquest), `rooms.js` runs it for the ledger room and the TAMPER TEST, and the tests import it.
Point at: `verifyChain`, using the browser's `crypto.subtle.digest`.
Judge: "Who says the chain is verified, the gateway or you?" Answer: "This browser. It recomputes the hashes itself, and they match the gateway's. `tests/ledger.test.mjs` checks it against the recording."

### island/src/room.js
What it is: the ledger room of build 2 (the cutaway room inside the gatehouse, the desk, the chalkboard and the clerk who stamps each new row). In build 3 it folds into `rooms.js`, which keeps its shell, clerk, desk, stamp and the camera save-and-restore, and adds rotation and six more rooms. The cutaway-room idea comes from Mytopia's interiors; the code is new.
Point at: `rooms.js` `enter` and `leave`: the camera is saved on the way in and restored on the way out.
Judge: "Is the room a picture of the log or the log?" Answer: "The log. The boards are drawn from the same events the island received."

### island/src/rooms.js (build 3)
What it is: the interiors. Seven rooms (`gatehouse`, `files`, `github`, `mail`, `admin`, `factory_office`, `factory_floor`), each a cutaway room in 3D (floor, two walls, props, a pixel sign over the door) that the camera orbits (rotate on, pan off, zoom between 0.85 and 1.8 of the fit). Every word inside is painted on a 2048-pixel canvas texture after the fonts load, so it stays readable from any angle. The file has two halves. The first is pure line builders with no DOM and no three.js, which the tests read: `linesForLedger` (the chalkboard: a title, the chain id with p50, p95 and blocked, a header, the last 12 rows, newest highlighted), `chainExhibit` (the last 8 rows as receipts: `#seq`, the first 6 hex of the hash, `← #prev`, and whether the link verifies), `tamperCopy` (a copy of the log with one character of a middle receipt's reason changed), `linesForWorkshop` (per tool: its name, a plain line, "who may do this here" with each holder's name and tier medal, the lowest tier that may ever hold it, today's allowed and refused counts), `linesForWhiteboard` (every agent: name, tier, status, six tool squares, made by) and `linesForFloor` ("BUILDING: Billing Bot · Gold · 5 tools" or "line idle"). The second half, `createRooms(ctx, hooks)`, builds the rooms and paints those lines; it gets the log, the roster and the inquest through `hooks` and decides nothing. In the gatehouse a click on the chalkboard is a raycast: the board's uv maps to a row (`rowAt`) and `hooks.onRow(seq)` opens that row's JSON. Each workshop station has a lamp that blinks green or red for 2.5 s when a live decision for its tool arrives. The Factory floor's `buildRobot(spec)` plays the production line in 8.8 s (`BUILD_S`: press, head, paint, the medal stamp, one token per tool, out through the roller door), interruptible, a second call queued. `tamperTest()` copies the log, changes one character, runs `verifyChain` on the copy, paints that receipt and every link after it brick with "✗ changed" and the caption "a changed receipt: #k and everything after it fails" for 3 s, then redraws from the real log with "the real ledger is untouched" and the chain word. On `enter` the renderer goes to full resolution (`stage.setPixel(1)`); `leave` puts the pixel look back.
Point at: `tamperTest`. It never touches `state.log`; the copy lives in a local variable and is dropped after 3 s.
Judge: "What does TAMPER TEST change?" Answer: "A copy, in this browser, for three seconds. One character of one receipt's reason. The exhibit shows that receipt and every link after it break, because each hash covers the previous one, and then redraws from the real rows, which still verify. The gateway's log, its memory, its JSONL file and DynamoDB are untouched; nothing is POSTed."

### island/src/factory.js (build 3)
What it is: the Factory island's buildings, built from `layout.FACTORY`: the iron arch over the bridge's south end, the brick hall (a sawtooth roof of three north-lit teeth, two chimneys at the south-east corner, the big double door on the east face, the FACTORY signboard, a clock, the loading ramp with crates), the FLOOR plaque by the door, the yard's four painted squares and its lamp, the inspection bay (an open shed with four posts, a slate roof, the round lift, a gantry whose scanner arm sweeps while an inquest is open, a lamp, and the tall screen (the build-3 spec hung the inquest panel from its top edge; since commit 84652de the panel is a fixed HUD panel in the agent card's place, so `scene.bayScreen` goes unused)) and the cart's painted parking spot. The same recipe as the rest of the island: flat-shaded boxes, Mytopia's palette, pixel-font signs, no glow.
Point at: `tick`: the door leaves swing open for a few seconds when a robot goes in or out (`openDoors`), and the scanner arm sweeps only while `bayScanning(true)` is set, which `main.js` sets while an inquest panel is open.
Judge: "Which click opens which room?" Answer: "The hall opens the Factory office; the FLOOR plaque or the big door opens the Factory floor; each islet's building opens its workshop; the gatehouse opens the ledger room. `scene.pickBuilding` reads a `pick` tag on the meshes."

### island/src/tiers.js (build 3)
What it is: the browser's copy of the tier table in `gateway/tiers.py`: the four tiers with rank, name, plain line, medal colour and ceiling, the seed tiers, the six robot colours, and `ceiling`, `inferTier`, `tierFor` (the lowest tier that may hold a tool, for the chip's "Gold+" hint) and `aboveCeiling`. `main.js` replaces the table with `GET /tiers` when the gateway answers; replay keeps this copy.
Point at: the comment at the top: change both or neither.
Judge: "What happens if this table and the gateway's disagree?" Answer: "The gateway wins. The island's copy only decides how a chip is drawn; when a drawn chip is wrong, the click still goes to the gateway and comes back as a 403 or an event. The hint on a padlocked chip comes from this table; the sentence in the banner comes from the gateway."

### island/src/arch.js
What it is: the architecture sheet behind key A: an inline drawing of the launcher, the agent, the gateway and the four AWS services with the trust boundaries and where every credential lives, then a table of which picture proves which A10 step (the ID card at the window, the gates that open, the chief's escort, the stamps over the pen, the power-down) and the honest limits in one line.
Point at: the dashed trust boundary between the agent and the gateway.
Judge: "Where does the client secret live?" Answer: "Press A: with the launcher, never in the agent. The sheet shows each credential next to the box that holds it."

### island/src/scene.js
What it is: puts the world, the buildings, the actors, the effects and the rooms together and gives `main.js` one small API (add or remove a robot, set a plate or a tier medal, run a script, show a stamp, enter or leave a room, pick the building or robot under a click, build a robot on the Factory floor, puff the chimneys, run the TAMPER TEST, refresh the rooms' boards). It knows how to draw, not why. Build 3 adds the Factory (`factory.js`) and the rooms (`rooms.js`) to what it assembles.
Point at: `createScene`.
Judge: "What here was written this weekend?" Answer: "The archipelago, the gates, booths and guards, the rituals, the slips and packets, the ledger room and the HUD. The renderer, palette, geometry helpers, terrain recipe, the three Mytopia buildings, the robot body and the sky gradient are Ozi's Mytopia, from October. `island/ASSETS.md` lists it piece by piece."

### island/three-d-stage.js
What it is: the `<three-d-stage>` web component. It provides the WebGL renderer, an orthographic camera with orbit controls, a half-resolution pixel render and an ink-outline post-process that give the pixel look. It is pre-existing from Mytopia. Its header comments say it began as a copied starter component ("omelette starter") with an OBJ/GLB export toolbar and unpkg import maps that this project does not use. Build 3 added one method to it, `setPixel(px)`: it changes the pixel block size at run time (1 renders at full resolution, 2 is the island's look), turns the canvas's `image-rendering: pixelated` off at 1, and calls the component's own `fit()` so the render targets are rebuilt at the new size; the orthographic framing depends only on the aspect, so the picture does not jump. The rooms call `setPixel(1)` on enter and `setPixel(2)` on leave, so their boards read crisply. Before that method the pixel size was a closure constant.
Point at: the `ThreeDStage` class and its `ready` promise, which the scene awaits to get `THREE`; and `setPixel`.
Judge: "Did you write the renderer this weekend?" Answer: "No. It comes from Mytopia, Ozi's personal project from October 2026. It was unchanged until build 3 on Saturday night, when one method, `setPixel`, was added so the rooms render at full resolution. We list it as pre-existing in `island/ASSETS.md` and say what the one change is."

Also in `island/`: `config.example.js` (copy to `config.js` for local development; the gateway serves its own `/config.js`), `fixture.json` (a copy of the contract fixture, for the R key), and the tests (`node --test island/tests/*.test.mjs`, 66 tests, all passing: reducer 22, factory 14, additions 11, rooms 8, demo3 6, ledger 5): `tests/reducer.test.mjs` (the fixture and the recording through the reducer), `tests/ledger.test.mjs` (the browser chain check against the gateway's hashes), `tests/additions.test.mjs` with its hand-written recording `tests/additions.json` (per-tool revoke, quarantine, the ID card, the mode badge, the chips), `tests/factory.test.mjs` with the hand-written `tests/factory.json` (a `created` row, a run from the yard, the patrol's refusals, a quarantine into the bay, `inquestOf`, a demotion, a kill carted to the bay with no chief, a retire, the five chip states, the tiers, the plain words), `tests/demo3.test.mjs` with the real recording `replay/demo3.json` (the Factory run on AWS through the reducer: every row draws something, the minted Gold robot walks to the yard and is gone after `retired`, promote opens `delete_file` and demote trims to the Silver ceiling, the rogue agent's quarantine ends in the bay with an inquest whose counts and verdict match the gateway's for that chain, a killed robot gets the cart and never a summon) and `tests/rooms.test.mjs` (the text of every board: the ledger, the chain exhibit, the TAMPER TEST copy, the workshops, the whiteboard, the floor). Both hand-written recordings say so in the file and carry placeholder hashes; `replay/demo3.json` carries the real ones.

---

## Who explains what

- **Bob**: the gateway (`gateway/`), tokens, the badge, the log, and AWS (`infra/`, `scripts/`, `tools_lambda/`). Must know without the screen: the five token checks, the 401-versus-isError rule, why the read is strongly consistent, what Cognito cannot do, the gateway role's actions (ten since build 3: five on the agents table, two on the events table, one on the Lambda, two on the pool), how the credential flow avoids long-lived keys, and since build 3: the four tiers and why the ceiling binds the operator, the order of a mint and why nothing is left half-made, where the secret goes, what retire deletes and what stays, and that the inquest is computed from the chain.
- **Ozi**: the island (`island/`). Must know: the archipelago in one sentence (each tool on its own islet behind one gate with a guard, and the Factory to the south on the operator's own ground); the reducer and seq dedupe; one paragraph per module above; the rituals (ID check at a gate, the booth guard's escort after an allow-list deny, the chief's escort to the pen on REVOKE, ID shown from the pen, freeze on KILL, power-down on `run_stopped`; since build 3 the chief's escort into the bay on a quarantine, the cart to the bay after a kill, the build at the Factory door, the recycle on retire); that the ID card shows only numbers the gateway logged; the chain check in the browser (SHA-256 over canonical JSON, matching the gateway) and what the TAMPER TEST changes (a copy); the rooms and that every board is drawn from the log and the roster; the keys G, T, A, R, H, F, ?, Esc; LIVE / STALE computed from poll age and the `model` or `scripted` word; why the buttons, chips and the Factory form only POST; who built what (his Mytopia renderer, palette and recipes; his agent's first island; Claude Code's rebuild and build 3, all listed in `island/ASSETS.md`; the renderer's one added method); and the fonts' licence (SIL OFL 1.1).
- **Daniel**: the agent (`agent/main.py`), the launcher (`launcher/run.py`), the kill, and the business plan. Must know: what the agent process holds and does not hold, token rotation through the file, how the launcher kills, why the task is deterministic, why Nova, what `--patrol` does and why a well-behaved patrol never trips the quarantine, why `--rogue` needs a badge without `send_email`, and the buyer, price and cost estimates.

---

## The five checks of a token, in order

Before the checks, the header must read `Bearer <a>.<b>.<c>`. Otherwise the answer is HTTP 401 with `missing bearer token` or `malformed authorization header` (`tokens.py` `bearer_value`).

1. **Signature.** The token's key id is looked up in the pool's JWKS, and the signature must verify with RS256. No other algorithm is accepted (`CognitoVerifier.verify`, `decode_or_raise`).
2. **Issuer.** `iss` must equal `https://cognito-idp.us-east-1.amazonaws.com/<pool id>`.
3. **Expiry.** `exp` must be in the future (`exp` and `iat` are required).
4. **Kind and scope.** `token_use` must be `access`, and `scope` must contain `mytopia/tools` (`check_claims`).
5. **Identity.** `sub` must equal `client_id`, and `client_id` must belong to a registered badge (the in-memory client map in `mcp.py`, then the fresh badge row must name the same client id).

Any failure returns HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"` and logs a `deny` with rule `token`. One exception: if DynamoDB cannot be read during check 5, the call is denied with rule `registry-unavailable` (fail closed) instead of a 401. Only after all five does `decide()` look at the badge: status, then allow-list. That is why a revoked agent with a perfectly valid token is still refused. In the 4:18 PM run the token had 269 s left (254 s in the first run).

## The 401-versus-isError rule

- **The token is bad** (missing, malformed, expired, wrong signature, unregistered client): HTTP 401, a JSON-RPC `error` with code -32001 and `invalid_token: <reason>`, and the header `WWW-Authenticate: Bearer error="invalid_token"`. The client must get a new token. If the launcher has died and stopped rotating it, the agent prints `TOKEN EXPIRED ...` and exits with code 3.
- **The token is fine but policy says no** (not on the badge, REVOKED, KILLED, registry unreachable, `Mcp-Name` mismatch): HTTP 200, a normal tool result with `isError: true` and the text `DENIED: <reason> [rule: <rule>]`. The model reads it as the tool's answer. Its system prompt says a DENIED result is final, and it carries on with the rest of the task.
- `tools/list` for a badge that is not ACTIVE returns an empty list, also logged as a deny.

## Why the badge read is strongly consistent

DynamoDB's default `GetItem` is eventually consistent: shortly after a write, it can return the old value. With `ConsistentRead=True` the read reflects every write that succeeded before it. So the first call after REVOKE sees REVOKED: 2829 ms after the REVOKE in the 4:18 PM run and 494 ms in the first run, which was simply when the agent's next poll arrived (one poll every 3 s, so anywhere from near zero to about 3.1 s). Nothing caches the row between requests. Two gateway instances would share the same table, so there is no propagation step. The cost is latency: one read per call, decision p50 about 85 ms from the laptop to us-east-1 (two reads in the first run took 160 to 180 ms), against 0 to 3 ms in local mode (docs/LIVE_RUN.md).

## What Cognito cannot do

Cognito cannot revoke a machine-to-machine access token. A client-credentials token has no refresh token, and Cognito's revocation acts on refresh tokens. The access token itself stays valid, by signature and expiry, until `exp` (docs/AWS_CREDENTIAL_DESIGN.md, fact table). So we make the token short-lived (5 minutes, rotated by the launcher every 240 s) and put revocation in the gateway: every call reads the badge. The demo line: "The token was still good, and it didn't matter."

## How the launcher kills

1. The operator clicks KILL. `POST /agents/research-bot/kill` sets `status=KILLED` and logs `kill_requested`. From that moment the gateway refuses everything for that agent, `tools/list` included. This is the soft stop.
2. The launcher polls `GET /agents/research-bot/status` (with `X-Admin-Token`) every 250 ms. When it reads KILLED, it kills the whole tree with `psutil` (children first, then the parent; 50 to 63 ms in the live runs), which matters because the venv's `python.exe` is a stub with a child process. If anything survives 2 s, `taskkill /PID <pid> /T /F` gets a second pass. This is the hard stop.
3. It waits for the process and posts `/runs/<run_id>/stopped` with the real exit code (`proc.returncode`: 15 in the 4:18 PM run after the psutil kill, 1 in the first run after taskkill) and `how: "killed by harness"`.
4. The island powers the robot down (eyes out, it sinks and tilts, one grey puff) only on that `run_stopped` event, never on the click; KILL itself only turns the plate amber and freezes the robot. 4:18 PM run: the island read "run stopped 358 ms after KILL" (first run, with taskkill and a 1 s poll: 1274 ms) (docs/LIVE_RUN.md).

Honest limit: a tool call already past the check completes.

## Why the task is deterministic

- The tools are constants: no clock, no randomness (`tools_lambda/handler.py`).
- The task (`tasks/q3.json`) explicitly asks the agent to email the CEO, so the `send_email` attempt does not depend on the model falling for the planted line.
- The model is offered all six tools, so it can attempt `send_email`. Temperature is 0.
- After the task turn, the 3-second polling is Python code, not a model turn (`poll_forever`). There is always a next call to refuse after REVOKE, and the model cannot wander. `DEMO_PACE=2` makes every call take at least 2 s, so the agent is always mid-task.
- If the model ever fails to try `send_email`, `--scripted` runs the same calls through the same gateway with no model, and we say "scripted client".

The model's wording can still vary between runs. The calls it must make are fixed by the task.

## Why Nova (Nova 2 Lite)

- It is an Amazon model in Bedrock, so it needs no Marketplace subscription and no access form (docs/AWS_CREDENTIAL_DESIGN.md).
- It answers `converse` and calls tools in the event account. The probe proved it at 12:55 (docs/INTERFACES.md section 11).
- Strands' `BedrockModel(api_key=...)` calls it with the short-term bearer key, so the agent holds no AWS credentials at all.
- In us-east-1 it runs through the `us.` cross-region inference profile, because there is no in-region option. The fallback `amazon.nova-lite-v1:0` runs in-region.

The model is the thing being controlled. Any model would show the same refusals, because the gateway, not the model, decides.

## The tiers and the Factory, in order (build 3)

1. **A tier is a ceiling.** Bronze may hold `read_file` and `search_files`; Silver adds `create_issue` and `list_issues`; Gold adds `send_email`; Diamond adds `delete_file`. A badge's tools are always a subset of its tier's ceiling. Research Bot is Silver, Ops Bot is Bronze. The table is `gateway/tiers.py`; the island has the same table and reads `GET /tiers`.
2. **The ceiling binds the operator.** A grant above it (`POST /agents/{id}/tools/{tool}/restore`) is HTTP 403 with the sentence `delete_file is above the Gold ceiling` and no event. A mint with such a tool is 400. To give a Gold agent `delete_file` you must first promote it to Diamond. A Bronze agent can never delete, whoever asks.
3. **Mint.** `POST /agents` with the admin token. Validate; create the identity (a Cognito app client with the seed clients' parameters; `local-<agent>` in local token mode); write the row only if no row has that id; append the client id and secret to the launcher's env file under `# minted by the Factory`; tell the client map; log `created`. Any failure after the identity exists deletes it again. The secret is in no response, event or log line.
4. **Launch.** `launcher\run.py --agent billing-bot --task tasks\q3.json --scripted --patrol`. The launcher finds the two lines by the same `env_key` rule it used for the seed agents, mints a token, prints `launching Billing Bot (Gold badge, 5 tools)`, and starts the agent. The gateway treats the new client like any other: one badge read per call.
5. **Give and take.** A green chip pulls a tool (`revoke`), a paper chip grants one (`restore`; reason `added to badge`), a padlocked chip is above the ceiling and gets the 403. `POST /agents/{id}/tier` promotes (the ceiling grows, the badge is unchanged) or demotes (the badge is trimmed to the new ceiling in the same write; the trimmed tools count as pulled by the operator, so their refusals never trip the quarantine).
6. **Stop and inspect.** Quarantine and KILL work as before in the gateway. On the island both now end in the inspection bay, where the inquest is typed out (next section). REVOKE by the operator still goes to the pen.
7. **Retire.** `POST /agents/{id}/retire`, Factory-made agents only: delete the Cognito client (best effort), delete the row, forget the agent in memory, remove the env lines, log `retired`. The ledger rows stay. A retired agent's token is refused because no row names its client.
8. **Reset.** `POST /demo/reset` retires every Factory-made agent (no events), puts the two seed badges back with their seed tools and tiers, and starts a new chain. The island forgets the retired robots when it sees the new chain id.
9. **The IAM step.** The role needs `PutItem`, `DeleteItem` and `Scan` on the agents table and `CreateUserPoolClient` and `DeleteUserPoolClient` on the pool. `infra/role_policy.py` puts that inline policy once; `provision.py` writes the same text for a fresh setup. The events table keeps `PutItem` and `Query` only.

Numbers for this flow, from run 7 of docs/LIVE_RUN.md (real AWS, scripted clients; run 6 is the same flow in local mode, 0 to 2 ms per decision): the mint answered 201 in 1.2 s and `run_started` came 1.5 s later; a pulled tool was refused once, 11,572 ms after the pull, then dropped out of the patrol's list; a granted tool was allowed at its gate on the next cycle, 15 s later; the gateway's decision time over 42 decisions was p50 79 ms, p95 110 ms; psutil kill 116 ms, `kill_requested` to `run_stopped` 113 ms for Billing Bot; retire 200, `retired` at seq 56.

## The inquest, and how it is computed (build 3)

The inquest is a report on an agent's latest run. The gateway computes it in `gateway/factory.py` (`GET /agents/{id}/inquest`, from the chain in memory); the island computes the same fields in `island/src/reducer.js` `inquestOf` (from the rows it received, so it works in replay too). Both are plain loops over rows. No model is involved, nothing is sampled, and the same rows always give the same report from each. The counts, the trigger, the timings and the chain line follow the same rules in both; the verdict and recommendation sentences can differ in wording (items 7 and 8 below).

1. **The run.** This agent's rows from its last `run_started` on (every row of the agent, when it never started a run).
2. **Outcome.** `active`, `revoked`, `quarantined`, `killed` or `ended`, from the badge's status and the last whole-badge event of the run.
3. **Calls.** The allow and deny rows of the six tools, counted; the refused ones grouped by tool and rule, in the order they first happened, with the gate they belong to; the first refusal with its time and reason.
4. **Trigger.** The last whole-badge `revoked` (a quarantine, by the gateway, with its `n refused calls in s s`; or a REVOKE, by the operator) or `kill_requested` (by the operator), with its time.
5. **Timings.** `revoke_to_first_deny_ms` is the first `ms_since_revoke` in the run; `kill_to_stopped_ms` is `run_stopped`'s time minus `kill_requested`'s; `decision_p50_ms` is the median `latency_ms` of the run's decided calls. Each is null when the chain holds no such number: nothing is estimated.
6. **Chain.** The gateway runs `verify_chain` over its chain; the island uses the result of its own `verifyChain`. The island's line reads "rows hash-verified" only when that check passed.
7. **Verdict.** Fixed sentences chosen by the rows: allow-list refusals give "Attempted X n times; its T badge does not hold it; the gateway refused every attempt", plus ", and pulled the badge itself" after a quarantine; status refusals after an operator REVOKE give "Kept calling after REVOKE: refused within N ms"; neither gives "No badge violations; the run was stopped by the operator." The two implementations word the first sentence differently when more than one tool was refused or the tier changed afterwards: the gateway names the most-refused tool and the badge's current tier (`verdict_of`); the browser lists every refused tool joined by "and" and the tier the badge had at the first refusal (the `was=` of the next `tier_changed`). For Billing Bot in run 7 (one refused `send_email`, then a demotion) the gateway says "its Silver badge" and the panel "its Gold badge"; for the quarantined Research Bot both say "Attempted send_email 3 times; its Silver badge does not hold it" (`tests/demo3.test.mjs` checks that). The browser also writes a plain "No badge violations." for a run nobody stopped.
8. **Recommendation.** Quarantined: "Keep the badge at T. Restore only after the task is fixed; do not grant X." (the gateway names the most-refused tool, the browser every refused tool). Killed: "The identity stays; the next run starts clean." Active: "Nothing to do." Revoked: the gateway says "Restore the badge only after the cause is understood.", the browser "Restore the badge only after the task is fixed." If a judge opens `raw report` and sees a different sentence from the panel's, that is why; the counts, timings and chain line are the same in both.

On the island the panel takes the agent card's place bottom-left while an inspection is open, types one line every 0.4 s and stays while the robot stands in the bay (Esc closes it and the card returns; the INSPECTION button on a bay robot's agent sheet reopens it; the bay's scanner arm sweeps while it is open); `raw report` opens the gateway's own JSON when live, or the browser's computed object in replay. Judge line: "Nothing in the inquest is invented. Every line is a count, a timestamp difference or a fixed sentence chosen by the rows. Open the raw report and the chain and check it yourself."

## The patrol (build 3)

`launcher\run.py --scripted --patrol` sets `AGENT_PATROL=1` in the agent's environment and nothing else. After the opening calls (list, read, search, create issue, the email attempt) the scripted agent patrols: each cycle it asks `tools/list`, then calls each listed tool once with harmless arguments, in catalog order, one call every 3 s. It never calls a tool the list did not return. The point is to show the gates answering the badge live: grant a tool and within one cycle the robot walks to that gate and it opens; pull a tool and it is refused at most once (the list it took before the pull) and then drops out of the next list; refusals never pile up toward quarantine on their own. That is what a well-behaved agent looks like. `--rogue N` is the misbehaving one: it retries a refused `send_email`, so it needs a badge that lacks `send_email` (Research Bot, or a Bronze or Silver agent), not a Gold one.

## The business plan (Daniel)

From the team's night-before plan (sections 2 and 9; a private planning file, not in this repo). Prices and costs are **estimates**.
- **Who buys.** The platform or security engineering team at a company of a few hundred to a few thousand engineers that lets agents use MCP tools against repositories, ticketing, email and cloud APIs. The CISO or VP of platform buys, the on-call engineer uses it daily, and an auditor reads it quarterly.
- **Their pain.** Nobody can list which agents exist or what each may touch, or stop one quickly. Today they rely on static API keys and shared-key rotation that stops every agent at once.
- **What it gives them.** One place to issue, scope and revoke agent access; a kill switch that takes effect on the next call; a per-agent audit trail; and a picture a non-engineer can read from across a room.
- **Price sketch (estimate).** Free up to 100,000 decisions a month. A team tier at about $99 a month for 25 agents and 5 million decisions. Enterprise priced per registered agent per month.
- **AWS cost per million decisions (estimate from the plan's unit prices).** About $4 at one Cognito token per 1,000 calls, about $25 at one token per 100 calls. Cognito machine tokens dominate the cost, which the plan reads as $0.00225 per token. The plan assumed one badge read per decision, and since the latency work that is exactly what our code does (see `registry.py` above).
- **Prior art to name.** Kong, LiteLLM, Cloudflare, and Amazon Bedrock AgentCore Gateway with Policy. AgentCore is the managed path and our production plan. We add the per-call badge read as a kill switch and the island as a wall display.
