# Stage slides (finalists, Sunday 11:00)

Six slides, shown after the live demo. The deck itself is `docs/slides.html` (open it in any browser, press F11, then the right arrow or a click to advance, the left arrow to go back). Each slide below lists its title, at most five bullets, what is on screen, who speaks, and a speaker note of under 60 words. Every number is from a file in the repo (cited) or labelled an estimate. Build 3 (Saturday night, `docs/BUILD3.md`) added slide 4, the identity lifecycle, one line each to slides 1, 5 and 6, and the Factory's permissions to the gateway role on slides 3 and 5; the rest is build 2's deck, still true.

---

## Slide 1. MYTOPIA

**On screen:** the name large; the tagline under it; the track line in orange; the four steps, and under them one smaller line for the additions; the three names with their parts at the bottom. Cream paper background, ink border, no picture (the island has just been on screen during the demo).

- Pull an AI agent's badge and its next tool call is refused.
- A10 Track, Prompt 1: Agentic Identity.
- Authenticate an agent, allow selected MCP tools, revoke mid-task, block what follows.
- Also: the Factory mints, ranks (Bronze to Diamond), inspects and retires agents; give or take one tool live; the gateway quarantines an agent after 3 refused calls in 60 s.
- Bob: gateway, identity, the Factory, AWS. Ozi: the island. Daniel: agent, launcher, business.

**Speaker (Bob), 51 words:** "We are MYTOPIA, A10 track, prompt one. You just watched an agent minted in the Factory as its own Cognito identity, use the tools on its badge, get refused above its tier, get quarantined by the gateway and inspected, killed by the launcher, and retired, while its token was still valid."

---

## Slide 2. The problem

**On screen:** two quote cards side by side, each with its source line underneath in small type: the Cognito sentence (red rule on the left edge) and the A10 sentence (orange rule). Under them, one ink line: "So revocation has to live in the gateway, on every call."

- Agents run on a developer's key or a shared service account: no one can list them, scope them, or stop one.
- Amazon Cognito: "revoked tokens will still be valid if they are verified using any JWT library that verifies the signature and expiration of the token." (docs.aws.amazon.com, Cognito token revocation)
- A10 Networks, quoting Anthropic: "model behavior is not a security control." (a10networks.com, AI agent security controls, Oct 2026)
- A10's ask: show what an agent can access, how its actions are authorized, how it can be stopped.

**Speaker (Bob), 53 words:** "Two sentences decided our design. Cognito says a revoked machine token still verifies until it expires, so you cannot revoke at the identity provider. A10 says model behavior is not a security control, so the model's good manners do not count. The answer is a deterministic check in the gateway, on every call."

---

## Slide 3. Architecture and trust boundaries

**On screen:** a three-zone diagram drawn with boxes and arrows. Left zone "Agent (untrusted)": the agent process, with a tag "holds: 5-min Cognito token, Bedrock-only token". Middle zone "Operator laptop": launcher ("holds: client secret"), gateway ("decide(), JWKS cache, admin token"), island ("reads /events, checks the chain; buttons and chips only POST"). Right zone "AWS us-east-1": Cognito, DynamoDB badges, DynamoDB log, Lambda tools, Bedrock. Arrows: agent to gateway `/mcp`; agent to Bedrock; gateway to DynamoDB and Lambda under the narrow role; launcher to Cognito `GetClientToken`. A dashed red line between agent and everything else.

- The agent's credentials open two things: the gateway's `/mcp` and Bedrock's model endpoint.
- Every call: verify the token offline (JWKS), read the badge (strongly consistent), `decide()`, log.
- Only the gateway's role reaches the badges (get and update; since build 3 also put, delete and scan, for the Factory), the log and the tools Lambda, and since build 3 it creates and deletes the pool's app clients; nothing else.
- The log is a SHA-256 hash chain written only by conditional PutItem: tamper-evident, not tamper-proof.
- Limit: agent and gateway share one OS user on this laptop; production separates them.

**Speaker (Bob), 53 words:** "The agent holds a five-minute token and a Bedrock-only key, nothing else. The client secret stays with the launcher. Every call is verified against Cognito's public keys, then the badge is read from DynamoDB with a consistent read, then one function decides. Honest limit: here the agent and gateway share an OS user."

---

## Slide 4. The identity lifecycle

**On screen:** one lead line ("Joiner, mover, leaver, for agents. Every step is one row in the same hash-chained log, and the agent's next call reads the new badge."), then a six-row table: the step, what happens in plain words, and the AWS call behind it in monospace. Under it one ink line: "No model in the loop: the ceiling is enforced by the gateway, the inquest is computed from the log. Measured on AWS: mint about 1.2 s, decision p50 79 ms, run stopped 113 ms after KILL (docs/LIVE_RUN.md, run 7)." Same cream paper, same table style as slide 5.

- Mint: the Factory form (name, tier, tools, colour, role); one Cognito app client per agent and one badge row; the secret goes only to the launcher's file (`CreateUserPoolClient`, `PutItem` with `attribute_not_exists`).
- Tier: Bronze, Silver, Gold, Diamond are ceilings, the most a badge may ever hold; promote opens the padlock, demote trims the badge to the ceiling; above the ceiling the gateway answers 403 and writes nothing, even to the operator (`UpdateItem`).
- Grant and pull one tool live from a chip (`UpdateItem` on the tool list); revoke and kill: the badge is read on every call, so the next call is refused, and the launcher kills the process tree; 3 refused calls in 60 s and the gateway revokes by itself (`UpdateItem` on the status, conditional).
- Inquest: the run's report (calls, refusals, who pulled the badge and when, the timings, the verdict) computed from the chain by a fixed function; the browser computes the same counts and timings from the same rows; no AWS call, no model.
- Retire: the identity deleted, the badge row removed, the env lines gone, the roster forgets it (`DeleteUserPoolClient`, `DeleteItem`).

**Speaker (Bob), 58 words:** "Joiner, mover, leaver, for agents. The Factory creates a Cognito app client and a badge row and writes the secret only to the launcher's file. A tier is a ceiling the gateway enforces even against us. Grants, pulls, revokes and kills are one write each. The inquest is computed from the chain, no model. Retire deletes the identity."

---

## Slide 5. AWS, and what we learned

**On screen:** left column, a table of the five services with one line each (Cognito, DynamoDB, Lambda, Bedrock Nova 2 Lite, IAM/STS). Right column, a box titled "No long-lived keys" with the chain drawn top to bottom: "Workshop session keys" to "credential_process, AssumeRole, 1 h" to "mytopia-gateway-role (2 tables, 1 function, the app clients of 1 pool)"; and beside it "session keys" to "short-term Bedrock token (Bedrock only, 12 h max)" to "agent". Bottom strip: "measured: about 85 ms per decision, token still valid 269 s, run stopped 358 ms after KILL" (docs/LIVE_RUN.md, the 4:18 PM model-mode run).

- Cognito: one app client per agent (the Factory creates and deletes them), 5-minute tokens from `GetClientToken`, no domain.
- DynamoDB: one badge read on every call is the kill switch, for the whole badge or one tool; the Factory adds and removes badge rows; the log is append-only.
- Rule: no long-lived IAM keys. Gateway: narrow role assumed from session keys, re-assumed before each 1-hour expiry.
- Agent: no AWS keys, only a Bedrock-only bearer token; Nova 2 Lite through Strands.
- Learned: Cognito cannot revoke machine tokens; an authorizer never sees the tool name in the body.

**Speaker (Bob), 55 words:** "The organizers forbid long-lived keys, so the gateway assumes a narrow role from the session keys through a credential process that refreshes itself, and the agent gets only a Bedrock bearer token. We learned that Cognito cannot revoke machine tokens and an authorizer cannot see the tool name, so the decision lives in our gateway."

---

## Slide 6. Business, limits, next

**On screen:** three columns. "Who and price": buyer line, the three tiers, the AWS cost line marked "estimate". "Honest limits": four short lines. "Built vs used": what we wrote this weekend against what we used (Claude Code, which wrote the engine and built the island; Ozi's Mytopia renderer and recipes; three.js; two OFL fonts). Bottom line in orange: "Prior art: Kong, LiteLLM, Cloudflare, AgentCore. We add the per-call badge read as the kill switch, and the island."

- Buyer: platform and security teams letting agents use MCP tools; CISO buys, on-call uses.
- Price (estimate): free to 100k decisions/month; about $99/month team tier; per-agent enterprise.
- AWS cost (estimate): about $4 to $25 per million decisions, set by tokens per call.
- Limits: in-flight call completes; admin token is a demo shortcut; the minted secret in a file stands in for a secrets manager and attested identity.
- Next: separate agent sandbox, Streams instead of polling, task-scoped badges, AgentCore path.

**Speaker (Daniel), 59 words:** "The buyer is the platform team that lets agents touch internal tools. Free to start, about ninety-nine dollars a month for a team, per agent for enterprise; AWS costs us roughly four to twenty-five dollars per million decisions, an estimate. Claude Code wrote the engine and built the island this weekend; the renderer is Ozi's earlier project. Thank you."

---

## Sources

| On a slide | Source |
|---|---|
| about 85 ms, 269 s, 358 ms (the 4:18 PM model-mode run); 3 refused calls in 60 s (`QUARANTINE_AFTER`, `QUARANTINE_WINDOW_S`) | `docs/LIVE_RUN.md`, `gateway/.env.example` |
| The tier ceilings; the 403 above the ceiling; the trimmed badge on demotion; the secret's path to the launcher's file; retire's two deletes; the DynamoDB and Cognito calls behind each step | `gateway/tiers.py` (= `island/src/tiers.js`), `gateway/factory.py`, `gateway/identity.py`, `gateway/registry.py`, `contract/README.md` |
| The inquest's fields and sentences, computed from the chain | `docs/BUILD3.md` section 2.4, `gateway/factory.py`, `island/src/reducer.js` |
| Mint about 1.2 s, p50 79 ms, 113 ms to `run_stopped` (the Factory run on AWS) | `docs/LIVE_RUN.md`, run 7 |
| 5-minute tokens, role chaining capped at 1 h | `scripts/probe_result.json`, `infra/README.md` |
| Bedrock token 12 h max, Bedrock only | `docs/AWS_CREDENTIAL_DESIGN.md` |
| The Cognito quote | https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html (as quoted in `briefing/build_plan_mytopia.md` and `briefing/judges/judge_mytopia_aws_solutions_architect.md`, the team's private planning files, not in the repo) |
| The A10 quote and the A10 ask (paraphrase) | https://www.a10networks.com/blog/ai-agent-security-controls/ (as quoted in `briefing/briefing_final.md`, a private planning file, not in the repo) |
| Price tiers (estimate) | `briefing/build_plan_mytopia.md` section 2 (the team's private planning file, not in the repo) |
| $4 to $25 per million (estimate; $4.23 at 1,000 calls per token, $24.50 at 100) | `briefing/build_plan_mytopia.md` section 9 (the same private file) |
