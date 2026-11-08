# Devpost submission, ready to paste

Every field of the form, in the order Devpost usually asks for them. Numbers come from files in this repo (cited in brackets, delete the brackets when pasting if you like) or are labelled estimates. The gateway's measured numbers are from Saturday's five live runs (`docs/LIVE_RUN.md`, runs 1 to 5); the island's new parts change none of them. The Factory flow's own timings are from its first live run on AWS, run 7 in the same file (Saturday 7:55 PM; run 6 is the same flow in local mode). Before pasting, fill the two `TODO` lines (video link, screenshots).

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

**A10 Track, Prompt 1: Agentic Identity.** MYTOPIA is the place a company manages its AI agents' identities: it mints them, ranks them, gives and takes their tools, stops them, inspects the ones that misbehaved, and retires them. Each agent is its own Amazon Cognito identity. The gateway lets it use only the MCP tools on its badge, revokes that badge mid-task, and refuses every request after that while the agent's token is still valid. Every decision is drawn on a pixel-art archipelago: robots are agents, each tool is a building on its own islet behind a bridge with a gate and a guard, the gatehouse is the gateway, and the Factory island to the south is where agents are made, ranked, inspected and retired.

### Inspiration

Companies are starting to give AI agents real access: repositories, ticketing, email, cloud APIs. Usually the agent runs on a developer's API key or a shared service account. Nobody can list which agents exist, what each may touch, or stop one quickly without rotating a key that every other agent also uses.

Two pieces of documentation shaped the project:

- Amazon Cognito says that its JWTs are self-contained, so "revoked tokens will still be valid if they are verified using any JWT library that verifies the signature and expiration of the token" (https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html). A machine-to-machine token cannot be revoked at the identity provider. Revocation has to live somewhere else.
- A10 Networks' October 2026 post on AI agent security controls says that "Before expanding an agent's autonomy, teams should be able to show what it can access, how actions are authorized, what adversarial testing found, and how execution can be stopped.", and it repeats a line from Anthropic: "model behavior is not a security control" (https://www.a10networks.com/blog/ai-agent-security-controls/).

So we built the things that post asks for, put them on one screen, and made the screen something you can read from across a room. Then we asked what a company would need the morning after: a place where agents are created, ranked, changed and removed, and where the record of a bad run can be read. Identity teams call that joiner, mover, leaver. Our third build added it for agents: the Factory.

### What it does

- **Authenticate an agent.** Each agent is its own Cognito app client (machine-to-machine, client credentials). The launcher mints a 5-minute access token with Cognito's `GetClientToken` API and hands the agent only the token, never the client secret. The gateway verifies the token offline against the pool's public keys (JWKS): RS256 signature, issuer, expiry, `token_use`, scope, and that the client id belongs to a registered agent.
- **Allow selected MCP tools.** The gateway speaks MCP (`tools/list` and `tools/call` over Streamable HTTP). On every call it reads the agent's badge (status, tier and allowed tools) from DynamoDB with a strongly consistent read, and one function, `decide()`, allows or refuses. Research Bot's Silver badge holds 4 of the 6 tools. In model mode the model is offered all six anyway (the two missing ones come from a stale local catalog, which a gateway has to expect), so Amazon Nova itself tries `send_email` and is refused at `tools/call`.
- **Revoke access mid-task.** An operator clicks REVOKE on the island. The gateway sets the badge to REVOKED in DynamoDB. In our recorded live run (model mode, Saturday 4:18 PM), the agent's next call came **2829 ms** after the REVOKE and was refused, and the deny reason showed the token still had **269 s** of validity left [docs/LIVE_RUN.md, run 4]. That gap is simply where the agent was in its 3-second poll, so it can be anywhere from near zero to about 3.1 s (494 ms in our first run). The token was still good and it did not matter.
- **Block subsequent requests.** Every later call is refused with the rule `status-revoked`. KILL goes one step further: the gateway refuses everything, `tools/list` included, and the launcher that owns the agent's process sees the KILLED status within its 250 ms poll and kills the process tree. In the recorded run the island read "run stopped **358 ms** after KILL"; the kill itself took 63 ms [docs/LIVE_RUN.md, run 4].
- **Mint an agent.** The Factory office form (name, tier, tools, colour, one line of role) POSTs to the gateway, which creates one Cognito app client for the new agent (client credentials, 5-minute tokens, the same parameters as the two seed agents), writes its badge row to DynamoDB with a conditional `PutItem` (`attribute_not_exists`), writes the client id and secret only into the launcher's env file on the laptop (never over HTTP, never in a response, an event or a log line) and logs a `created` row. If any step after the client exists fails, the client is deleted again: nothing is left half-made. The launcher then starts the new agent by name, and the island's production line builds its robot. On AWS the mint took about 1.2 s (one Cognito call, one DynamoDB write) and the new agent's `run_started` came 1.5 s later [docs/LIVE_RUN.md, run 7].
- **Rank it: tiers as ceilings.** Bronze (read_file, search_files: looks, never changes anything), Silver (plus the two ticket tools: reads and files tickets), Gold (plus send_email: may speak for the company), Diamond (plus delete_file: the only tier that can delete). A tier is the most a badge may ever hold. A grant above the ceiling is refused by the gateway with HTTP 403 and a sentence ("delete_file is above the Gold ceiling"), even when the operator asks, and nothing is written. A demotion trims the badge to the new ceiling in the same write; a promotion opens the padlock and grants nothing by itself. The seed agents are Silver (Research Bot) and Bronze (Ops Bot).
- **Give and take one tool, live.** All six chips on the agent card are buttons: a green one pulls that tool off the badge (`POST /agents/{id}/tools/{tool}/revoke`), a paper one grants it (`.../restore`, which also adds a tool that was never on the badge), a padlocked one is above the tier and shows the gateway's 403. Each change is one write to the badge row and one row in the log; the agent's next call reads the new badge. On real AWS the agent's next call of a pulled tool was refused **1469 ms** after the pull [docs/LIVE_RUN.md, run 3]; with the patrol, which re-reads its list each cycle, a pulled tool was refused exactly once, 11,572 ms after the pull, then dropped out of the list, and a granted tool was allowed on the next cycle [docs/LIVE_RUN.md, run 7].
- **Auto-quarantine.** If an agent collects 3 refused calls inside 60 s, the gateway pulls its badge by itself and logs it like an operator revoke. The write only happens if the badge is still ACTIVE, so it can never overwrite a KILL, and refusals of a tool the operator pulled or a demotion trimmed are not counted: the operator already acted on those. A scripted "rogue" client (`--scripted --rogue 3`) was quarantined 15.7 s after launch on real AWS, "3 refused calls in 6 s" [docs/LIVE_RUN.md, run 3]. It counts refusals; it does not read prompts.
- **Inspect it: the inquest.** `GET /agents/{id}/inquest` is a report of the agent's latest run, computed from the hash chain in the gateway's memory by a fixed function: identity and tier, calls allowed and refused, the refused tools by count and rule, the first refusal, the trigger (a quarantine by the gateway, or a revoke or kill by the operator, with its time), the timings (revoke to first refusal, kill to stop, the gateway's median decision time), whether the agent's rows verify, a verdict sentence and a recommendation. The island computes the same counts, trigger and timings from the same rows in the browser (`inquestOf`) and types the report out line by line in a panel while the robot stands in the inspection bay, when the gateway quarantines an agent or the operator kills one; the panel's raw report link opens the gateway's own JSON (the island's verdict sentence lists every refused tool, the gateway's names the most-refused one). No model writes any of it; every line can be checked against the rows it came from.
- **Retire it.** `POST /agents/{id}/retire` deletes the Cognito app client, deletes the badge row, removes the two lines from the launcher's env file and logs `retired`. On the island the robot is wheeled into the Factory and the roster forgets it. The two seed agents cannot be retired; RESET retires every Factory-made agent and reseeds the two.
- **A tamper-evident audit log.** Every decision, every operator action and every Factory action is one record in a SHA-256 hash chain (each record carries the previous record's hash), appended to DynamoDB with a conditional `PutItem`. The gateway's IAM role can put and query that table; it cannot update, delete or scan it. The island's ledger room recomputes every hash in the browser and shows "chain verified" only when they match the gateway's; its TAMPER TEST changes one character of a copy, shows every link after it break, then redraws the real log, untouched.
- **The island.** A three.js pixel archipelago draws the log and nothing else. It reads `GET /events` (plus the roster and the tier table), and its buttons only POST to the gateway. Each tool lives on its own islet, reached over one bridge with a gate, a striped barrier, a booth and a uniformed guard. An allowed call: the robot shows its ID card at the gate (the card carries the real client id prefix, scope and token expiry from the log), the booth lamp turns green, the barrier lifts, and a paper slip flies back to the gatehouse. A refused call: red lamp, a DENIED stamp over that gate, a red packet into the BLOCKED bin, and the guard escorts the robot back. REVOKE: the chief guard escorts the robot into the OFF LIMITS pen. A quarantine: the chief escorts it over the south bridge into the Factory's inspection bay, where the inquest is typed out. KILL: the robot freezes, powers down when the launcher reports the exit, and the Factory cart carries it to the bay. Minting builds the robot on the Factory floor (press, head, paint in its colour, the tier medal stamped, one token per tool) and it rolls out to the yard; retiring wheels it back in. Every building opens into a cutaway room in 3D you can rotate, with boards painted from the log and the roster: the ledger and the hash-chain exhibit in the gatehouse; who may do what here, and how often it happened today, in each tool's building; every agent and its badge on the Factory office whiteboard. A click on a robot shows sentences, not JSON (where it is, its last action in words, its calls, its badge as chips); the four operator buttons carry plain subtitles; H hides every panel; ? opens a one-minute help sheet. The mode badge reads `LIVE · model`, `LIVE · scripted`, `STALE` or `REPLAY`; if the gateway stops answering, the scene freezes; nothing is invented on the client.

### How we built it

- **Gateway** (Python, Starlette, on the demo laptop): a hand-written JSON-RPC handler for `initialize`, `tools/list` and `tools/call` over Streamable HTTP; a Cognito token verifier with PyJWT; the badge registry on DynamoDB (`ConsistentRead=True`, never cached across requests); `decide()`, the only function that decides; the hash-chained event log; the Factory (`gateway/factory.py`: mint, grant and pull, tier changes, retire, and the inquest); the identity module (`gateway/identity.py`: Cognito `CreateUserPoolClient` and `DeleteUserPoolClient` with the same parameters as our provisioning script, or a local naming rule); the shared tier table (`gateway/tiers.py`, the same table as the island's `tiers.js`); and the static island. Measured decision time: p50 about 85 ms (87 ms on allows, 83 ms on denies), nearly all of it one consistent DynamoDB read from the laptop to us-east-1 (77.6 ms p50 on its own when we profiled it), while local-mode runs show 0 to 3 ms [docs/LIVE_RUN.md]. The first run measured 160 to 180 ms because each call did two reads; we profiled, cut it to one read, moved the DynamoDB copy of the log to a background thread, and warm the connections at startup and after every reset (the first call after a reset: 81 ms, run 5). `GET /stats` serves p50 and p95 from memory.
- **Tools:** six fake tools for a fictional Example Corp (`read_file`, `search_files`, `create_issue`, `list_issues`, `send_email`, `delete_file`) in one AWS Lambda function, `mytopia-tools`, which the gateway invokes under its narrow role; the agent holds no AWS credentials that can reach it.
- **Identity and AWS access:** a Cognito user pool with one app client per agent and 5-minute tokens; DynamoDB tables `mytopia_agents` (badges, now with tier, role, made_by and created_at) and `mytopia_events` (the log); an IAM role `mytopia-gateway-role` with GetItem, UpdateItem, PutItem, DeleteItem and Scan on the badges, PutItem and Query on the log, InvokeFunction on the one Lambda, and CreateUserPoolClient and DeleteUserPoolClient on the one pool, nothing else. `infra/provision.py` creates all of it idempotently, `infra/role_policy.py` applies the role's inline policy on its own, and `infra/teardown.py` deletes everything, Factory-made clients included.
- **Agent:** Strands Agents on Amazon Bedrock, model Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`), temperature 0. Its only AWS credential is a short-term Bedrock bearer token (Bedrock only, at most 12 hours). Its MCP client reads the Cognito token from a file on every request, so when the launcher rotates the token every 4 minutes, the next request uses the new one with no reconnect. A scripted mode runs the same calls without a model; `--patrol` makes it ask for its tool list at the start of each cycle and call each listed tool once, one every 3 s, never a tool the list did not return; `--rogue N` tries the refused email N times in all, one second apart, to show the quarantine.
- **Launcher:** starts the agent with a scrubbed environment (no AWS profile, no access keys, AWS config files pointed at an empty file), reads the agent's client id and secret from its env file (for a minted agent, the lines the Factory wrote), polls the badge status every 250 ms, and on KILLED kills the whole process tree with psutil, with `taskkill /T /F` as a second pass.
- **Island:** plain ES modules and three.js 0.184, no build step, fonts and three.js vendored so it makes no outside requests. The rendering component, the palette and the building and robot recipes come from Ozi's earlier personal project, Mytopia (see the disclosure below and `island/ASSETS.md`). Ozi's Claude Code agent built the first island this weekend; on Saturday afternoon Claude Code rebuilt it as the archipelago, and on Saturday night added the Factory island, the interiors and the plain-word HUD (sixteen small modules: world, buildings, factory, actors, effects, HUD, rooms, ledger, tiers, the architecture sheet and more). The rooms paint their text on 2048-pixel canvas textures, and the rendering component gained one method, `setPixel`, so a room renders at full resolution while it is open. The pure reducer `apply(state, event)` is the only logic; 66 Node tests run the fixture, the two real recordings (the 4:18 PM model-mode run and the Factory run on AWS) and two hand-written ones (a per-tool revoke and a quarantine; the Factory story) through it, check the browser's hash verification against the gateway's, check the island's inquest against the gateway's for the Factory run, and check the text of every room's board. The gateway has 189 pytest tests.
- **The contract first:** at hour zero we fixed the event format, the HTTP API and a 21-event fixture (`contract/`), so the island and the gateway were built in parallel and met only at integration. Build 3 extended the same contract (three new decisions, one new rule, the tier table, the inquest's shape) before either side wrote code.

### Challenges we ran into

- **No long-lived IAM keys.** The organizers forbid creating IAM users with access keys; the only keys allowed are the Workshop Studio session credentials, which expire after a few hours. Our night-before plan created two IAM users with keys, so we redesigned that morning. The gateway now runs under a narrow IAM role assumed from the session keys through a `credential_process` script, which boto3 re-runs before each expiry, so the gateway survives a refresh of the session keys without a restart. Role chaining caps each role session at one hour, and the probe's request for a two-hour chained session was refused [scripts/probe_result.json]. The agent gets no AWS keys at all: a Bedrock-only bearer token minted from the session, plus its own Cognito client secret, which only the launcher reads.
- **The organizers' credential script.** Their setup script writes the session keys into user-level environment variables, which every later process inherits, including the agent that is supposed to hold none. We wrote our own (`scripts/aws_creds.py`) that saves the keys to one git-ignored file.
- **A DynamoDB reserved word.** On the first run against real AWS, REVOKE returned HTTP 503. The condition expression on the badge update used the bare attribute name `agent`, which is a DynamoDB reserved word. Every local test had passed because the in-memory registry never parses expressions. Aliasing it (`#agent`) fixed it [docs/ISLAND_ACCEPTANCE.md].
- **A pinned MCP library that moved.** `mcp` 2.3.0 no longer has the helper our plan assumed, and its HTTP client is built on a different `httpx` package, so the token-from-file auth had to subclass the right class [agent/README.md].
- **Making the rogue moment deterministic.** A model that politely declines the forbidden tool makes for a dull demo. The task itself asks for an email, and the model is offered the tools its badge does not hold, so the refusal happens at `tools/call`, where the control is.
- **A click that froze the gateway.** On Windows, a click inside a console with QuickEdit on pauses every write to it until a key is pressed, and the gateway's one-line-per-decision log froze every decision with it. The gateway now turns QuickEdit off at startup and writes that line through a queue on its own thread.
- **Tiers against the quarantine.** Once the operator can pull tools and demote badges, an agent that keeps calling a tool it just lost would trip the quarantine on the operator's own action. The gateway now marks the tools the operator pulled or a demotion trimmed and does not count their refusals, and the patrol re-reads its tool list at the start of each cycle and never calls a tool the list did not return, so a pulled tool is refused at most once (the cycle's stale list) and then drops out.
- **Readable text in a half-resolution renderer.** The island renders at half resolution for the pixel look, which blurred any text painted inside a 3D room. The rooms paint their boards on 2048-pixel canvas textures, and the stage component gained one method, `setPixel`, so a room renders at full resolution while it is open and the island returns to half when you leave.

### Accomplishments that we're proud of

- The four required steps, live, on real AWS services: authenticate, allow selected tools, revoke mid-task, block subsequent requests. The agent's next call after REVOKE was refused with 269 s of token validity left [docs/LIVE_RUN.md].
- Two stops: a soft stop at the gateway on the next call, and a hard stop of the agent's process tree 358 ms after KILL [docs/LIVE_RUN.md].
- A whole identity lifecycle for agents on Cognito and DynamoDB: mint, rank, grant and pull, revoke, kill, inspect, retire, each one a row in the same hash chain, with a ceiling the gateway enforces even against the operator and a forensic report no model writes. Its first live run on AWS took 87 s end to end: mint 1.2 s, decision p50 79 ms with the Factory rows in the chain, kill to process gone 116 ms, retire 200 with the Cognito client gone [docs/LIVE_RUN.md, run 7].
- Gateway decisions halved from 160 to 180 ms to about 85 ms, by measuring first: the time was one network round trip too many, not our code.
- The first island passed all 6 of its acceptance tests against the real gateway, and the chain it draws is the same chain stored in DynamoDB. The rebuilt island verifies that chain itself in the browser and can show a judge what a tampered copy looks like [docs/ISLAND_ACCEPTANCE.md].
- No long-lived keys anywhere, and an agent process that starts with no AWS credentials except a Bedrock-only token.
- A first hackathon for all three of us, with the contract fixed at hour zero so the island and the engine were built in parallel and met only at integration, three times over.

### What we learned

Three documentation facts decided the architecture:

1. **Cognito cannot revoke a machine token.** A revoked Cognito JWT still verifies by signature and expiry, and `RevokeToken` acts on refresh tokens, which the client-credentials grant never issues (https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html). So the token's job is to be short (5 minutes), and revocation is a gateway decision on every call.
2. **An API Gateway authorizer never sees the request body.** Its identity sources are headers, query strings, stage and context variables (https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html). The MCP tool name is in the JSON-RPC body (`params.name`), so the per-tool decision cannot live in an authorizer; it lives in our gateway, after the body is parsed.
3. **An authorizer's cached answer outlives a revoke.** API Gateway caches authorizer results keyed by those identity sources, so a revoke would wait out the cache unless the cache time is 0 (same page). Add DynamoDB's default eventually consistent reads (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html) and you get a revoke that does not bite. We use no authorizer and a strongly consistent read on every call.

And from the build itself: Cognito's `GetClientToken` issues a machine token through an unsigned API call with no user pool domain; a short-term Bedrock key lives at most 12 hours or the session, whichever is shorter, and works for Bedrock only; role chaining caps a session at one hour; filtering `tools/list` is hygiene, and the `tools/call` check is the control, because clients cache tool lists.

From the latency work: measure before optimizing. One consistent DynamoDB read from the laptop was 77.6 ms on its own, and the same decision with no network (local mode) takes 0 to 3 ms, so the only real win was doing one read instead of two. The time from REVOKE to the first refused call is set by how often the agent calls, not by the gateway, so we report it as a range and never as "instant".

From the additions: a per-tool revoke needs its own clock, so the "blocked N ms after" number measures the right thing; and an automatic quarantine must never fight the operator. Ours only writes if the badge is still ACTIVE (a KILL always wins), and it does not count refusals of a tool the operator already pulled or a demotion trimmed.

From the Factory: a tier is only worth something if the gateway enforces it against the operator too; the 403 above the ceiling is the sentence that makes "least privilege by rank" true. And a forensic report computed from the log is more honest than one a model writes about a model: every line of the inquest can be checked against the rows it came from.

### What's next

- **Production boundary:** run the agent in a separate sandbox or host whose only exits are the gateway and Bedrock, and replace the client secret in a file with a secrets manager and an attested workload identity.
- **Scale:** the gateway as a stateless service behind a load balancer (all instances read the same badge table, so a revoke needs no propagation step; the quarantine counts would move from memory into the table); DynamoDB Streams plus a WebSocket in place of the island's 300 ms poll; AgentCore Gateway and Policy as the managed path.
- **Task-scoped permissions:** a badge that grants a tool for one task and expires with it.
- **Identity hygiene for agents:** an expiry on every badge, rotation of the minted client secrets, and the inquest sent to the team's ticketing on every quarantine.
- **The Factory on a managed path:** AgentCore identity and policy for the lifecycle, with the per-call badge read and the tiers kept as ours.

**Business plan.** Who consumes it: the platform or security engineering team at a company of a few hundred to a few thousand engineers that lets internal agents use MCP tools; the CISO or VP of platform buys, the on-call engineer uses it daily, the auditor quarterly. How it benefits them: one place to issue, rank, scope, revoke and retire each agent's access; a revoke that takes effect on the agent's next call instead of when its token expires; a per-agent audit trail of every tool and decision, with a report of each bad run computed from it; and a wall display a non-engineer can read. Tiers are least privilege by rank: a Bronze badge can be granted nothing beyond reading, and a Gold badge cannot be given delete even by the operator, so a reviewer approves a rank once instead of every tool. Price (an estimate): free up to 100,000 decisions a month; a team tier at about $99 a month for 25 agents and 5 million decisions; an enterprise tier priced per registered agent per month. The island is in every tier, because the picture is the product. AWS cost underneath (an estimate, from AWS list prices in US East): about $4.23 per million decisions when each 5-minute token serves 1,000 calls, about $24.50 when it serves 100 calls, most of the difference being Cognito's per-token charge (DynamoDB reads about $0.25, writes about $0.63, Lambda about $0.60, CloudWatch Logs about $0.50, Cognito $2.25 to $22.50). Because revocation is enforced per call, token lifetime is no longer the revocation mechanism, so a customer can trade token lifetime against Cognito cost knowingly.

**Prior art, and what we add.** Kong, LiteLLM and Cloudflare's MCP gateways already enforce per-tool allow-lists, and Amazon Bedrock AgentCore Gateway with Policy is the managed version of a gateway like ours. MYTOPIA adds three things: a strongly consistent badge read on every call as the kill switch, so a revoke defeats a still-valid token on the very next call; the identity lifecycle of agents, from mint to retire, as one place you can walk through; and the island, a wall display where every animation is a row in the audit log.

**Honest limits.** The agent and the gateway run as the same OS user on one laptop (in production, separate sandboxes or hosts). A call already past the check completes. The admin token for the island's buttons, chips and form is a demo shortcut. The client secret the Factory mints is written to the launcher's env file on the laptop; it stands in for a secrets manager. The Factory's IAM permissions were applied once by hand with `infra/role_policy.py`; without them minting on AWS fails closed with 503. Retiring deletes the Cognito client on a best-effort basis; if that call fails, the badge row still goes and the event says so. The DynamoDB copy of the log is best effort: the gateway's memory is authoritative for the island and for the inquest, and after a restart the gateway resumes its chain from a local JSONL copy. The JWKS is cached. The quarantine counter and the set of pulled tools live in the gateway's memory and reset on restart. The log is tamper-evident, not tamper-proof; the island's TAMPER TEST changes a copy in the browser.

### Built with AI, and what came before the event

Claude Code wrote the engine (gateway, launcher, agent, tools Lambda, provisioning) during the event on Saturday 2026-11-07, and the Factory, the tiers and the inquest on Saturday night. Ozi's Claude Code agent built the first island scene this weekend; on Saturday afternoon Claude Code rebuilt it as the archipelago, and on Saturday night added the Factory island, the seven interiors and the plain-word HUD. The island's renderer, palette and building and robot recipes come from Mytopia, Ozi's personal project written before the event (2026-10-07 to 2026-10-20); the renderer gained one method (`setPixel`) on Saturday night and is otherwise unchanged; every pre-existing file and third-party asset (three.js, MIT; Pixelify Sans and VT323, SIL Open Font License 1.1) is listed in `island/ASSETS.md`. Each of us can explain the part we present: Bob the gateway, identity, the Factory and AWS; Ozi the island; Daniel the agent, the launcher and the business plan.

---

## Built with (tags)

```text
python, starlette, uvicorn, model-context-protocol, json-rpc, amazon-cognito, amazon-dynamodb, aws-lambda, aws-iam, aws-sts, amazon-bedrock, amazon-nova, strands-agents, boto3, pyjwt, three.js, javascript, html, css
```

## Screenshots (TODO: take these on the demo laptop during rehearsal 2, then upload in this order)

1. **The Factory floor building a robot**: the production line mid-build: the conveyor, the paint booth spraying the chassis teal, the badge desk stamping the gold medal, the tool tokens on the robot's back, the wall board `BUILDING: Billing Bot · Gold · 4 tools`.
2. **The inquest in the bay**: a robot on the inspection bay's lift, the chief walking home, the panel `INSPECTION · Research Bot` typed out to its verdict and recommendation, the status pill QUARANTINED on the card.
3. **The ledger room with the chain exhibit**: THE LEDGER chalkboard with its header `✓ chain verified`, the receipts on their cords with sage links and the caption "Every receipt carries the fingerprint of the one before it"; or mid-TAMPER TEST, with one receipt `✗ changed` and the brick links after it.
4. **A gate refusal with the guard**: at the MAIL gate, the DENIED stamp over the gate, the red lamp, the booth guard walking the robot back to the plaza, the REFUSED counter on the booth, BLOCKED in the bin.
5. **The agent card with its chips**: Billing Bot's card: the gold medal and "Gold badge · may speak for the company", `4 of 6 tools · ceiling 5`, four green chips, the paper `send_email` with "+ grant", the padlocked `delete_file` with "Diamond only", the PROMOTE and DEMOTE arrows, the badge `LIVE · scripted`.

Captions to paste under each, in the same order:

```text
1. The Factory floor: minting an agent is one Cognito app client and one badge row; the line builds the robot while the gateway writes them.
2. The inspection bay: the gateway quarantined this agent after three refused calls; the report is computed from the hash chain, no model writes it.
3. The ledger room: every decision with its hash, re-checked in the browser; the tamper test breaks a copy and shows every link after it fail.
4. A refused call: the tool is not on the badge, the gateway said no at tools/call, and the guard walks the robot back.
5. The badge as buttons: green pulls, paper grants, and the padlock is the tier's ceiling, which the gateway refuses to cross.
```

Check that no screenshot shows `agent/.env` (it holds a minted client secret) or a token beyond its first 12 characters.

## Disclosure sentence (one line, for any field that asks about AI use or prior work)

```text
Claude Code wrote MYTOPIA's engine during the event and built the island's archipelago, Factory and interiors on Saturday; the island's renderer, palette and building recipes are Ozi's pre-existing work from his personal project Mytopia (Oct 7-20, 2026), listed file by file in island/ASSETS.md (the renderer gained one method, setPixel, during the event); we can explain all of it.
```

## Team members

- Bob (bob.vuminh@gmail.com): the gateway, identity, the Factory and AWS.
- Ozan "Ozi": the island.
- Daniel: the agent, the launcher and the business plan.

---

## Sources for every number above

| Number | Source |
|---|---|
| 2829 ms revoke to first refused call (494 ms in the first run); 269 s token validity left; about 85 ms decision time (87 allow, 83 deny); 160 to 180 ms in the first run; 0 to 3 ms local mode; 358 ms KILL to `run_stopped`, psutil 63 ms; 1469 ms per-tool revoke to refusal; quarantine 15.7 s after launch, "3 refused calls in 6 s"; 81 ms first call after a reset | `docs/LIVE_RUN.md` (runs 1 to 5) |
| The Factory flow on AWS: mint 201 in 1.2 s, `run_started` 1.5 s after it; a pulled tool refused once, 11,572 ms after the pull; p50 79 ms over 42 decisions; psutil kill 116 ms, 113 ms to `run_stopped`; retire 200; 87 s end to end | `docs/LIVE_RUN.md` (run 7; run 6 is the same flow in local mode) |
| 77.6 ms for one consistent GetItem | the profile table in `docs/LIVE_RUN.md` (3:10 PM) |
| The tier ceilings, the 403 above the ceiling, the trimmed badge on demotion, the secret's path to the env file, retire's two deletes | `gateway/tiers.py` (= `island/src/tiers.js`), `gateway/factory.py`, `gateway/identity.py`, `contract/README.md` |
| The inquest's fields and sentences | `docs/BUILD3.md` section 2.4, `gateway/factory.py`, `island/src/reducer.js` |
| 3 refused calls in 60 s; refusals of pulled or trimmed tools not counted | `gateway/.env.example` (`QUARANTINE_AFTER`, `QUARANTINE_WINDOW_S`), `gateway/mcp.py`, `gateway/factory.py` |
| The gateway role's permissions, including the Factory's | `infra/provision.py`, `infra/role_policy.py` |
| 6 of 6 acceptance tests on the first island; the rebuilt island's checks; the reserved-word bug; the build-3 checklist | `docs/ISLAND_ACCEPTANCE.md` |
| 5-minute tokens, `ExpiresIn=300`; role chaining refused above one hour; bearer token cannot call DynamoDB | `scripts/probe_result.json`, `infra/README.md` |
| 4-minute token rotation (0.8 of 300 s) | `agent/README.md` |
| 12 hours maximum for the Bedrock key | `docs/AWS_CREDENTIAL_DESIGN.md` (AWS Bedrock API key docs) |
| 21-event fixture; 66 island tests; 189 pytest tests | `contract/README.md`, `island/tests/*.test.mjs`, `tests/` |
| Price tiers (estimate) | `briefing/build_plan_mytopia.md` section 2 (the team's private planning file, not in the repo) |
| $4.23 and $24.50 per million decisions, and the unit prices (estimate) | `briefing/build_plan_mytopia.md` section 9 (the same private file) |
