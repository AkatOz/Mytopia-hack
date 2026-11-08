# The two-minute video

A screen recording of a real run, with subtitles and one voice-over, in the six beats of `docs/DEMO_SCRIPT.md`. Record the live flow (pre-flight there; the gateway role already holds the Factory's permissions, so the Factory mints on AWS as it did in run 7 of `docs/LIVE_RUN.md`). Do not record the REPLAY page as if it were live, and do not pass off `tests/factory.json` (a hand-written test recording) as a run. Upload to YouTube as public and link it on Devpost.

## Recording setup

- Recorder: the Windows 11 Snipping Tool (Record, select the whole screen) or OBS Studio (one Display Capture source, 1920x1080 or 1280x720, 30 fps, MKV, then remux to MP4). Either is fine; OBS is better if you want the voice on a separate track.
- Screen: the demo layout: the island at `http://127.0.0.1:8787/` on the left 62 percent, terminal B on the right 38 percent at 18 to 20 px; terminal C (the rogue client) as a second tab you switch to for beat 4. Notifications off. Nothing else on screen: no `agent\.env` (it holds the minted client secret), no Workshop dashboard, no credentials dialog.
- Record the six beats once end to end, live. The Factory floor build plays only in the browser that clicked BUILD, so click BUILD in the recorded browser. Trim only dead time between patrol calls and say so in the description ("dead time between calls trimmed"). Speed up nothing.
- Then record the title card, the problem card and the closing card as still images (a slide or a plain text file in large type) and cut them together.
- Numbers on screen: caption a number only after it appears on the island or in the terminal of that same recording. The gateway's numbers from Saturday's runs may be spoken as "about": decision p50 about 85 ms, KILL to `run_stopped` 358 ms in the recorded build-2 run (`docs/LIVE_RUN.md`, run 4). The Factory flow's own numbers come from the recorded run, which gets its own number in `docs/LIVE_RUN.md` (run 7 was its first on AWS: p50 79 ms, "3 refused calls in 6 s", KILL to `run_stopped` 113 ms, psutil 116 ms; check what you see against it); the placeholders below stand for them: [M] the gateway p50 on the strip, [Q] the quarantine's "3 refused calls in N s", [K] the KILL-to-`run_stopped` ms on the ticker, [P] the launcher's psutil ms.

## Shot list

| Time | Picture | Voice-over (also the subtitle) | On-screen caption |
|---|---|---|---|
| 0:00 to 0:08 | The archipelago live, the Factory island to the south with its chimneys smoking, the two seed robots at the dock; title card over it | "MYTOPIA: the place a company manages its AI agents' identities. Mint them, rank them, give and take their tools, stop them, inspect them, retire them. A real MCP gateway on AWS, drawn as an island." | MYTOPIA. AWS x A10 Hack 2026. A10 Track, Prompt 1: Agentic Identity |
| 0:08 to 0:16 | Problem card | "Companies are giving AI agents real access. Today that means static keys, unreviewed mcp.json files, and logs read after the incident. And Cognito cannot revoke a machine token, so revocation has to live in the gateway, on every call." | Static keys. Unreviewed mcp.json. Logs read after the incident. Cognito: a machine token is valid until it expires. |
| 0:16 to 0:36 | The office sheet: name Billing Bot, Gold, `delete_file` padlocked "Diamond only", BUILD. The iris. The Factory floor: press, head, paint, the medal stamped, the tool tokens handed over, the robot rolls out. Back outside: the chimneys, BUILT Billing Bot, the teal robot walks to the yard | "Every agent is its own OAuth client in Amazon Cognito, and this is where one is born: one call to Cognito, one badge row in DynamoDB, the secret written only to the launcher's file. Gold is the most this badge may ever hold." | 1. Mint: Cognito CreateUserPoolClient + DynamoDB PutItem. The tier is the most a badge may hold |
| 0:36 to 0:50 | Terminal: the launcher command with `--scripted --patrol`, `token OK ... 300 s`, `launching Billing Bot (Gold badge, 4 tools)`, the ALLOW lines. Island: the robot walks under the arch and over the bridge, raises its ID card at the gatehouse window, AUTHENTICATED, then the gates answer one by one | "Billing Bot trades its secret for a five-minute token and patrols: one tool every three seconds, the badge read from DynamoDB on every call, about [M] milliseconds each." | 2. Authenticate and patrol. Gateway check p50 [M] ms |
| 0:50 to 1:12 | Click the paper `send_email` chip: GRANTED, the Mail gate lifts. Click the green `create_issue` chip: PULLED, the padlock on the GitHub gate, the guard walks the robot back. Click the padlocked `delete_file`: the chip shakes, the banner "delete_file is above the Gold ceiling". ▲: PROMOTED TO DIAMOND, the padlock opens. ▼ ▼: DEMOTED TO SILVER, the badge trimmed | "Give a tool, take a tool, change the rank: each is one write to the badge and one row in the ledger, and the next call reads the new badge. The padlock is the gateway's rule: a Gold badge cannot be given delete, even by the operator. Promote, and it opens; demote, and the badge is trimmed on the spot." | 3. Grant, pull, promote, demote. 403 above the ceiling: nothing written |
| 1:12 to 1:32 | Terminal C: `--scripted --rogue 3`, three `DENY send_email` lines, then `badge REVOKED ... by quarantine`. Island: Research Bot refused three times at the Mail gate, QUARANTINED, the chief escorts it over the bridge into the bay; the inquest panel types itself out | "Three refused calls inside a minute and the gateway pulls the badge itself. The inspection report is computed from the hash chain: calls, refusals, who pulled the badge and when, the verdict. No model wrote a word of it." | 4. Quarantine: [Q]. The inquest is computed from the chain |
| 1:32 to 1:46 | KILL on Billing Bot: KILL REQUESTED, the robot powers down, the cart carries it to the bay, its inquest; terminal `KILLED -> psutil in [P] ms`, `stopped, exit N (killed by harness)`; the ticker "run stopped [K] ms after KILL". Then F, RETIRE: the robot rolls into the Factory and its tab disappears | "Kill: the gateway refuses everything from the next call, and the launcher ends the process tree [K] milliseconds after the click. Retire: the Cognito client and the badge row are deleted. The ledger keeps every row." | 5. Kill: run stopped [K] ms after the click. Retire: DeleteUserPoolClient + DeleteItem |
| 1:46 to 1:56 | Click the gatehouse: the ledger room, a slow rotation, the receipts on their cords; TAMPER TEST: one receipt "✗ changed", every link after it brick, then healed | "Every receipt carries the fingerprint of the one before it. Change one and every link after it breaks. Checked in the browser, on a copy: tamper-evident, not tamper-proof." | 6. The ledger: a SHA-256 hash chain, verified in the browser |
| 1:56 to 2:00 | Closing card | "For platform security teams running agents on MCP tools. An estimated 99 dollars a month for 25 agents. One limit: here the agent and the gateway share one laptop user." | Buyer: platform security teams. Price (estimate): $99/month for 25 agents. Limit: same OS user in this prototype |

## Subtitles

Paste into a file `mytopia.srt` next to the video, or into YouTube's subtitle editor. Adjust the times to the final cut and replace the placeholders with the numbers in your recording.

```text
1
00:00:00,000 --> 00:00:08,000
MYTOPIA: the place a company manages its AI agents' identities.
Mint them, rank them, give and take their tools, stop them, inspect them, retire them.
A real MCP gateway on AWS, drawn as an island.

2
00:00:08,000 --> 00:00:16,000
Companies are giving AI agents real access. Today that means static keys,
unreviewed mcp.json files, and logs read after the incident.
And Cognito cannot revoke a machine token, so revocation lives in the gateway, on every call.

3
00:00:16,000 --> 00:00:36,000
Every agent is its own OAuth client in Amazon Cognito, and this is where one is born:
one call to Cognito, one badge row in DynamoDB, the secret written only to the launcher's file.
Gold is the most this badge may ever hold.

4
00:00:36,000 --> 00:00:50,000
Billing Bot trades its secret for a five-minute token and patrols: one tool every three seconds,
the badge read from DynamoDB on every call, about [M] milliseconds each.

5
00:00:50,000 --> 00:01:12,000
Give a tool, take a tool, change the rank: each is one write to the badge and one row in the ledger,
and the next call reads the new badge. The padlock is the gateway's rule:
a Gold badge cannot be given delete, even by the operator. Promote, and it opens; demote, and the badge is trimmed.

6
00:01:12,000 --> 00:01:32,000
Three refused calls inside a minute and the gateway pulls the badge itself.
The inspection report is computed from the hash chain: calls, refusals, who pulled the badge and when, the verdict.
No model wrote a word of it.

7
00:01:32,000 --> 00:01:46,000
Kill: the gateway refuses everything from the next call, and the launcher ends the process tree [K] milliseconds after the click.
Retire: the Cognito client and the badge row are deleted. The ledger keeps every row.

8
00:01:46,000 --> 00:01:56,000
Every receipt carries the fingerprint of the one before it. Change one and every link after it breaks.
Checked in the browser, on a copy: tamper-evident, not tamper-proof.

9
00:01:56,000 --> 00:02:00,000
For platform security teams running agents on MCP tools. An estimated $99 a month for 25 agents.
One limit: here the agent and the gateway share one laptop user.
```

## Sources for what the video says

- One Cognito app client per agent, 5-minute tokens, the secret only in the launcher's env file, `attribute_not_exists` on the badge row, the 403 above the ceiling, the trimmed badge on demotion, RETIRE's two deletes: `gateway/factory.py`, `gateway/identity.py`, `contract/README.md`.
- The patrol (the list re-read at the start of each cycle, one listed tool every 3 s, never an unlisted tool): `agent/main.py`, `launcher/run.py --patrol`.
- The quarantine rule (3 refused calls in 60 s; refusals of pulled or trimmed tools not counted): `gateway/mcp.py`, `gateway/.env.example`. On AWS it fired 15.7 s after launch, "3 refused calls in 6 s": `docs/LIVE_RUN.md`, run 3.
- The inquest's fields and sentences: `docs/BUILD3.md` section 2.4, `gateway/factory.py`, `island/src/reducer.js` (`inquestOf`).
- About 85 ms per decision, 358 ms KILL to `run_stopped`, psutil 63 ms: `docs/LIVE_RUN.md`, run 4. The Factory flow's numbers: `docs/LIVE_RUN.md`, run 7 (the first on AWS: mint 1.2 s, p50 79 ms, "3 refused calls in 6 s", KILL to `run_stopped` 113 ms, psutil 116 ms); the video's own run is written up there with its own number.
- Cognito cannot revoke a machine access token: `docs/AWS_CREDENTIAL_DESIGN.md` section 2 (AWS token-revocation documentation, marked verified).
- The $99 team tier is an estimate from the night-before plan, section 2; say "estimated" in the voice-over, as written.
- The description under the video should repeat: Claude Code wrote the engine and built the island during the event, including the Factory, the tiers and the interiors on Saturday night; the island's renderer, palette and building recipes are Ozi's earlier project Mytopia, listed in `island/ASSETS.md` (one method, `setPixel`, was added to its renderer on Saturday night). Also: "dead time between calls trimmed".
