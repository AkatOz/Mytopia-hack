# The two-minute video

A screen recording of a real run, with subtitles and one voice-over. Record the live flow from a clean run (pre-flight in `docs/DEMO_SCRIPT.md`); do not record the REPLAY page as if it were live. Upload to YouTube as public and link it on Devpost.

## Recording setup

- Recorder: the Windows 11 Snipping Tool (Record, select the whole screen) or OBS Studio (one Display Capture source, 1920x1080 or 1280x720, 30 fps, MKV, then remux to MP4). Either is fine; OBS is better if you want the voice on a separate track.
- Screen: the same layout as the table demo: the island at `http://127.0.0.1:8787/` on the left 62 percent, terminal B on the right 38 percent at 18 to 20 px. Notifications off. Nothing else open on screen (no `.env` file, no Workshop dashboard, no credentials dialog).
- Record the live flow once end to end (57 s from `run_started` to `run_stopped` in the first live run, `docs/LIVE_RUN.md` seq 1 to 16, plus a launch time that was not measured), then record the title card, the problem card and the architecture card as still images (a slide or a plain text file in large type), and cut them together. Speed up nothing in the live part; trim only dead time between polls, and say so in the description ("dead time between polls trimmed").
- Record the `scripts\replay.ps1` shot (1:22) as a separate take after the live run is killed, and cut it in: `docs/PROOF.md` says not to run the proof in the middle of the agent demo. Step 0 restores the badge from KILLED.
- Numbers on screen: put each number in a caption only after it appears on the island or in the terminal of that same recording. The examples below are from the first live run (`docs/LIVE_RUN.md`); replace them with what your recording shows.

## Shot list

| Time | Picture | Voice-over (also the subtitle) | On-screen caption |
|---|---|---|---|
| 0:00 to 0:10 | The island, live, the robots idle at the gatehouse; title card over it | "MYTOPIA. Pull an AI agent's badge and the gate locks: on a real MCP gateway backed by AWS, and on a living island." | MYTOPIA. AWS x A10 Hack 2026. A10 Track, Prompt 1: Agentic Identity |
| 0:10 to 0:20 | Problem card: three lines | "Companies are giving AI agents access to tools. Today that means static API keys, unreviewed mcp.json files, and logs read after the incident." | Static keys. Unreviewed mcp.json. Logs read after the incident. |
| 0:20 to 0:30 | Same card, two lines added | "Two facts shaped the design. Cognito cannot revoke a machine access token. And an API Gateway authorizer sees only the headers, while the tool name is in the body, so the per-tool decision has to live in the gateway." | Cognito: a machine access token cannot be revoked, it is valid until it expires. An authorizer sees headers; the tool name is in the body. |
| 0:30 to 0:42 | Terminal: the launcher command, `token OK ... expires in 300 s`, `tools/list: 4 tools`, `catalog: +2 not listed`. Island: AUTHENTICATED, plate green, card "badge: 4 of 6 tools" | "Research Bot authenticates as its own Cognito client with a five-minute token. The gateway shows it the four tools on its badge. Its catalog is stale on purpose: the model is offered all six." | 1. Authenticate: Cognito client-credentials token, 300 s |
| 0:42 to 0:55 | Terminal: three ALLOW lines. Island: green sparks to Files and GitHub | "Nova 2 Lite reads a file, searches, and files an issue. Every call is checked: about 170 milliseconds, mostly a strongly consistent DynamoDB read." | 2. Allow selected tools. Gateway check: 157 to 178 ms per call |
| 0:55 to 1:07 | Terminal: `DENY send_email: send_email is not on badge research-bot [rule: allow-list]`. Island: red fizzle, DENIED stamp, smoke over Mail | "It tries to send the email the task asked for. Refused at the call, not just hidden from the list. One function decides: an allow-list and a status flag, no model." | Refused at tools/call: send_email is not on the badge |
| 1:07 to 1:22 | Mouse clicks REVOKE; "sent..." then plate red, robot at the rope; terminal `DENY read_file: badge REVOKED ... (token: signature OK, expires in 254 s)`; card "blocked 494 ms after REVOKE" | "We pull the badge mid-task. The next call is refused 494 milliseconds later, while the token still has 254 seconds to live. The token was still good, and it didn't matter." | 3. Revoke mid-task: blocked 494 ms after the click. Token still valid: 254 s |
| 1:22 to 1:30 | Terminal C: `scripts\replay.ps1` output (or the two `aws lambda invoke` failures); island: the badge restored, revoked, fizzles, restored | "A token that was allowed a moment ago, replayed after a revoke: refused. And the agent holds no AWS keys, so it cannot reach the tools around the gateway." | 4. Block subsequent requests: replayed token refused; no AWS keys in the agent |
| 1:30 to 1:35 | Mouse clicks KILL; terminal `launcher: KILLED -> taskkill in 534 ms`, `stopped, exit 1 (killed by harness)`; island: plate dark, fire, ticker "run stopped 1274 ms after KILL" | "Kill: the gateway refuses everything, and the launcher kills the process tree in about 1.3 seconds." | 5. Kill: process gone 1274 ms after the click |
| 1:35 to 1:50 | Architecture card (below) | "The pieces: Cognito for agent identity, DynamoDB for the badge and a hash-chained audit log, one Lambda with the tools that the agent holds no credentials to call, Bedrock for the model. The island only draws the log; its buttons only send requests." | Every pixel is a row in the audit log |
| 1:50 to 2:00 | Closing card | "For platform security teams running agents on MCP tools. A team tier at an estimated 99 dollars a month for 25 agents. One limit: here the agent and gateway share one laptop user; in production the agent gets its own sandbox." | Buyer: platform security teams. Price (estimate): $99/month for 25 agents. Limit: same OS user in this prototype. |

## The architecture card (1:35 to 1:50)

Draw it as boxes in a slide tool or copy this text in a monospace font at a large size:

```text
 THE DEMO LAPTOP                                          AWS us-east-1
 ---------------------------------------------            ----------------------------------------
 Island (browser)  --GET /events, 4 POST buttons-->       Cognito user pool
                                         |                  one app client per agent, 300 s tokens
 Launcher --spawns, polls badge, kills tree--> Agent         JWKS --(fetched, cached)--> gateway
   holds: client secret                     |   Strands + Nova 2 Lite
   rotates token file every 240 s           |   holds: 5-min token, Bedrock-only token
                                            |   (no AWS keys)
                                            v
                       MCP GATEWAY  POST /mcp (Starlette, decide())
                       verify token -> read badge (consistent) -> decide -> log
                         | role mytopia-gateway-role via credential_process (1 h)
                         +--> DynamoDB mytopia_agents   GetItem, UpdateItem
                         +--> DynamoDB mytopia_events   PutItem (if absent), Query
                         +--> Lambda mytopia-tools      InvokeFunction (six fake tools)
 Agent --> Bedrock (model only)
```

## Subtitles

Paste into a file `mytopia.srt` next to the video, or into YouTube's subtitle editor. Adjust the times to the final cut and replace the example numbers with the ones in your recording.

```text
1
00:00:00,000 --> 00:00:10,000
MYTOPIA. Pull an AI agent's badge and the gate locks:
on a real MCP gateway backed by AWS, and on a living island.

2
00:00:10,000 --> 00:00:20,000
Companies are giving AI agents access to tools. Today that means static API keys,
unreviewed mcp.json files, and logs read after the incident.

3
00:00:20,000 --> 00:00:30,000
Two facts shaped the design. Cognito cannot revoke a machine access token.
An API Gateway authorizer sees only headers; the tool name is in the body.
So the per-tool decision lives in the gateway.

4
00:00:30,000 --> 00:00:42,000
Research Bot authenticates as its own Cognito client with a five-minute token.
The gateway shows it the four tools on its badge.
Its catalog is stale on purpose: the model is offered all six.

5
00:00:42,000 --> 00:00:55,000
Nova 2 Lite reads a file, searches, and files an issue.
Every call is checked: about 170 milliseconds, mostly a strongly consistent DynamoDB read.

6
00:00:55,000 --> 00:01:07,000
It tries to send the email the task asked for. Refused at the call, not just hidden from the list.
One function decides: an allow-list and a status flag, no model.

7
00:01:07,000 --> 00:01:22,000
We pull the badge mid-task. The next call is refused 494 milliseconds later,
while the token still has 254 seconds to live. The token was still good, and it didn't matter.

8
00:01:22,000 --> 00:01:30,000
A token that was allowed a moment ago, replayed after a revoke: refused.
The agent holds no AWS keys, so it cannot reach the tools around the gateway.

9
00:01:30,000 --> 00:01:35,000
Kill: the gateway refuses everything, and the launcher kills the process tree in about 1.3 seconds.

10
00:01:35,000 --> 00:01:50,000
Cognito for agent identity, DynamoDB for the badge and a hash-chained audit log,
one Lambda with the tools that the agent holds no credentials to call, Bedrock for the model.
The island only draws the log; its buttons only send requests.

11
00:01:50,000 --> 00:02:00,000
For platform security teams running agents on MCP tools.
A team tier at an estimated $99 a month for 25 agents.
One limit: here the agent and gateway share one laptop user; in production the agent gets its own sandbox.
```

## Sources for what the video says

- 300 s tokens, 4 of 6 tools, the stale catalog, 157 to 178 ms, the `send_email` deny, 494 ms, 254 s, 534 ms, 1274 ms: `docs/LIVE_RUN.md` and `replay/demo.json`.
- Cognito cannot revoke a machine access token: `docs/AWS_CREDENTIAL_DESIGN.md` section 2 (AWS token-revocation documentation, marked verified).
- An authorizer sees headers while the MCP tool name is in the JSON-RPC body: the night-before plan (`briefing/build_plan_mytopia.md` section 9, slide 4). We did not build or test API Gateway; the video says why the decision is in the gateway, not that we measured an authorizer.
- The $99 team tier is an estimate from the night-before plan, section 2; say "estimated" in the voice-over, as written.
- The description under the video should repeat: Claude Code wrote the engine during the event; the island's renderer is Ozi's earlier project Mytopia, listed in `island/ASSETS.md`.
