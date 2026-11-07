# Stage slides (finalists, Sunday 11:00)

Five slides, shown after the live demo. The deck itself is `docs/slides.html` (open it in any browser, press F11, then the right arrow or a click to advance, the left arrow to go back). Each slide below lists its title, at most five bullets, what is on screen, who speaks, and a speaker note of under 60 words. Every number is from a file in the repo (cited) or labelled an estimate.

---

## Slide 1. MYTOPIA

**On screen:** the name large; the tagline under it; the track line in orange; the three names with their parts at the bottom. Cream paper background, ink border, no picture (the island has just been on screen during the demo).

- Pull an AI agent's badge and its next tool call is refused.
- A10 Track, Prompt 1: Agentic Identity.
- Authenticate an agent, allow selected MCP tools, revoke mid-task, block what follows.
- Bob: gateway, identity, AWS. Ozi: the island. Teammate #3: agent, launcher, business.

**Speaker (Bob), 49 words:** "We are MYTOPIA, A10 track, prompt one. You just watched an agent authenticate with its own Cognito identity, use the tools on its badge, get refused when it tried email, and get refused again on its next call after we pulled its badge, while its token was still valid."

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

**On screen:** a three-zone diagram drawn with boxes and arrows. Left zone "Agent (untrusted)": the agent process, with a tag "holds: 5-min Cognito token, Bedrock-only token". Middle zone "Operator laptop": launcher ("holds: client secret"), gateway ("decide(), JWKS cache, admin token"), island ("reads /events, buttons only POST"). Right zone "AWS us-east-1": Cognito, DynamoDB badges, DynamoDB log, Lambda tools, Bedrock. Arrows: agent to gateway `/mcp`; agent to Bedrock; gateway to DynamoDB and Lambda under the narrow role; launcher to Cognito `GetClientToken`. A dashed red line between agent and everything else.

- The agent's credentials open two things: the gateway's `/mcp` and Bedrock's model endpoint.
- Every call: verify the token offline (JWKS), read the badge (strongly consistent), `decide()`, log.
- Only the gateway's role reaches the badges, the log and the tools Lambda.
- The log is a SHA-256 hash chain written only by conditional PutItem: tamper-evident, not tamper-proof.
- Limit: agent and gateway share one OS user on this laptop; production separates them.

**Speaker (Bob), 53 words:** "The agent holds a five-minute token and a Bedrock-only key, nothing else. The client secret stays with the launcher. Every call is verified against Cognito's public keys, then the badge is read from DynamoDB with a consistent read, then one function decides. Honest limit: here the agent and gateway share an OS user."

---

## Slide 4. AWS, and what we learned

**On screen:** left column, a table of the five services with one line each (Cognito, DynamoDB, Lambda, Bedrock Nova 2 Lite, IAM/STS). Right column, a box titled "No long-lived keys" with the chain drawn top to bottom: "Workshop session keys" to "credential_process, AssumeRole, 1 h" to "mytopia-gateway-role (2 tables, 1 function)"; and beside it "session keys" to "short-term Bedrock token (Bedrock only, 12 h max)" to "agent". Bottom strip: "measured: about 160-180 ms per decision, 494 ms revoke to refusal" (docs/LIVE_RUN.md).

- Cognito: one app client per agent, 5-minute tokens from `GetClientToken`, no domain.
- DynamoDB: the badge read on every call is the kill switch; the log is append-only.
- Rule: no long-lived IAM keys. Gateway: narrow role assumed from session keys, re-assumed before each 1-hour expiry.
- Agent: no AWS keys, only a Bedrock-only bearer token; Nova 2 Lite through Strands.
- Learned: Cognito cannot revoke machine tokens; an authorizer never sees the tool name in the body.

**Speaker (Bob), 55 words:** "The organizers forbid long-lived keys, so the gateway assumes a narrow role from the session keys through a credential process that refreshes itself, and the agent gets only a Bedrock bearer token. We learned that Cognito cannot revoke machine tokens and an authorizer cannot see the tool name, so the decision lives in our gateway."

---

## Slide 5. Business, limits, next

**On screen:** three columns. "Who and price": buyer line, the three tiers, the AWS cost line marked "estimate". "Honest limits": four short lines. "Built vs used": what we wrote this weekend against what we used (Claude Code, Ozi's Mytopia renderer, three.js, two OFL fonts). Bottom line in orange: "Prior art: Kong, LiteLLM, Cloudflare, AgentCore. We add the per-call badge read as the kill switch, and the island."

- Buyer: platform and security teams letting agents use MCP tools; CISO buys, on-call uses.
- Price (estimate): free to 100k decisions/month; about $99/month team tier; per-agent enterprise.
- AWS cost (estimate): about $4 to $25 per million decisions, set by tokens per call.
- Limits: in-flight call completes; admin token is a demo shortcut; secret in a file, not attested identity.
- Next: separate agent sandbox, Streams instead of polling, task-scoped badges, AgentCore path.

**Speaker (teammate #3), 56 words:** "The buyer is the platform team that lets agents touch internal tools. Free to start, about ninety-nine dollars a month for a team, per agent for enterprise; AWS costs us roughly four to twenty-five dollars per million decisions, an estimate. Claude Code wrote the engine this weekend; the island renderer is Ozi's earlier project. Thank you."

---

## Sources

| On a slide | Source |
|---|---|
| 494 ms, about 160-180 ms, 254 s, about 1.3 s | `docs/LIVE_RUN.md` |
| 5-minute tokens, role chaining capped at 1 h | `scripts/probe_result.json`, `infra/README.md` |
| Bedrock token 12 h max, Bedrock only | `docs/AWS_CREDENTIAL_DESIGN.md` |
| The Cognito quote | https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html (as quoted in `briefing/build_plan_mytopia.md` and `briefing/judges/judge_mytopia_aws_solutions_architect.md`) |
| The A10 quote and the A10 ask (paraphrase) | https://www.a10networks.com/blog/ai-agent-security-controls/ (as quoted in `briefing/briefing_final.md`) |
| Price tiers (estimate) | `briefing/build_plan_mytopia.md` section 2 |
| $4 to $25 per million (estimate; $4.23 at 1,000 calls per token, $24.50 at 100) | `briefing/build_plan_mytopia.md` section 9 |
