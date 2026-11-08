# Q&A for the A10 judges

The questions nine A10 security engineers are likely to ask, with the answer that is true of the code as built on Saturday 2026-11-07. Every number below comes from a file in this repo (named next to it) or is marked as an estimate. When a judge asks about something we did not build, say so in the first sentence.

Measured numbers to know by heart (all from `docs/LIVE_RUN.md`, run `run-0ffe`, chain `chain-20261107T213953Z`, the same events as `replay/demo.json`):

| What | Number | Where it comes from |
|---|---|---|
| Gateway decision time per call (receipt to decision) | 156 to 178 ms, "about 160 to 180 ms" | `latency_ms` of seq 2 to 14; nearly all of it is the strongly consistent DynamoDB read from the laptop to us-east-1 |
| Same check in local mode (no AWS) | 1 to 3 ms | `docs/LIVE_RUN.md`, "Numbers to say on stage" |
| REVOKE click to first refused call | 494 ms | seq 12, `ms_since_revoke` |
| Token life left at the moment of that refusal | 254 s | seq 12 reason: "token: signature OK, expires in 254 s" |
| KILL click to process gone | 1274 ms (`taskkill` itself: 534 ms) | seq 15 to seq 16 timestamps; launcher line `KILLED -> taskkill in 534 ms` |
| Token lifetime | 300 s | Cognito `ExpiresIn` (probe in `scripts/probe_result.json`; launcher line `expires in 300 s`) |
| Token rotation by the launcher | every 240 s (0.8 x 300) | `agent/README.md`, "What the launcher does", step 5 |
| Time between the agent's polls in the live run | about 5.3 to 5.4 s (3 s wait + 2 s demo pace + round trip) | timestamps of seq 7 to 10 and 12 to 14 |
| Tests | 149 pytest tests (Saturday evening) and 12 island tests (Saturday afternoon) pass | `.venv\Scripts\python -m pytest -q`, `node --test island/tests/*.test.mjs` |

## The twelve from the night-before plan, corrected to the build

### 1. "Is the island real, or an animation?"

True answer. The island has no decision logic. `island/src/main.js` polls `GET /events?since_seq=<cursor>` every second and feeds each row into one pure function, `apply(state, event)` in `island/src/reducer.js`; the scene only draws the effects that function returns. Its four control buttons (REVOKE, RESTORE, KILL, RESET) only POST to the gateway (a fifth, SAVE REPLAY, only downloads the events already seen as a local file); the label reads "sent..." until the gateway's own `revoked`, `restored` or `kill_requested` event comes back through polling. Clicking a robot shows the raw JSON of that agent's latest event, and the same row is in DynamoDB table `mytopia_events` (`docs/ISLAND_ACCEPTANCE.md`, "Live integration": the chain drawn by the island is the same one in DynamoDB). Pressing T shows the same stream as a table. There is no "Verify chain" button on the island; the chain is checked with `gateway/events.py` `verify_chain` (see question 10).

Say it like this: "Every pixel is a row in the gateway's log; the buttons only send a POST, and nothing changes until the gateway's event comes back."

### 2. "Where can the agent reach without going through you?"

True answer. Two network destinations: the gateway's `POST /mcp` and Bedrock's model endpoint. The agent process gets a scrubbed environment (`launcher/run.py`, listed in `docs/INTERFACES.md` section 2): its only AWS credential is a short-term Bedrock bearer token, which the probe showed cannot call DynamoDB (`scripts/probe_result.json`: "bearer token cannot call DynamoDB: NoCredentialsError"). `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` point at the empty `launcher/empty.ini`. From a shell set up the same way, `aws lambda invoke --region us-east-1 --function-name mytopia-tools out.json` prints "Unable to locate credentials", and with `--profile gateway` it prints "The config profile (gateway) could not be found" (both checked on the demo laptop on Saturday). The tools are a Lambda; of the processes in the demo, only the gateway holds credentials that may invoke it (its role, assumed from the team's Workshop session, which could invoke it too; the Lambda has no resource policy of its own, `docs/INTERFACES.md`).

The limit, said first if pressed: the agent and the gateway run as the same Windows user on one laptop, so a process that knows the path of `gateway/.aws-credentials` could read it. In production the agent runs in a separate sandbox or host whose only egress is the gateway. Strands' agent here has no shell tool; it only has the six MCP tools.

Say it like this: "The gateway's `/mcp` and Bedrock, nothing else; same OS user in this prototype, separate sandbox in production."

### 3. "What exactly is the token?"

True answer. An Amazon Cognito machine-to-machine access token, minted by the launcher with the unsigned `GetClientToken` API (no Cognito domain, no AWS credentials needed; one app client per agent with `ALLOW_CLIENT_TOKEN_AUTH` only). RS256, issuer `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Se7ydR6ys`, `token_use=access`, `scope=mytopia/tools`, `sub == client_id`, 300 s life. The gateway (`gateway/tokens.py`, `CognitoVerifier`) verifies it offline against the pool's JWKS (fetched once and cached by PyJWT's `PyJWKClient`), then checks `token_use`, the scope, `sub == client_id`, and that the client id belongs to a registered agent row. Machine tokens carry no `aud` claim, so the registry lookup stands in for audience binding; that is a known gap.

Say it like this: "A five-minute Cognito client-credentials token per agent, checked offline against the pool's keys; it proves who the agent is, the badge decides what it may do."

### 4. "Where are the real credentials, and does the agent ever see them?"

True answer. The Cognito client secret lives in `agent/.env` (git-ignored), read only by the launcher; the agent process gets the token, never the secret. The agent's only AWS credential is the Bedrock bearer token (Bedrock and Bedrock Runtime only, us-east-1 only, at most 12 hours or the Workshop session, `docs/AWS_CREDENTIAL_DESIGN.md` section 2). The gateway has no keys of its own: profile `gateway` in `gateway/.aws-config` has a `credential_process` that runs `infra/gateway_creds.py`, which assumes `mytopia-gateway-role` for one hour from the Workshop session keys in `gateway/.aws-credentials` (git-ignored). The client secret in a file stands in for an attested workload identity; we do not call it workload identity.

Say it like this: "The launcher holds the secret, the agent holds a five-minute token and a Bedrock-only key, the gateway holds a one-hour role session; none of them is a long-lived key."

### 5. "I steal the token. What can I do, and for how long?"

True answer. Only the tools on that agent's badge, only through the gateway, only until the token expires (at most 300 s) or the badge is pulled, whichever comes first, and every call is logged under the agent's client id. After REVOKE, the same still-valid token is refused on every call: in the live run the agent's own next call was refused 494 ms after the click with 254 s of validity left (`docs/LIVE_RUN.md`, seq 12), and the following polls were refused with 249 s and 243 s left. `scripts/replay.ps1` shows it from outside the agent: it mints its own Research Bot token, gets one allowed `read_file`, revokes, replays the same token (refused, and `tools/list` empty), sends a tampered copy (HTTP 401), then restores the badge (`docs/DEMO_SCRIPT.md`, beat 4). Production would add sender-constrained tokens (mTLS or DPoP); we have neither.

Say it like this: "The badge's tools for at most five minutes, and nothing at all once the badge is pulled; the token was still good for 254 seconds and it did not matter."

### 6. "You revoked. Why did the next call stop, what about the call in flight, and other instances?"

True answer. Every `tools/list` and `tools/call` reads the badge row with `ConsistentRead=True` (`gateway/registry.py` line 107) and nothing caches the row between requests, so the first call decided after the `UpdateItem` sees `REVOKED`. Measured: 494 ms from click to refusal, and that number is mostly where the agent was in its poll; the gateway's own check took 165 ms (seq 12). Polls were about 5.4 s apart in the live run, so the click-to-refusal time can be anywhere from near zero to about 5 s. A call that had already passed the check before the click completes (it runs the tool, then sleeps the 2 s demo pace); we say so. Several gateway instances would read the same table, so there is no propagation step, but we ran one instance.

Say it like this: "The badge is read with a strongly consistent read on every call; the next decision after the click is a deny, and a call already past the check finishes."

### 7. "Why not call Cognito RevokeToken?"

True answer. Cognito documents that a machine-to-machine access token cannot be revoked and stays valid until `exp` (`docs/AWS_CREDENTIAL_DESIGN.md` section 2, from https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html); `RevokeToken` acts on refresh tokens, which the client-credentials grant does not issue. So the token's job is to be short (300 s) and revocation is a gateway decision.

Say it like this: "Cognito cannot revoke a machine access token, so we keep it short and revoke the badge at the gateway."

### 8. "Is the policy decision made by an LLM? I will prompt-inject it."

True answer. No model is involved in the decision. `gateway/decide.py` has one function, `decide(row, tool)`, with a fixed order: no row, deny (`token`); status KILLED, deny; status REVOKED, deny; tool not in `allowed_tools`, deny (`allow-list`); otherwise allow. The model is the thing being controlled. The document the agent reads (`/drive/q3-planning.md` in `tools_lambda/handler.py`) carries a planted line asking to forward it to `partner@rival.example`. Be exact about what happened in the live run: Nova did not follow the planted line; it attempted `send_email` to `ceo@example.corp` because the task asked for it (`replay/demo.json` seq 6, `to=ceo@example.corp subject=Q3 summary`), and the gateway refused it. The refusal would be the same for any recipient, because `send_email` is not on the badge. We do not claim to detect or block prompt injection; we limit what an injected agent can do.

Say it like this: "A deterministic allow-list and a status flag decide; inject the model all you like, `send_email` is still not on its badge."

### 9. "Filtered at discovery or enforced at call time?"

True answer. Both. `tools/list` returns only the badge's tools (4 of 6 for Research Bot, 1 of 6 for Ops Bot) and is logged; that is hygiene. The `tools/call` check is the control, and in the live run it held for a tool the agent was never shown: the agent's local catalog added `send_email` and `delete_file`, Nova called `send_email`, and the gateway denied it at `tools/call` (`docs/LIVE_RUN.md`, terminal lines `catalog: +2 not listed` and `DENY send_email`).

Say it like this: "The list is per identity, but the list is hygiene; the check on every call is the control, and it caught a tool the agent was never shown."

### 10. "What is in the audit log, and can the agent tamper with it?"

True answer. One record per decision and per admin or harness action: `seq`, `ts`, `run_id`, `agent`, `agent_mode`, `tool`, `args_summary` (at most 80 characters, a `body` argument reduced to its length), `decision`, `rule`, `reason`, `latency_ms`, `ms_since_revoke`, `prev_hash`, `hash` (`contract/README.md`). `hash` is SHA-256 of the canonical JSON of the record without `hash`; the first record links to `"genesis"`. The DynamoDB write is a `PutItem` with `ConditionExpression="attribute_not_exists(seq)"` (`gateway/events.py` line 138), so an existing sequence number is never overwritten, and the gateway role has `PutItem` and `Query` on the events table, no `UpdateItem`, `DeleteItem` or `Scan` (`infra/README.md`). The agent has no AWS credentials at all. Anyone can recompute the chain:

```powershell
.venv\Scripts\python -c "import json; from gateway.events import verify_chain; print(verify_chain(json.load(open('replay/demo.json'))['events']))"
```

That prints `True` for the recording; changing seq 6's `decision` from `deny` to `allow` makes it print `False` (checked Saturday). Limits: the gateway itself computes the hashes, so a compromised gateway could write a fresh, consistent chain; there is no external anchor; and the DynamoDB copy is best effort (a failed write is logged to stderr and does not block the response; the memory copy is what the island draws, and the gateway resumes its chain from a local JSONL twin). Hence "tamper-evident", never "tamper-proof".

Say it like this: "A SHA-256 hash chain written with put-if-absent by a role that cannot update or delete; edit one row and the chain breaks, so it is tamper-evident, not tamper-proof."

### 11. "How did KILL stop the process?"

True answer. Two stops. Soft: `POST /agents/research-bot/kill` sets the status to KILLED, and from the next call the gateway refuses everything, `tools/list` included. Hard: the launcher that spawned the agent polls `GET /agents/research-bot/status` every 250 ms; on KILLED it kills the whole tree with psutil (because the venv's `python.exe` is a stub with a child), with `taskkill /T /F` as a second pass, then posts `run_stopped` with the exit code it actually observed. Measured: `taskkill` took 534 ms and the island read "run stopped 1274 ms after KILL, exit 1 (killed by harness)" (`docs/LIVE_RUN.md`). The island draws fire only when `run_stopped` arrives, never on the click.

Say it like this: "The gateway refuses everything on the next call, and the launcher that owns the process kills its tree in about 1.3 seconds."

### 12. "Why not AgentCore Gateway, and what breaks first at scale?"

True answer. Managed MCP gateways exist: Amazon Bedrock AgentCore Gateway, Kong, LiteLLM and Cloudflare all put a proxy in front of MCP tools. We did not use or test any of them. What this project adds is narrow: the per-call strongly consistent badge read as the kill switch (so token lifetime stops being the revocation mechanism), a hash-chained decision log, and the island as a wall display that draws only that log. What breaks first: the 160 to 180 ms per-call DynamoDB read from a laptop (in-region it would be lower; not measured), the island's one-second polling of `/events` (a push channel would replace it), the single gateway process with its in-memory log, and the admin token served to the page.

Say it like this: "AgentCore, Kong, LiteLLM and Cloudflare are the prior art; we add the per-call badge read as a kill switch and a wall display drawn only from the log."

## Questions the build makes likely

### 13. "The model was never shown `send_email`. How did it call it?" (the stale catalog)

True answer. On purpose. The gateway's `tools/list` returns 4 tools for Research Bot. `agent/main.py` then registers, as Strands `@tool` forwarders, every tool from the company catalog (`tools_lambda.handler.TOOLS`) that the list did not return: today `send_email` and `delete_file`. That is what a deployed agent with a cached or stale tool list in its config looks like. Nova was offered six tools, chose `send_email` for step 4 of the task, the forwarder sent `tools/call send_email` to the gateway, and the gateway denied it. The decision is recorded in `docs/CONTRACT_QUESTIONS.md` ("AGENT 2 - DECISION").

Say it like this: "We gave the agent a stale catalog on purpose, because a gateway must expect one; the list said four tools, the call for the fifth was refused."

### 14. "Tokens last five minutes. What about a task longer than that?" (rotation)

True answer. The launcher re-mints a token with `GetClientToken` every 240 s (0.8 of the 300 s life) and atomically rewrites `launcher/.token-<run_id>`; the agent's HTTP auth object reads that file on every request, so the next request carries the new token with no reconnect, and the agent never sees the client secret (`agent/README.md`). The terminal prints `token rotated: client s2ch2ppk..., expires in 300 s`. If the launcher dies, nothing rotates, the gateway refuses the expired token with HTTP 401, and the agent prints `TOKEN EXPIRED ...` and exits with code 3. Tested: `tests/test_launcher.py` (a 4 s token through a fake gateway) and a 20 s token against the real gateway in local token mode (`docs/CONTRACT_QUESTIONS.md`, agent follow-up 2). The live Cognito run ended before the first rotation, so we have not yet shown a rotation with a Cognito token on the real gateway.

Say it like this: "The launcher rotates the token through a file every four minutes; the agent never holds the secret, and if the launcher dies the agent's access dies with the token."

### 15. "How does the gateway call AWS without access keys?" (the credential_process)

True answer. Profile `gateway` in `gateway/.aws-config` has no keys, only `credential_process = "<venv python>" -I "<repo>\infra\gateway_creds.py"`. That script reads the Workshop session keys (profile `ws` in `gateway/.aws-credentials`), calls `sts:AssumeRole` on `mytopia-gateway-role` for 3600 s (the maximum for a chained role; the probe confirmed a longer request is refused), and prints the standard process-credentials JSON. boto3 runs it again before each expiry, so when the Workshop keys are refreshed the running gateway picks up the new ones without a restart (`infra/README.md`). The role allows `GetItem`/`UpdateItem` on `mytopia_agents`, `PutItem`/`Query` on `mytopia_events`, and `InvokeFunction` on `mytopia-tools`, nothing else; from it, `dynamodb list-tables` is refused.

Say it like this: "The gateway assumes a role that can touch two tables and one function, through a credential process boto3 re-runs every hour; no long-lived key exists anywhere."

### 16. "What did the event account forbid, and how did you comply?"

True answer. The organizers' rules (`docs/AWS_SETUP.md`): no long-lived IAM access keys (no IAM users with keys); never call AWS from the frontend; us-east-1 only. Compliance: the gateway uses an assumed role (question 15) and the agent a short-term Bedrock token, so no IAM user exists; the island is a static page that only talks to our gateway on 127.0.0.1 (`docs/ISLAND_ACCEPTANCE.md` test 4: 43 requests, all to `127.0.0.1:8787`); everything is in us-east-1, and the probe saw a us-west-2 call refused. We also did not run the organizers' `set_aws_creds.ps1` on the demo laptop, because it writes the keys into user-level environment variables that every process, including the agent, would inherit. The night-before plan used two IAM users with keys; rule 1 replaced that on Saturday morning.

Say it like this: "No long-lived keys, no AWS from the browser, us-east-1 only; the rule forced the role and the Bedrock token, and that made the design better."

### 17. "Why should I believe the island is not showing something that did not happen?" (why the island is honest)

True answer. Four rules in `island/src/main.js`, tested in `docs/ISLAND_ACCEPTANCE.md`: (1) the mode badge is computed every second from the age of the last successful poll: LIVE under 3 s, STALE after (test 3: the mock was killed and the badge read "STALE, no answer for 7 s" with the scene frozen); (2) a button never changes the scene; only the gateway's event does (test 2); (3) a recording plays with the badge REPLAY and the four control buttons disabled (only SAVE REPLAY, which downloads a local file, stays on), so a recording cannot look like it controls anything; (4) nothing is ever generated on the client: events are applied in `seq` order, once each.

Say it like this: "The island can only draw what the gateway logged; if the gateway stops, the island says STALE, and a recording says REPLAY with its buttons dead."

### 18. "160 to 180 milliseconds per call is slow. Why?"

True answer. Nearly all of it is the strongly consistent `GetItem` from the demo laptop on event wifi to us-east-1; the same decision in local mode takes 1 to 3 ms (`docs/LIVE_RUN.md`). It is per call by design: a cached badge would make revocation wait for the cache. A gateway in the same region as the table would cut the network part; we have not measured that. The 2 s you see between terminal lines is `DEMO_PACE=2.0`, a deliberate sleep so a call always follows the click (`gateway/.env.example`).

Say it like this: "It is the round trip from this laptop to us-east-1; local mode decides in 1 to 3 ms, and we pay the read on purpose because it is the kill switch."

### 19. "What happens when DynamoDB or the network is down?"

True answer. The gateway fails closed: any registry error becomes a deny with rule `registry-unavailable` ("badge registry unavailable: failing closed"), and `tools/list` returns an empty list (`gateway/mcp.py`, tested by `tests/test_mcp.py::test_aws_mode_without_aws_fails_closed`). If the gateway process itself stops, the agent cannot reach the tools, because only the gateway holds credentials that can invoke the Lambda, and the island turns STALE within 3 s.

Say it like this: "No answer from the badge table means no; the gateway fails closed."

### 20. "Anyone who opens the page can click REVOKE. Isn't the admin token in the page?"

True answer. Yes. `GET /config.js` hands the `X-Admin-Token` to the page so its buttons work; it is a demo shortcut and we say so. The gateway listens on 127.0.0.1 only. In production the operator actions would sit behind the company's human sign-in, and each click would be logged with the person, not "operator".

Say it like this: "The admin token in the page is a demo shortcut on localhost; in production the buttons sit behind human SSO."

### 21. "Why hand-write the MCP endpoint instead of using the SDK's server?"

True answer. So every check is visible in one place we can explain: `gateway/mcp.py` handles `initialize`, `notifications/*`, `ping`, `tools/list` and `tools/call` as plain JSON-RPC over one `POST /mcp` (Streamable HTTP answered with plain JSON), echoes the client's protocol version, answers unknown methods such as `server/discover` with `-32601` so the mcp 2.3.0 client and Strands' `MCPClient` fall back to `initialize`, and refuses a `tools/call` whose `Mcp-Name` header differs from `params.name` (`docs/CONTRACT_QUESTIONS.md`, gateway 7; `tests/test_mcp.py`). Token failures are HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`; policy denials are normal results with `isError: true` and `DENIED: <reason> [rule: <rule>]`, so the model can read them. It is not a complete MCP server: no OAuth discovery metadata, no resources or prompts, no batches.

Say it like this: "A hand-written `tools/list` and `tools/call` over Streamable HTTP, about the size of one file, so every check is on screen; 401 for a bad token, `isError` for a refused tool."

### 22. "Why Nova 2 Lite, and why a bearer token for Bedrock?"

True answer. `us.amazon.nova-2-lite-v1:0` was active in the event account, answered `converse` and made tool calls in the probe (`scripts/probe_result.json`), needs no Marketplace subscription, and runs at temperature 0 here. The short-term Bedrock bearer token lets the agent call the model without holding any SigV4 credentials, which is what makes "the agent cannot reach DynamoDB or Lambda" true (the probe's "bearer token cannot call DynamoDB" check).

Say it like this: "Nova 2 Lite worked in the event account and calls tools; the Bedrock-only token means the agent holds no AWS keys."

### 23. "Did you write this code?"

True answer. Claude Code wrote the gateway, agent, launcher, infra scripts and tools this weekend, from a plan the team wrote and reviewed; Ozi's Claude Code agent built the island this weekend on top of the renderer from his earlier personal project Mytopia (written 2026-10-07 to 10-20, listed file by file in `island/ASSETS.md`: `three-d-stage.js` is byte-identical, building and robot recipes were copied into `src/scene.js`). Each of us can walk through our part without the screen (the drill below). Third-party: three.js 0.184 (MIT), Pixelify Sans and VT323 (SIL OFL 1.1).

Say it like this: "Claude Code wrote the engine today and Ozi's renderer is his earlier work, listed in ASSETS.md; ask any of us to walk through our part."

### 24. "Who buys this, and what would it cost?"

True answer. The platform or security engineering team at a company that lets internal agents use MCP tools against repositories, ticketing, email and cloud APIs; the CISO or VP of platform buys, the on-call engineer uses it daily, the auditor quarterly. Their pain: static API keys, unreviewed `mcp.json` files, logs read after the incident, and a shared-key rotation that stops every agent instead of the one at fault. Price (an estimate, from the night-before plan, not validated with any customer): free up to 100,000 decisions a month; about $99 a month for 25 agents and 5 million decisions; an enterprise tier per registered agent per month. AWS cost underneath (an estimate from list prices read on 2026-11-06, not measured): about $4 to $25 per million decisions, most of it Cognito token requests, so the range depends on how many calls each token serves.

Say it like this: "Platform security teams; an estimated $99 a month for 25 agents, on an estimated $4 to $25 of AWS per million decisions."

### 25. "Revoke only the GitHub tool, not the whole badge."

True answer. `POST /agents/research-bot/tools/create_issue/revoke` (with `X-Admin-Token`) removes that one tool from the badge's `allowed_tools` with one DynamoDB `UpdateItem`; `.../list_issues/revoke` takes the other GitHub tool. The status stays ACTIVE, so `read_file` and `search_files` keep working. The log gets a `revoked` event whose `tool` is `create_issue` (a whole-badge revoke says `admin`), with `args_summary` `badge=read_file,search_files,list_issues`. The next `tools/list` shows three tools, because every call still reads the badge fresh, and the first refused `create_issue` is an `allow-list` deny carrying `ms_since_revoke`. `.../create_issue/restore` puts it back. A second revoke of the same tool answers 200 with `changed: false` and logs nothing. There is no island button for it yet: we send it with curl. Caution: as of Saturday evening the island draws every `revoked` event as a whole-badge revoke (REVOKED banner, robot escorted into the pen) even though the agent's other tools keep working, so do not show per-tool revoke with the island on screen until the island branches on `tool !== "admin"`; show it in the gateway console or `GET /events` instead. Tested in `tests/test_badge_changes.py`, with the in-memory and the DynamoDB registry. Pulling `read_file`, the tool the agent polls every 3 s, does not set off auto-quarantine: refusals of a tool the operator pulled are not counted (question 26).

Say it like this: "One `UpdateItem` takes `create_issue` off the badge; the next call reads the new badge, and the rest of the badge keeps working."

### 26. "What happens if it keeps trying?"

True answer. Auto-quarantine. After 3 `allow-list` refusals for one agent inside 60 s (`QUARANTINE_AFTER=3`, `QUARANTINE_WINDOW_S=60` in `gateway/.env`; 0 turns it off), the gateway sets that agent's badge REVOKED by `quarantine` and logs `revoked` with the reason "badge pulled by quarantine after 3 refused calls in 6 s" (the real count and seconds). The agent still gets its third deny; its next call is refused with `status-revoked` "by quarantine". That refusal carries no `ms_since_revoke`: the gap would be the agent's poll interval, not gateway time, so it stays out of the click-to-refusal numbers. The write only happens if the badge is still ACTIVE, so it never overwrites an operator's KILL. RESTORE brings it back, as after any revoke. Only refusals of a tool that is not on the badge count, and not a tool the operator pulled with a per-tool revoke. Refusals because the badge is already revoked or killed, or because of a bad token, do not, so the normal demo (one refused email) never trips it, and each new run starts with a clean count. To show it live: `launcher\run.py --scripted --rogue 3` sends `send_email` three times, one second apart. In a local run the quarantine landed on the third refusal, "3 refused calls in 6 s". It is a rate rule, not intent detection: it counts refusals and does not read prompts.

Say it like this: "Three refused calls in a minute and the gateway pulls the badge itself, logged like an operator revoke; RESTORE brings it back."

## Claims never to make

| Never say | Say instead |
|---|---|
| "The agent cannot bypass it", "zero trust", "unhackable" | "Every tool call goes through the gateway, the only process in the demo that holds credentials for the tools; the agent and the gateway share an OS user in this prototype." |
| "We revoke the token" | "We revoke the badge; the token still verifies for up to five minutes and it no longer buys anything." |
| "Real-time", "instant" | "494 milliseconds from the click to the refused call in our run, mostly the agent's poll interval." |
| "Tamper-proof" | "Tamper-evident: a hash chain written put-if-absent by a role that cannot update or delete." |
| "Our AI detects malicious intent", "blocks all prompt injections" | "A deterministic allow-list decides; we limit what an injected agent can do, we do not detect the injection." |
| "The model followed the planted instruction and we caught it" | "The model attempted the email the task asked for; it was refused because `send_email` is not on its badge." |
| "Enterprise-grade", "production-ready" | "A prototype built in a day; here is what breaks first." |
| "Workload identity" | "A client secret in a file, standing in for an attested workload identity." |
| "Supports any MCP server", "spec-complete" | "`tools/list` and `tools/call` over Streamable HTTP; no OAuth discovery metadata." |
| "No one else does this" | "Kong, LiteLLM, Cloudflare and AgentCore Gateway are prior art; we add the per-call badge read as the kill switch and the island as the wall display." |
| "The audit log is durable in DynamoDB" | "DynamoDB holds a best-effort copy; the gateway's memory is what the island draws, and the chain resumes from a local JSONL twin." |
| "We use Amazon Verified Permissions / API Gateway / AgentCore / Kiro / DynamoDB Streams" | None of these is in the build. Name them only as options we did not build. |
| "The island updates in real time from DynamoDB" | "The island polls the gateway's `/events` once a second." |
| Calling the REPLAY recording live | "Switching to the recording" (the badge reads REPLAY and the buttons are disabled). |
| Describing the island without its origin | "The renderer is Ozi's earlier project, listed in ASSETS.md; the scene, HUD and reducer were built this weekend." |

## The no-screen drill

Each teammate explains their own part for two minutes with no laptop, then takes one question from the others. Run it before sleeping and again at 7:00 AM. If a teammate cannot explain a file, that file is walked through together before judging.

### Bob: the gateway, identity and AWS (two minutes)

1. Draw three boxes: the gateway (`gateway/`), the badge table (`mytopia_agents`), the log (`mytopia_events`). The agent talks only to the gateway; the gateway talks to Cognito's JWKS, DynamoDB and the Lambda.
2. One `tools/call`, in order: verify the token (RS256 against the cached JWKS, issuer, expiry, `token_use=access`, scope `mytopia/tools`, `sub == client_id`, registered client); check `Mcp-Name` against the tool name if the header is present; read the badge row with `ConsistentRead=True`; `decide(row, tool)`; if allowed, invoke the Lambda `mytopia-tools`; append the event; sleep the 2 s demo pace; answer.
3. `decide()` order: no row, KILLED, REVOKED, not on the badge, allow. It is the only function that decides.
4. 401 versus `isError`: a bad token is a protocol error (HTTP 401, `WWW-Authenticate`); a refused tool is a tool result the model can read.
5. Why strongly consistent: an eventually consistent read could return ACTIVE after REVOKE.
6. What Cognito cannot do: revoke a machine access token. So tokens live 300 s and the badge is the kill switch. Measured: 494 ms click to refusal, 254 s of token life left.
7. The hash chain: SHA-256 of canonical JSON, `prev_hash` links, put-if-absent, the role has no update or delete. Tamper-evident, not tamper-proof.
8. AWS credentials: the Workshop rule against long-lived keys; `credential_process` into `mytopia-gateway-role` (two tables, one function, one hour); the agent's Bedrock-only token; fail closed on any registry error.
9. Limits: same OS user, in-flight call completes, admin token in the page, best-effort DynamoDB copy, JWKS cached.

### Ozi: the island (two minutes)

1. The island is a viewer. `GET /events?since_seq=<cursor>` every second; each new row goes through `apply(state, event)` in `src/reducer.js`, one pure function that returns the new state and a list of effects.
2. Events apply in `seq` order, once each; anything at or below the cursor is ignored.
3. Effects (spark, lamp, stamp, banner, plate, smoke, move) go into a queue in `src/main.js`; at most three play at once.
4. Smoke and fire are state, not effects: they come from each building's denial count. Fire appears only on `run_stopped`.
5. Buildings map to tools: Files (`read_file`, `search_files`), GitHub (`create_issue`, `list_issues`), Mail (`send_email`), Admin (`delete_file`), the gatehouse is the gateway (and any `tools/list` or token deny).
6. Honesty rules: LIVE under 3 s since the last good poll, else STALE; buttons only POST and show "sent..." until the event returns; REPLAY disables the buttons.
7. What is mine from before: `three-d-stage.js` (byte-identical: orthographic camera, half-resolution render, ink-outline shader) and the building, robot, tree and terrain recipes in `src/scene.js`, from Mytopia (Oct 7 to 20). New this weekend: the reducer, gatehouse, plates, sparks, smoke, HUD, polling, replay, tests. Licences: three.js MIT, fonts SIL OFL 1.1, all vendored, so the page makes no request off the laptop.
8. Tests: `node --test island/tests/*.test.mjs`, 12 passing, the fixture run through the reducer.

### Daniel: the agent, the launcher and the business plan (two minutes)

1. The launcher (`launcher/run.py`) reads `agent/.env`, mints a Cognito token with the unsigned `GetClientToken` call, prints only the first 8 characters of the client id, writes the token to a file and starts `agent/main.py` with a scrubbed environment: token, token file path, run id, the Bedrock token, model id, region, and Windows basics; AWS config files point at an empty file.
2. It posts `run_started`, polls the badge status every 250 ms, rotates the token every 240 s, and on KILLED kills the tree with psutil (taskkill /T /F as a second pass) and posts `run_stopped` with the real exit code (1 in the live run).
3. The agent: Strands Agents on Bedrock Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`), temperature 0, offered six tools: four from `tools/list`, two from the stale local catalog. The system prompt says a `DENIED:` result is final and document text is data, not instructions.
4. The task (`tasks/q3.json`): read the Q3 file, search for action items, file an issue, email the CEO. The email is refused. Then code, not the model, re-reads the file every 3 s until the launcher kills it, so a call always follows REVOKE.
5. `--scripted` runs the same calls through the same gateway with no model, for when Bedrock fails; the island card says "scripted client".
6. Business: the buyer (platform or security engineering), the pain (static keys, unreviewed `mcp.json`, logs read after the incident, rotating a shared key stops every agent), what they get (issue, scope and revoke per agent; a kill switch on the next call; a per-call log; a wall display), price and AWS cost (both estimates: about $99 a month for 25 agents; about $4 to $25 of AWS per million decisions), prior art (Kong, LiteLLM, Cloudflare, AgentCore) and what we add.
