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

**A10 Track, Prompt 1: Agentic Identity.** MYTOPIA authenticates an AI agent with its own Amazon Cognito identity, lets it use only the MCP tools on its badge, revokes that badge mid-task, and refuses every request after that, while the agent's token is still valid. Every decision is drawn on a pixel-art island: robots are agents, buildings are tools, and the gatehouse is the gateway.

### Inspiration

Companies are starting to give AI agents real access: repositories, ticketing, email, cloud APIs. Usually the agent runs on a developer's API key or a shared service account. Nobody can list which agents exist, what each may touch, or stop one quickly without rotating a key that every other agent also uses.

Two pieces of documentation shaped the project:

- Amazon Cognito says that its JWTs are self-contained, so "revoked tokens will still be valid if they are verified using any JWT library that verifies the signature and expiration of the token" (https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html). A machine-to-machine token cannot be revoked at the identity provider. Revocation has to live somewhere else.
- A10 Networks' October 2026 post on AI agent security controls says that "Before expanding an agent's autonomy, teams should be able to show what it can access, how actions are authorized, what adversarial testing found, and how execution can be stopped.", and it repeats a line from Anthropic: "model behavior is not a security control" (https://www.a10networks.com/blog/ai-agent-security-controls/).

So we built the three things that post asks for, put them on one screen, and made the screen something you can read from across a room.

### What it does

- **Authenticate an agent.** Each agent is its own Cognito app client (machine-to-machine, client credentials). The launcher mints a 5-minute access token with Cognito's `GetClientToken` API and hands the agent only the token, never the client secret. The gateway verifies the token offline against the pool's public keys (JWKS): RS256 signature, issuer, expiry, `token_use`, scope, and that the client id belongs to a registered agent.
- **Allow selected MCP tools.** The gateway speaks MCP (`tools/list` and `tools/call` over Streamable HTTP). On every call it reads the agent's badge (status plus allowed tools) from DynamoDB with a strongly consistent read, and one function, `decide()`, allows or refuses. Research Bot's badge holds 4 of the 6 tools. The model is offered all six anyway (the two missing ones come from a stale local catalog, which a gateway has to expect), so Amazon Nova itself tries `send_email` and is refused at `tools/call`.
- **Revoke access mid-task.** An operator clicks REVOKE on the island. The gateway sets the badge to REVOKED in DynamoDB. In our live run, the agent's next call was refused **494 ms** after the click, and the deny reason showed the token still had **254 s** of validity left [docs/LIVE_RUN.md]. The token was still good and it did not matter.
- **Block subsequent requests.** Every later call is refused with the rule `status-revoked`. KILL goes one step further: the gateway refuses everything, `tools/list` included, and the launcher that owns the agent's process sees the KILLED status and kills the process tree. In the live run the process was gone about **1.3 s** after KILL (the island read "run stopped 1274 ms after KILL") [docs/LIVE_RUN.md].
- **A tamper-evident audit log.** Every decision and every operator action is one record in a SHA-256 hash chain (each record carries the previous record's hash), appended to DynamoDB with a conditional `PutItem`. The gateway's IAM role can put and query that table; it cannot update, delete or scan it.
- **The island.** A three.js pixel island draws the log and nothing else. It only reads `GET /events`, and its four buttons (REVOKE, RESTORE, KILL, RESET) only POST to the gateway. A green spark is an allowed call, a red fizzle at the gatehouse with a DENIED stamp is a refused one, a red chest plate is a revoked badge, fire on a building is a killed run. If the gateway stops answering, the badge in the corner turns STALE and the scene freezes; nothing is invented on the client.

### How we built it

- **Gateway** (Python, Starlette, on the demo laptop): a hand-written JSON-RPC handler for `initialize`, `tools/list` and `tools/call` over Streamable HTTP; a Cognito token verifier with PyJWT; the badge registry on DynamoDB (`ConsistentRead=True`, never cached across requests); `decide()`, the only function that decides; the hash-chained event log; and the static island. Measured decision time was about 160 to 180 ms per call in the live run, nearly all of it the consistent DynamoDB read from the laptop to us-east-1; local-mode runs show 1 to 3 ms [docs/LIVE_RUN.md].
- **Tools:** six fake tools for a fictional Example Corp (`read_file`, `search_files`, `create_issue`, `list_issues`, `send_email`, `delete_file`) in one AWS Lambda function, `mytopia-tools`, which the gateway invokes under its narrow role; the agent holds no AWS credentials that can reach it.
- **Identity and AWS access:** a Cognito user pool with one app client per agent and 5-minute tokens; DynamoDB tables `mytopia_agents` (badges) and `mytopia_events` (the log); an IAM role `mytopia-gateway-role` with GetItem/UpdateItem on the badges, PutItem/Query on the log and InvokeFunction on the one Lambda, nothing else. `infra/provision.py` creates all of it idempotently and `infra/teardown.py` deletes it.
- **Agent:** Strands Agents on Amazon Bedrock, model Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`), temperature 0. Its only AWS credential is a short-term Bedrock bearer token (Bedrock only, at most 12 hours). Its MCP client reads the Cognito token from a file on every request, so when the launcher rotates the token every 4 minutes, the next request uses the new one with no reconnect.
- **Launcher:** starts the agent with a scrubbed environment (no AWS profile, no access keys, AWS config files pointed at an empty file), polls the badge status every second, and on KILLED runs `taskkill /T /F` on the whole process tree.
- **Island:** plain ES modules and three.js 0.184, no build step, fonts and three.js vendored so it makes no outside requests. The rendering component and the building and robot shapes come from Ozi's earlier personal project, Mytopia (see the disclosure below and `island/ASSETS.md`). The pure reducer `apply(state, event)` is the only logic; 12 Node tests run the 21-event fixture through it.
- **The contract first:** at hour zero we fixed the event format, the HTTP API and a 21-event fixture (`contract/`), so the island and the gateway were built in parallel and met only at integration.

### Challenges we ran into

- **No long-lived IAM keys.** The organizers forbid creating IAM users with access keys; the only keys allowed are the Workshop Studio session credentials, which expire after a few hours. Our night-before plan created two IAM users with keys, so we redesigned that morning. The gateway now runs under a narrow IAM role assumed from the session keys through a `credential_process` script, which boto3 re-runs before each expiry, so the gateway survives a refresh of the session keys without a restart. Role chaining caps each role session at one hour, and the probe's request for a two-hour chained session was refused [scripts/probe_result.json]. The agent gets no AWS keys at all: a Bedrock-only bearer token minted from the session, plus its own Cognito client secret, which only the launcher reads.
- **The organizers' credential script.** Their setup script writes the session keys into user-level environment variables, which every later process inherits, including the agent that is supposed to hold none. We wrote our own (`scripts/aws_creds.py`) that saves the keys to one git-ignored file.
- **A DynamoDB reserved word.** On the first run against real AWS, REVOKE returned HTTP 503. The condition expression on the badge update used the bare attribute name `agent`, which is a DynamoDB reserved word. Every local test had passed because the in-memory registry never parses expressions. Aliasing it (`#agent`) fixed it [docs/ISLAND_ACCEPTANCE.md].
- **A pinned MCP library that moved.** `mcp` 2.3.0 no longer has the helper our plan assumed, and its HTTP client is built on a different `httpx` package, so the token-from-file auth had to subclass the right class [agent/README.md].
- **Making the rogue moment deterministic.** A model that politely declines the forbidden tool makes for a dull demo. The task itself asks for an email, and the model is offered the tools its badge does not hold, so the refusal happens at `tools/call`, where the control is.

### Accomplishments that we're proud of

- The four required steps, live, on real AWS services: authenticate, allow selected tools, revoke mid-task, block subsequent requests. Revoke to first refused call: 494 ms, with 254 s of token validity left [docs/LIVE_RUN.md].
- Two stops: a soft stop at the gateway on the next call, and a hard stop of the agent's process tree about 1.3 s after KILL [docs/LIVE_RUN.md].
- The island passed all 6 of its acceptance tests against the real gateway, and the chain it draws is the same chain stored in DynamoDB [docs/ISLAND_ACCEPTANCE.md].
- No long-lived keys anywhere, and an agent process that starts with no AWS credentials except a Bedrock-only token.
- A first hackathon for all three of us, with the contract fixed at hour zero so the island and the engine were built in parallel and met only at integration.

### What we learned

Three documentation facts decided the architecture:

1. **Cognito cannot revoke a machine token.** A revoked Cognito JWT still verifies by signature and expiry, and `RevokeToken` acts on refresh tokens, which the client-credentials grant never issues (https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html). So the token's job is to be short (5 minutes), and revocation is a gateway decision on every call.
2. **An API Gateway authorizer never sees the request body.** Its identity sources are headers, query strings, stage and context variables (https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html). The MCP tool name is in the JSON-RPC body (`params.name`), so the per-tool decision cannot live in an authorizer; it lives in our gateway, after the body is parsed.
3. **An authorizer's cached answer outlives a revoke.** API Gateway caches authorizer results keyed by those identity sources, so a revoke would wait out the cache unless the cache time is 0 (same page). Add DynamoDB's default eventually consistent reads (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html) and you get a revoke that does not bite. We use no authorizer and a strongly consistent read on every call.

And from the build itself: Cognito's `GetClientToken` issues a machine token through an unsigned API call with no user pool domain; a short-term Bedrock key lives at most 12 hours or the session, whichever is shorter, and works for Bedrock only; role chaining caps a session at one hour; filtering `tools/list` is hygiene, and the `tools/call` check is the control, because clients cache tool lists.

### What's next

- **Production boundary:** run the agent in a separate sandbox or host whose only exits are the gateway and Bedrock, and replace the client secret in a file with an attested workload identity.
- **Scale:** the gateway as a stateless service behind a load balancer (all instances read the same badge table, so a revoke needs no propagation step); DynamoDB Streams plus a WebSocket in place of the island's one-second poll; AgentCore Gateway and Policy as the managed path.
- **Task-scoped permissions:** a badge that grants a tool for one task and expires with it.

**Business plan.** Who consumes it: the platform or security engineering team at a company of a few hundred to a few thousand engineers that lets internal agents use MCP tools; the CISO or VP of platform buys, the on-call engineer uses it daily, the auditor quarterly. How it benefits them: one place to issue, scope and revoke each agent's access; a revoke that takes effect on the agent's next call instead of when its token expires; a per-agent audit trail of every tool and decision; and a wall display a non-engineer can read. Price (an estimate): free up to 100,000 decisions a month; a team tier at about $99 a month for 25 agents and 5 million decisions; an enterprise tier priced per registered agent per month. The island is in every tier, because the picture is the product. AWS cost underneath (an estimate, from AWS list prices in US East): about $4.23 per million decisions when each 5-minute token serves 1,000 calls, about $24.50 when it serves 100 calls, most of the difference being Cognito's per-token charge (DynamoDB reads about $0.25, writes about $0.63, Lambda about $0.60, CloudWatch Logs about $0.50, Cognito $2.25 to $22.50). Because revocation is enforced per call, token lifetime is no longer the revocation mechanism, so a customer can trade token lifetime against Cognito cost knowingly.

**Prior art, and what we add.** Kong, LiteLLM and Cloudflare's MCP gateways already enforce per-tool allow-lists, and Amazon Bedrock AgentCore Gateway with Policy is the managed version of a gateway like ours. MYTOPIA adds two things: a strongly consistent badge read on every call as the kill switch, so a revoke defeats a still-valid token on the very next call, and the island, a wall display where every animation is a row in the audit log.

**Honest limits.** The agent and the gateway run as the same OS user on one laptop (in production, separate sandboxes or hosts). A call already past the check completes. The admin token for the island's buttons is a demo shortcut. The DynamoDB copy of the log is best effort: the gateway's memory is authoritative for the island, and after a restart the gateway resumes its chain from a local JSONL copy. The JWKS is cached. The log is tamper-evident, not tamper-proof.

### Built with AI, and what came before the event

Claude Code wrote the engine (gateway, launcher, agent, tools Lambda, provisioning) during the event on Saturday 2026-11-07, and Ozi's Claude Code agent built the island scene this weekend. The island's renderer and its building and robot shapes come from Mytopia, Ozi's personal project written before the event (2026-10-07 to 2026-10-20); every pre-existing file and third-party asset (three.js, MIT; Pixelify Sans and VT323, SIL Open Font License 1.1) is listed in `island/ASSETS.md`. Each of us can explain the part we present: Bob the gateway, identity and AWS; Ozi the island; Daniel the agent, the launcher and the business plan.

---

## Built with (tags)

```text
python, starlette, uvicorn, model-context-protocol, json-rpc, amazon-cognito, amazon-dynamodb, aws-lambda, aws-iam, aws-sts, amazon-bedrock, amazon-nova, strands-agents, boto3, pyjwt, three.js, javascript, html, css
```

## Screenshots (TODO: take these on the demo laptop, then upload in this order)

1. **The island LIVE mid-run**: badge LIVE in the corner, green sparks to Files or GitHub, the agent card reading AUTHENTICATED and "badge: 4 of 6 tools".
2. **The DENIED stamp**: the red fizzle at the gatehouse after Nova's `send_email`, BLOCKED 1, smoke over Mail, the speech bubble with the reason.
3. **The REVOKED card with the millisecond number**: plate red, robot at the rope, the card reading "blocked N ms after REVOKE" and the reason with the token's remaining seconds.
4. **The terminal**: the launcher's `token OK` line, the ALLOW lines, the DENY `send_email` line, the DENY lines with "badge REVOKED ... expires in N s", and the `KILLED -> taskkill` line. Check that no token appears beyond its first 12 characters.
5. **The DynamoDB console rows**: table `mytopia_events`, the run's chain, items showing `seq`, `decision`, `rule`, `prev_hash` and `hash`. Crop out the account id.

Captions to paste under each, in the same order:

```text
1. The island live: every spark is one allowed tools/call through the gateway.
2. Nova tried send_email; the gateway refused it at tools/call because it is not on the badge.
3. REVOKE clicked mid-task: the next call was refused, with the token still valid.
4. The agent's terminal: allows, the denied email, the refusals after REVOKE, the kill.
5. The same decisions in DynamoDB, each record carrying the hash of the one before.
```

## Disclosure sentence (one line, for any field that asks about AI use or prior work)

```text
Claude Code wrote MYTOPIA's engine during the event, and the island's renderer is Ozi's pre-existing work from his personal project Mytopia (Oct 7-20, 2026), listed file by file in island/ASSETS.md; we can explain all of it.
```

## Team members

- Bob (bob.vuminh@gmail.com): the gateway, identity and AWS.
- Ozan "Ozi": the island.
- Daniel: the agent, the launcher and the business plan.

---

## Sources for every number above

| Number | Source |
|---|---|
| 494 ms revoke to first refused call; 254 s token validity left; about 160 to 180 ms decision time; 1 to 3 ms local mode; about 1.3 s and 1274 ms kill to process gone | `docs/LIVE_RUN.md` |
| 6 of 6 island acceptance tests; the reserved-word bug | `docs/ISLAND_ACCEPTANCE.md` |
| 5-minute tokens, `ExpiresIn=300`; role chaining refused above one hour; bearer token cannot call DynamoDB | `scripts/probe_result.json`, `infra/README.md` |
| 4-minute token rotation (0.8 of 300 s) | `agent/README.md` |
| 12 hours maximum for the Bedrock key | `docs/AWS_CREDENTIAL_DESIGN.md` (AWS Bedrock API key docs) |
| 21-event fixture; 12 reducer tests | `contract/README.md`, `island/tests/reducer.test.mjs` |
| Price tiers (estimate) | `briefing/build_plan_mytopia.md` section 2 |
| $4.23 and $24.50 per million decisions, and the unit prices (estimate) | `briefing/build_plan_mytopia.md` section 9 |
