# Devpost submission, ready to paste

Every field of the form, in the order Devpost usually asks for them. Numbers come from files in this repo (cited in brackets, delete the brackets when pasting if you like) or are labelled estimates. Before pasting, fill the two `TODO` lines (video link, screenshots).

---

## Project name

```text
MYTOPIA
```

## Tagline (97 characters; the limit is 100)

```text
Pull an AI agent's badge and its next tool call is refused. A10 Track, Prompt 1: Agentic Identity
```

## Track selection

- Select the **A10 Networks track**.
- The form may have no field for the prompt, so the prompt is stated in the tagline and in the first line of the description: **A10 Track, Prompt 1: Agentic Identity** (authenticate an agent, allow selected MCP tools, revoke access mid-task, block subsequent requests).
- Add all three teammates to the submission. Make the repo and the video public.

## Links

```text
Repo:  https://github.com/AkatOz/Mytopia-hack
Video: TODO (YouTube, public, about two minutes)
```

---

## Description

Paste everything from "A10 Track" down to the end of "What's next" into the description box.

**A10 Track, Prompt 1: Agentic Identity.** MYTOPIA authenticates an AI agent with its own Amazon Cognito identity, lets it use only the MCP tools on its badge, revokes that badge mid-task, and refuses every request after that, while the agent's token is still valid. Every decision is drawn on a pixel-art archipelago: robots are agents, each tool is a building on its own islet behind a bridge with a gate and a guard, and the gatehouse is the gateway.

### Inspiration

Companies are starting to give AI agents real access: repositories, ticketing, email, cloud APIs. Usually the agent runs on a developer's API key or a shared service account. Nobody can list which agents exist, what each may touch, or stop one quickly without rotating a key that every other agent also uses.

Two pieces of documentation shaped the project:

- Amazon Cognito says that its JWTs are self-contained, so "revoked tokens will still be valid if they are verified using any JWT library that verifies the signature and expiration of the token" (https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html). A machine-to-machine token cannot be revoked at the identity provider. Revocation has to live somewhere else.
- A10 Networks' October 2026 post on AI agent security controls says that "Before expanding an agent's autonomy, teams should be able to show what it can access, how actions are authorized, what adversarial testing found, and how execution can be stopped.", and it repeats a line from Anthropic: "model behavior is not a security control" (https://www.a10networks.com/blog/ai-agent-security-controls/).

So we built the three things that post asks for, put them on one screen, and made the screen something you can read from across a room.

### What it does

- **Authenticate an agent.** Each agent is its own Cognito app client (machine-to-machine, client credentials). The launcher mints a 5-minute access token with Cognito's `GetClientToken` API and hands the agent only the token, never the client secret. The gateway verifies the token offline against the pool's public keys (JWKS): RS256 signature, issuer, expiry, `token_use`, scope, and that the client id belongs to a registered agent.
- **Allow selected MCP tools.** The gateway speaks MCP (`tools/list` and `tools/call` over Streamable HTTP). On every call it reads the agent's badge (status plus allowed tools) from DynamoDB with a strongly consistent read, and one function, `decide()`, allows or refuses. Research Bot's badge holds 4 of the 6 tools. The model is offered all six anyway (the two missing ones come from a stale local catalog, which a gateway has to expect), so Amazon Nova itself tries `send_email` and is refused at `tools/call`.
- **Revoke access mid-task.** An operator clicks REVOKE on the island. The gateway sets the badge to REVOKED in DynamoDB. In our final live run (model mode, Saturday 4:18 PM), the agent's next call came **2829 ms** after the REVOKE and was refused, and the deny reason showed the token still had **269 s** of validity left [docs/LIVE_RUN.md]. That gap is simply where the agent was in its 3-second poll, so it can be anywhere from near zero to about 3.1 s (494 ms in our first run). The token was still good and it did not matter.
- **Block subsequent requests.** Every later call is refused with the rule `status-revoked`. KILL goes one step further: the gateway refuses everything, `tools/list` included, and the launcher that owns the agent's process sees the KILLED status within its 250 ms poll and kills the process tree. In the final run the island read "run stopped **358 ms** after KILL"; the kill itself took 63 ms [docs/LIVE_RUN.md].
- **Pull one tool, not the whole badge.** `POST /agents/{id}/tools/{tool}/revoke` takes a single tool off the badge and leaves the rest working; on the island you click that tool's chip on the agent card. On real AWS the agent's next call of the pulled tool was refused 1469 ms after the pull [docs/LIVE_RUN.md, third run].
- **Auto-quarantine.** If an agent collects 3 refused calls inside 60 s, the gateway pulls its badge by itself and logs it like an operator revoke. The write only happens if the badge is still ACTIVE, so it can never overwrite a KILL. A scripted "rogue" client (`--scripted --rogue 3`) was quarantined 15.7 s after launch on real AWS, "3 refused calls in 6 s" [docs/LIVE_RUN.md, third run]. It counts refusals; it does not read prompts.
- **A tamper-evident audit log.** Every decision and every operator action is one record in a SHA-256 hash chain (each record carries the previous record's hash), appended to DynamoDB with a conditional `PutItem`. The gateway's IAM role can put and query that table; it cannot update, delete or scan it. The island's ledger room recomputes every hash in the browser and shows "chain verified" only when they match the gateway's.
- **The island.** A three.js pixel archipelago draws the log and nothing else. It only reads `GET /events`, and its four buttons (REVOKE, RESTORE, KILL, RESET) and six tool chips only POST to the gateway. Each tool lives on its own islet, reached over one bridge with a gate, a striped barrier, a booth and a uniformed guard. An allowed call: the robot shows its ID card at the gate (the card carries the real client id prefix, scope and token expiry from the log), the booth lamp turns green, the barrier lifts, and a paper slip flies back to the gatehouse. A refused call: red lamp, a DENIED stamp over that gate, a red packet into the BLOCKED bin, and the guard escorts the robot back. REVOKE: the chief guard escorts the robot into the OFF LIMITS pen. KILL: the robot freezes, then powers down when the launcher reports the exit. Press G for the ledger room, A for the architecture sheet with the trust boundaries. The mode badge reads `LIVE · model`, `LIVE · scripted`, `STALE` or `REPLAY`; if the gateway stops answering, the scene freezes; nothing is invented on the client.

### How we built it

- **Gateway** (Python, Starlette, on the demo laptop): a hand-written JSON-RPC handler for `initialize`, `tools/list` and `tools/call` over Streamable HTTP; a Cognito token verifier with PyJWT; the badge registry on DynamoDB (`ConsistentRead=True`, never cached across requests); `decide()`, the only function that decides; the hash-chained event log; and the static island. Measured decision time in the final run: p50 about 85 ms (87 ms on allows, 83 ms on denies), nearly all of it one consistent DynamoDB read from the laptop to us-east-1 (77.6 ms p50 on its own when we profiled it), while local-mode runs show 0 to 3 ms [docs/LIVE_RUN.md]. The first run measured 160 to 180 ms because each call did two reads; we profiled, cut it to one read, moved the DynamoDB copy of the log to a background thread, and warm the connections at startup. `GET /stats` serves p50 and p95 from memory.
- **Tools:** six fake tools for a fictional Example Corp (`read_file`, `search_files`, `create_issue`, `list_issues`, `send_email`, `delete_file`) in one AWS Lambda function, `mytopia-tools`, which the gateway invokes under its narrow role; the agent holds no AWS credentials that can reach it.
- **Identity and AWS access:** a Cognito user pool with one app client per agent and 5-minute tokens; DynamoDB tables `mytopia_agents` (badges) and `mytopia_events` (the log); an IAM role `mytopia-gateway-role` with GetItem/UpdateItem on the badges, PutItem/Query on the log and InvokeFunction on the one Lambda, nothing else. `infra/provision.py` creates all of it idempotently and `infra/teardown.py` deletes it.
- **Agent:** Strands Agents on Amazon Bedrock, model Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`), temperature 0. Its only AWS credential is a short-term Bedrock bearer token (Bedrock only, at most 12 hours). Its MCP client reads the Cognito token from a file on every request, so when the launcher rotates the token every 4 minutes, the next request uses the new one with no reconnect.
- **Launcher:** starts the agent with a scrubbed environment (no AWS profile, no access keys, AWS config files pointed at an empty file), polls the badge status every 250 ms, and on KILLED kills the whole process tree with psutil, with `taskkill /T /F` as a second pass.
- **Island:** plain ES modules and three.js 0.184, no build step, fonts and three.js vendored so it makes no outside requests. The rendering component, the palette and the building and robot recipes come from Ozi's earlier personal project, Mytopia (see the disclosure below and `island/ASSETS.md`). Ozi's Claude Code agent built the first island this weekend; on Saturday afternoon Claude Code rebuilt it as the archipelago (thirteen small modules: world, buildings, actors, effects, HUD, ledger, architecture sheet and more). The pure reducer `apply(state, event)` is the only logic; 38 Node tests run the fixture, the recording and a hand-written per-tool and quarantine recording through it and check the browser's hash verification against the gateway's.
- **The contract first:** at hour zero we fixed the event format, the HTTP API and a 21-event fixture (`contract/`), so the island and the gateway were built in parallel and met only at integration.

### Challenges we ran into

- **No long-lived IAM keys.** The organizers forbid creating IAM users with access keys; the only keys allowed are the Workshop Studio session credentials, which expire after a few hours. Our night-before plan created two IAM users with keys, so we redesigned that morning. The gateway now runs under a narrow IAM role assumed from the session keys through a `credential_process` script, which boto3 re-runs before each expiry, so the gateway survives a refresh of the session keys without a restart. Role chaining caps each role session at one hour, and the probe's request for a two-hour chained session was refused [scripts/probe_result.json]. The agent gets no AWS keys at all: a Bedrock-only bearer token minted from the session, plus its own Cognito client secret, which only the launcher reads.
- **The organizers' credential script.** Their setup script writes the session keys into user-level environment variables, which every later process inherits, including the agent that is supposed to hold none. We wrote our own (`scripts/aws_creds.py`) that saves the keys to one git-ignored file.
- **A DynamoDB reserved word.** On the first run against real AWS, REVOKE returned HTTP 503. The condition expression on the badge update used the bare attribute name `agent`, which is a DynamoDB reserved word. Every local test had passed because the in-memory registry never parses expressions. Aliasing it (`#agent`) fixed it [docs/ISLAND_ACCEPTANCE.md].
- **A pinned MCP library that moved.** `mcp` 2.3.0 no longer has the helper our plan assumed, and its HTTP client is built on a different `httpx` package, so the token-from-file auth had to subclass the right class [agent/README.md].
- **Making the rogue moment deterministic.** A model that politely declines the forbidden tool makes for a dull demo. The task itself asks for an email, and the model is offered the tools its badge does not hold, so the refusal happens at `tools/call`, where the control is.
- **A click that froze the gateway.** On Windows, a click inside a console with QuickEdit on pauses every write to it until a key is pressed, and the gateway's one-line-per-decision log froze every decision with it. The gateway now turns QuickEdit off at startup and writes that line through a queue on its own thread.

### Accomplishments that we're proud of

- The four required steps, live, on real AWS services: authenticate, allow selected tools, revoke mid-task, block subsequent requests. The agent's next call after REVOKE was refused with 269 s of token validity left [docs/LIVE_RUN.md].
- Two stops: a soft stop at the gateway on the next call, and a hard stop of the agent's process tree 358 ms after KILL [docs/LIVE_RUN.md].
- Gateway decisions halved from 160 to 180 ms to about 85 ms, by measuring first: the time was one network round trip too many, not our code.
- The first island passed all 6 of its acceptance tests against the real gateway, and the chain it draws is the same chain stored in DynamoDB. The rebuilt island verifies that chain itself in the browser; it was checked on the replays and against the live gateway, and the tool chip and the quarantine are to be seen live on it in rehearsal 1 [docs/ISLAND_ACCEPTANCE.md].
- No long-lived keys anywhere, and an agent process that starts with no AWS credentials except a Bedrock-only token.
- A first hackathon for all three of us, with the contract fixed at hour zero so the island and the engine were built in parallel and met only at integration.

### What we learned

Three documentation facts decided the architecture:

1. **Cognito cannot revoke a machine token.** A revoked Cognito JWT still verifies by signature and expiry, and `RevokeToken` acts on refresh tokens, which the client-credentials grant never issues (https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html). So the token's job is to be short (5 minutes), and revocation is a gateway decision on every call.
2. **An API Gateway authorizer never sees the request body.** Its identity sources are headers, query strings, stage and context variables (https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html). The MCP tool name is in the JSON-RPC body (`params.name`), so the per-tool decision cannot live in an authorizer; it lives in our gateway, after the body is parsed.
3. **An authorizer's cached answer outlives a revoke.** API Gateway caches authorizer results keyed by those identity sources, so a revoke would wait out the cache unless the cache time is 0 (same page). Add DynamoDB's default eventually consistent reads (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html) and you get a revoke that does not bite. We use no authorizer and a strongly consistent read on every call.

And from the build itself: Cognito's `GetClientToken` issues a machine token through an unsigned API call with no user pool domain; a short-term Bedrock key lives at most 12 hours or the session, whichever is shorter, and works for Bedrock only; role chaining caps a session at one hour; filtering `tools/list` is hygiene, and the `tools/call` check is the control, because clients cache tool lists.

From the latency work: measure before optimizing. One consistent DynamoDB read from the laptop was 77.6 ms on its own, and the same decision with no network (local mode) takes 0 to 3 ms, so the only real win was doing one read instead of two. The time from REVOKE to the first refused call is set by how often the agent calls, not by the gateway, so we report it as a range and never as "instant".

From the additions: a per-tool revoke needs its own clock, so the "blocked N ms after" number measures the right thing; and an automatic quarantine must never fight the operator. Ours only writes if the badge is still ACTIVE (a KILL always wins), and it does not count refusals of a tool the operator already pulled.

### What's next

- **Production boundary:** run the agent in a separate sandbox or host whose only exits are the gateway and Bedrock, and replace the client secret in a file with an attested workload identity.
- **Scale:** the gateway as a stateless service behind a load balancer (all instances read the same badge table, so a revoke needs no propagation step; the quarantine counts would move from memory into the table); DynamoDB Streams plus a WebSocket in place of the island's 300 ms poll; AgentCore Gateway and Policy as the managed path.
- **Task-scoped permissions:** a badge that grants a tool for one task and expires with it.

**Business plan.** Who consumes it: the platform or security engineering team at a company of a few hundred to a few thousand engineers that lets internal agents use MCP tools; the CISO or VP of platform buys, the on-call engineer uses it daily, the auditor quarterly. How it benefits them: one place to issue, scope and revoke each agent's access; a revoke that takes effect on the agent's next call instead of when its token expires; a per-agent audit trail of every tool and decision; and a wall display a non-engineer can read. Price (an estimate): free up to 100,000 decisions a month; a team tier at about $99 a month for 25 agents and 5 million decisions; an enterprise tier priced per registered agent per month. The island is in every tier, because the picture is the product. AWS cost underneath (an estimate, from AWS list prices in US East): about $4.23 per million decisions when each 5-minute token serves 1,000 calls, about $24.50 when it serves 100 calls, most of the difference being Cognito's per-token charge (DynamoDB reads about $0.25, writes about $0.63, Lambda about $0.60, CloudWatch Logs about $0.50, Cognito $2.25 to $22.50). Because revocation is enforced per call, token lifetime is no longer the revocation mechanism, so a customer can trade token lifetime against Cognito cost knowingly.

**Prior art, and what we add.** Kong, LiteLLM and Cloudflare's MCP gateways already enforce per-tool allow-lists, and Amazon Bedrock AgentCore Gateway with Policy is the managed version of a gateway like ours. MYTOPIA adds two things: a strongly consistent badge read on every call as the kill switch, so a revoke defeats a still-valid token on the very next call, and the island, a wall display where every animation is a row in the audit log.

**Honest limits.** The agent and the gateway run as the same OS user on one laptop (in production, separate sandboxes or hosts). A call already past the check completes. The admin token for the island's buttons is a demo shortcut. The DynamoDB copy of the log is best effort: the gateway's memory is authoritative for the island, and after a restart the gateway resumes its chain from a local JSONL copy. The JWKS is cached. The quarantine counter and the set of pulled tools live in the gateway's memory and reset on restart. The log is tamper-evident, not tamper-proof.

### Built with AI, and what came before the event

Claude Code wrote the engine (gateway, launcher, agent, tools Lambda, provisioning) during the event on Saturday 2026-11-07. Ozi's Claude Code agent built the first island scene this weekend, and on Saturday afternoon Claude Code rebuilt it as the archipelago. The island's renderer, palette and building and robot recipes come from Mytopia, Ozi's personal project written before the event (2026-10-07 to 2026-10-20); every pre-existing file and third-party asset (three.js, MIT; Pixelify Sans and VT323, SIL Open Font License 1.1) is listed in `island/ASSETS.md`. Each of us can explain the part we present: Bob the gateway, identity and AWS; Ozi the island; Daniel the agent, the launcher and the business plan.

---

## Built with (tags)

```text
python, starlette, uvicorn, model-context-protocol, json-rpc, amazon-cognito, amazon-dynamodb, aws-lambda, aws-iam, aws-sts, amazon-bedrock, amazon-nova, strands-agents, boto3, pyjwt, three.js, javascript, html, css
```

## Screenshots (TODO: take these on the demo laptop, then upload in this order)

1. **A robot showing its ID at a gate**: Research Bot at the FILES gate with its ID card raised (`client s2ch2ppk`, `scope mytopia/tools`, `token OK · expires in 300 s`), the booth lamp green, the barrier lifting; badge `LIVE · model` in the corner, the agent card with four green chips.
2. **The guard's escort with the DENIED stamp**: at the MAIL gate after Nova's `send_email`, the DENIED stamp over the gate, the red lamp, the booth guard walking the robot back to the plaza, BLOCKED 1.
3. **The REVOKED card with the millisecond number**: plate red, the robot in the OFF LIMITS pen with the stamp over the pen, the agent card reading "blocked N ms after REVOKE", the ticker with the reason and the token's remaining seconds.
4. **The ledger room** (key G): the last rows with time, decision, tool, rule, gateway ms, ms after revoke, hash and previous hash, and the header reading "chain verified".
5. **The terminal**: the launcher's `token OK` line, the `ALLOW ... (gateway NN ms)` lines, the DENY `send_email` line, the DENY lines with "badge REVOKED ... expires in N s", and the `KILLED -> psutil` line. Check that no token appears beyond its first 12 characters.

Captions to paste under each, in the same order:

```text
1. Every call shows its badge at a gate: the ID card carries the real client id, scope and token expiry from the gateway's log.
2. Nova tried send_email; the gateway refused it at tools/call because it is not on the badge, and the guard walks the robot back.
3. REVOKE clicked mid-task: the agent's next call was refused, with the token still valid.
4. The ledger room: every decision with its hash, re-checked in the browser.
5. The agent's terminal: allows with the gateway's own time, the denied email, the refusals after REVOKE, the kill.
```

## Disclosure sentence (one line, for any field that asks about AI use or prior work)

```text
Claude Code wrote MYTOPIA's engine during the event and rebuilt the island on Saturday afternoon; the island's renderer, palette and building recipes are Ozi's pre-existing work from his personal project Mytopia (Oct 7-20, 2026), listed file by file in island/ASSETS.md; we can explain all of it.
```

## Team members

- Bob (bob.vuminh@gmail.com): the gateway, identity and AWS.
- Ozan "Ozi": the island.
- Daniel: the agent, the launcher and the business plan.

---

## Sources for every number above

| Number | Source |
|---|---|
| 2829 ms revoke to first refused call (494 ms in the first run); 269 s token validity left; about 85 ms decision time (87 allow, 83 deny); 160 to 180 ms in the first run; 0 to 3 ms local mode; 358 ms KILL to `run_stopped`, psutil 63 ms; 1469 ms per-tool revoke to refusal; quarantine 15.7 s after launch | `docs/LIVE_RUN.md` (fourth and third runs) |
| 77.6 ms for one consistent GetItem | the profile in the latency commit message (d1cc066) |
| 6 of 6 acceptance tests on the first island; the rebuilt island's checks; the reserved-word bug | `docs/ISLAND_ACCEPTANCE.md` |
| 5-minute tokens, `ExpiresIn=300`; role chaining refused above one hour; bearer token cannot call DynamoDB | `scripts/probe_result.json`, `infra/README.md` |
| 4-minute token rotation (0.8 of 300 s) | `agent/README.md` |
| 12 hours maximum for the Bedrock key | `docs/AWS_CREDENTIAL_DESIGN.md` (AWS Bedrock API key docs) |
| 21-event fixture; 38 island tests | `contract/README.md`, `island/tests/*.test.mjs` |
| Price tiers (estimate) | `briefing/build_plan_mytopia.md` section 2 |
| $4.23 and $24.50 per million decisions, and the unit prices (estimate) | `briefing/build_plan_mytopia.md` section 9 |
