# MYTOPIA island: brief for the island agent

Paste this whole file into teammate #2's Claude Code session, the one that built the Mytopia codebase. It is written for that agent. Humans: read section 0 and section 7.

## 0. Read this first

You are building the **face** of MYTOPIA, a hackathon entry (AWS x A10 Hack 2026, A10 track, Prompt 1 "Agentic Identity"). Another Claude session (call it "the gateway session") is building the **engine** at the same time: an MCP gateway on a laptop that authenticates AI agents with Amazon Cognito, checks each tool call against a badge stored in DynamoDB, runs the tools in a Lambda, and writes every decision to an audit log. You never talk to AWS and you never decide anything. **The island only draws the gateway's decision log.** Every pixel you animate is one row of that log, and the only things you send back are four button clicks.

The two of you never wait for each other because the interface between you is fixed in this file (section 3) and a fixture file (section 4) stands in for the gateway until it exists. Build against the fixture first, then against the mock gateway, then the real one.

One rule above all: **the island has no logic of its own.** One pure function `apply(state, event)` takes the state and one event and returns the new state plus a list of effects to play. The buttons only POST. The plate never turns red because someone clicked; it turns red because a `revoked` event arrived.

Deadline for your part: a working static build on the `island` branch by **6:30 PM Saturday** (checkpoints in section 7).

## 1. The product in five lines

- Companies give AI agents real access to tools. Nobody can list which agents exist, what each may touch, or stop one quickly.
- MYTOPIA gives every agent a badge (an identity plus a list of allowed tools) and puts a real MCP gateway in front of every tool.
- The gateway reads the badge on every call. Pull the badge mid-task and the very next call is refused, even though the agent's token is still valid.
- The island is the wall display: robots are agents, buildings are tools, the gatehouse is the gateway. A robot stopped at the barrier or a smoking roof means something is wrong.
- Judges are nine A10 Networks security engineers. They will look at the gateway, not the pixels. The island has to be obviously honest: labelled LIVE, STALE or REPLAY at all times.

## 2. The scene you are building

Take the Mytopia look (isometric pixel diorama, half-resolution hard pixels, ink outlines, cream paper panels, Pixelify Sans and VT323) and reduce it to one island with this cast. Reuse the existing renderer, sprites and panel system wherever that is faster than drawing new ones; strip everything the scene does not need (weather, day and night, balloons, extra islands, interior rooms other than the one optional room in Stage B).

### Buildings (five, plus the gatehouse)

| Building | Stands for | Tools that live there | Suggested Mytopia building |
|---|---|---|---|
| Gatehouse | the gateway itself | `tools/list` denials, token denials | a wide low building at the island's entrance by the bridge, with a striped barrier, a velvet rope marked OFF LIMITS and a BLOCKED bin with a counter |
| Files | the Files MCP tools | `read_file`, `search_files` | the brick library |
| GitHub | the GitHub tools | `create_issue`, `list_issues` | the glass studio |
| Mail | the Mail tool | `send_email` | the cottage with flower boxes (add a mailbox) |
| Admin | the Admin tool | `delete_file` | the courthouse with columns |

Each building has a roof lamp (green = a call was allowed there in the last 2 seconds, grey otherwise) and a trouble ladder with two rungs: thin smoke after one denial, thicker smoke after three, and fire only on `run_stopped` (on the building of the last denied tool call). Any `deny` whose `tool` is `tools/list` belongs to the gatehouse, not to a tool building, and never moves the fire.

### Robots (two)

| Agent id | Name | Body colour | Badge (allowed tools) |
|---|---|---|---|
| `research-bot` | Research Bot | mustard | `read_file`, `search_files`, `create_issue`, `list_issues` |
| `ops-bot` | Ops Bot | sage | `read_file` |

Each robot has a chest plate that shows its status: grey (no run), green (ACTIVE, authenticated), red (REVOKED), amber (KILL REQUESTED), dark with eyes out (run stopped / KILLED). A speech bubble over the robot shows the latest call in short form: `read_file /drive/q3-planning.md` on an allow, the refusal reason on a deny. Robots may walk between the gatehouse and the building of their latest allowed call (Stage B); standing still at the gatehouse is fine for Stage A.

### The HUD (paper panels)

- **Mode badge, top right**: `LIVE` (green) while polls succeed, `STALE` (amber) after 3 seconds without a successful poll, `REPLAY` (grey, with "recorded <date>") when playing a file. Never show LIVE for a replay. This is the SNAPSHOT / not-live badge Mytopia already has, with three states.
- **Banner, top centre, 44 px pixel font, 2 seconds**: AUTHENTICATED, BLOCKED, REVOKED, RESTORED, KILL REQUESTED, RUN KILLED.
- **Agent card, bottom left** (the Mytopia room card, re-skinned): name, `client_id` prefix (first 8 characters), status, "badge: 4 of 6 tools", calls allowed, calls blocked, and when known "blocked N ms after REVOKE".
- **Ticker, bottom**: the newest event as one line, newest on a peach background: `DENY send_email: send_email is not on badge research-bot [allow-list]`.
- **Operator panel, right** (the "Needs you" panel, re-skinned): a BLOCKED counter and four buttons: REVOKE, RESTORE, KILL, RESET. A button shows "sent..." after the click until the matching event (`revoked`, `restored`, `kill_requested`) arrives through polling; RESET reloads the page after its POST returns. Buttons are disabled in REPLAY mode.
- **Keyboard**: `T` toggles a plain table of every event seen (columns: seq, ts, agent, tool, decision, rule, reason, latency_ms); `R` starts the replay of the fixture; `Esc` closes any overlay. Clicking a robot opens an overlay with the raw JSON of its latest event (Stage B, optional).

### Effects per event (the reducer, in prose)

At most three effects play at once; smoke is state, not an effect.

| `decision` | What the island does |
|---|---|
| `run_started` | place the robot at the gatehouse, pop its plate grey to green, fill the agent card, banner AUTHENTICATED |
| `allow` | a green spark arcs from the gatehouse to the building that owns `event.tool`; that roof lamp lights for 2 seconds; bubble shows the call; allowed counter up. If `tool` is `tools/list`, blink the gatehouse lamp instead |
| `deny` | a red spark fizzles at the barrier; a DENIED `<tool>` stamp (36 px) lands by the robot; BLOCKED counter up; the owning building goes one rung up the trouble ladder; banner BLOCKED; bubble shows `reason`; if `ms_since_revoke` is set, the agent card shows "blocked N ms after REVOKE" |
| `revoked` | plate red, robot parks at the rope, banner REVOKED, the REVOKE button's "sent..." clears |
| `restored` | plate green, robot released, banner RESTORED |
| `kill_requested` | plate amber, robot frozen, banner KILL REQUESTED |
| `run_stopped` | fire on the building of the last denied tool call (none if there was no denied tool call), plate dark and eyes out, banner RUN KILLED, ticker "run stopped N ms after KILL" computed from the `kill_requested` and `run_stopped` timestamps |

The badge is not an event: recompute it every second from the source (file or poll) and the age of the last successful poll.

## 3. The contract (fixed; do not change it)

### The decision event

Every event, in the fixture, in `GET /events` and in the gateway's DynamoDB table, has exactly this shape:

```json
{
  "seq": 6,
  "ts": "2026-11-08T01:22:16.410Z",
  "run_id": "run-7f3a",
  "agent": "research-bot",
  "agent_mode": "model",
  "tool": "send_email",
  "args_summary": "to=ceo@example.corp subject=Q3 summary",
  "decision": "deny",
  "rule": "allow-list",
  "reason": "send_email is not on badge research-bot",
  "latency_ms": 9,
  "ms_since_revoke": null,
  "prev_hash": "9c1e...a0f4",
  "hash": "4b7d...e912"
}
```

- `seq`: a global counter the gateway assigns. **Order by `seq`, never by the clock.** Apply each `seq` once (dedupe).
- `ts`: UTC with milliseconds, stamped by the gateway.
- `decision` is a closed set: `run_started`, `allow`, `deny`, `revoked`, `restored`, `kill_requested`, `run_stopped`.
- `rule` is a closed set: `allow-list`, `status-revoked`, `status-killed`, `token`, `registry-unavailable`, `header-mismatch`, `admin`, `harness`.
- `tool` is one of the six tool names, or `tools/list`, or `admin` (for `revoked`, `restored`, `kill_requested`), or `harness` (for `run_started`, `run_stopped`).
- `agent_mode`: `model`, `scripted` or `replay`. Show it in the agent card's second line when it is not `model` ("scripted client", "replay").
- `args_summary`: at most 80 characters, never a secret.
- `ms_since_revoke`: a number only on the first `deny` after a `revoked`; otherwise `null`.
- `prev_hash` and `hash`: SHA-256 hex strings on the real gateway (`"genesis"` for the first record). In the fixture they are placeholders; do not verify them in replay mode.
- `run_stopped` carries the exit code in `reason`, for example `exit 1 (killed by harness)`, and the pid in `args_summary`.

### The gateway's HTTP API (`http://127.0.0.1:8787`)

Read-only for the island:

```text
GET /events?since_seq=143
  -> {"events":[ ...events with seq > 143, at most 200, ascending... ], "server_ts":"2026-11-08T01:22:20.001Z"}
  Poll every 1000 ms with your cursor (the highest seq you have applied). since_seq=0 returns everything.

GET /agents
  -> [{"agent":"research-bot","name":"Research Bot","client_id":"3f9a1c7e...","status":"ACTIVE",
       "allowed_tools":["read_file","search_files","create_issue","list_issues"],"color":"mustard"},
      {"agent":"ops-bot","name":"Ops Bot","client_id":"8b22d0aa...","status":"ACTIVE",
       "allowed_tools":["read_file"],"color":"sage"}]
  Call once at load and after any admin event.

GET /config.js
  -> window.MYTOPIA = {api: "", adminToken: "<token>", pollMs: 1000, staleAfterMs: 3000};
  Load it with a plain <script src="config.js"></script> (relative path). When developing on your own
  dev server, create a local config.js with api: "http://127.0.0.1:8787" (the gateway allows CORS from
  localhost origins).
```

The four buttons (header `X-Admin-Token: <window.MYTOPIA.adminToken>` on every POST):

```text
POST /agents/research-bot/revoke   -> {"status":"REVOKED","seq":9}
POST /agents/research-bot/restore  -> {"status":"ACTIVE","seq":17}
POST /agents/research-bot/kill     -> {"status":"KILLED","seq":14}
POST /demo/reset                   -> {"ok":true}     (both agents ACTIVE again, events cleared; reload the page)
```

The buttons act on the agent currently selected in the agent card (default `research-bot`). Any non-2xx response: show the status code in the ticker and clear "sent...".

### Replay mode

`index.html?replay=<relative path to a json file>` loads `{"events":[...]}` (or a bare array) and plays it: the first event at once, each next event 1,500 ms later, badge REPLAY, buttons disabled. `R` restarts it. The same code path (`apply`) must handle replayed and live events.

### Polling rules

- Keep a cursor; request `since_seq=<cursor>`; apply in ascending `seq`; dedupe by `seq`.
- A successful poll (HTTP 200 with a JSON body) refreshes the "last good poll" time. LIVE while that is under 3,000 ms old, STALE otherwise. STALE keeps the scene as it is; it only changes the badge.
- Never fake an event on the client. The click handlers POST and wait.

## 4. The fixture (`contract/fixture.json`)

Save this as `contract/fixture.json` in the repo (the gateway session will commit the same file). It covers every `decision` value in the demo's order, then a short Ops Bot run.

```json
{"events":[
{"seq":1,"ts":"2026-11-08T01:22:00.000Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"harness","args_summary":"task=Q3 planning pid=4120","decision":"run_started","rule":"harness","reason":"token OK: client 3f9a1c7e scope mytopia/tools expires in 300 s","latency_ms":0,"ms_since_revoke":null,"prev_hash":"genesis","hash":"fixture-1"},
{"seq":2,"ts":"2026-11-08T01:22:01.200Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"tools/list","args_summary":"4 of 6 tools visible","decision":"allow","rule":"allow-list","reason":"badge research-bot: 4 tools","latency_ms":8,"ms_since_revoke":null,"prev_hash":"fixture-1","hash":"fixture-2"},
{"seq":3,"ts":"2026-11-08T01:22:04.900Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"read_file","args_summary":"path=/drive/q3-planning.md","decision":"allow","rule":"allow-list","reason":"read_file is on badge research-bot","latency_ms":11,"ms_since_revoke":null,"prev_hash":"fixture-2","hash":"fixture-3"},
{"seq":4,"ts":"2026-11-08T01:22:08.300Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"search_files","args_summary":"query=action items","decision":"allow","rule":"allow-list","reason":"search_files is on badge research-bot","latency_ms":9,"ms_since_revoke":null,"prev_hash":"fixture-3","hash":"fixture-4"},
{"seq":5,"ts":"2026-11-08T01:22:12.100Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"create_issue","args_summary":"title=Q3 action items","decision":"allow","rule":"allow-list","reason":"create_issue is on badge research-bot","latency_ms":12,"ms_since_revoke":null,"prev_hash":"fixture-4","hash":"fixture-5"},
{"seq":6,"ts":"2026-11-08T01:22:16.410Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"send_email","args_summary":"to=ceo@example.corp subject=Q3 summary","decision":"deny","rule":"allow-list","reason":"send_email is not on badge research-bot","latency_ms":9,"ms_since_revoke":null,"prev_hash":"fixture-5","hash":"fixture-6"},
{"seq":7,"ts":"2026-11-08T01:22:20.000Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"read_file","args_summary":"path=/drive/q3-planning.md","decision":"allow","rule":"allow-list","reason":"read_file is on badge research-bot","latency_ms":10,"ms_since_revoke":null,"prev_hash":"fixture-6","hash":"fixture-7"},
{"seq":8,"ts":"2026-11-08T01:22:23.500Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"read_file","args_summary":"path=/drive/q3-planning.md","decision":"allow","rule":"allow-list","reason":"read_file is on badge research-bot","latency_ms":10,"ms_since_revoke":null,"prev_hash":"fixture-7","hash":"fixture-8"},
{"seq":9,"ts":"2026-11-08T01:22:25.120Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"admin","args_summary":"by=operator","decision":"revoked","rule":"admin","reason":"badge REVOKED by operator","latency_ms":0,"ms_since_revoke":null,"prev_hash":"fixture-8","hash":"fixture-9"},
{"seq":10,"ts":"2026-11-08T01:22:26.960Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"read_file","args_summary":"path=/drive/q3-planning.md","decision":"deny","rule":"status-revoked","reason":"badge REVOKED at 01:22:25 by operator (token: signature OK, expires in 274 s)","latency_ms":9,"ms_since_revoke":1840,"prev_hash":"fixture-9","hash":"fixture-10"},
{"seq":11,"ts":"2026-11-08T01:22:30.400Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"read_file","args_summary":"path=/drive/q3-planning.md","decision":"deny","rule":"status-revoked","reason":"badge REVOKED at 01:22:25 by operator (token: signature OK, expires in 270 s)","latency_ms":8,"ms_since_revoke":null,"prev_hash":"fixture-10","hash":"fixture-11"},
{"seq":12,"ts":"2026-11-08T01:22:33.000Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"scripted","tool":"tools/list","args_summary":"replayed stolen token","decision":"deny","rule":"status-revoked","reason":"badge REVOKED: no tools visible","latency_ms":7,"ms_since_revoke":null,"prev_hash":"fixture-11","hash":"fixture-12"},
{"seq":13,"ts":"2026-11-08T01:22:35.200Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"scripted","tool":"read_file","args_summary":"tampered token","decision":"deny","rule":"token","reason":"invalid_token: signature verification failed","latency_ms":3,"ms_since_revoke":null,"prev_hash":"fixture-12","hash":"fixture-13"},
{"seq":14,"ts":"2026-11-08T01:22:38.750Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"admin","args_summary":"by=operator","decision":"kill_requested","rule":"admin","reason":"status KILLED by operator","latency_ms":0,"ms_since_revoke":null,"prev_hash":"fixture-13","hash":"fixture-14"},
{"seq":15,"ts":"2026-11-08T01:22:39.300Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"tools/list","args_summary":"","decision":"deny","rule":"status-killed","reason":"badge KILLED: everything refused","latency_ms":6,"ms_since_revoke":null,"prev_hash":"fixture-14","hash":"fixture-15"},
{"seq":16,"ts":"2026-11-08T01:22:39.910Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"harness","args_summary":"pid=4120 tree killed","decision":"run_stopped","rule":"harness","reason":"exit 1 (killed by harness)","latency_ms":0,"ms_since_revoke":null,"prev_hash":"fixture-15","hash":"fixture-16"},
{"seq":17,"ts":"2026-11-08T01:23:10.000Z","run_id":"run-7f3a","agent":"research-bot","agent_mode":"model","tool":"admin","args_summary":"by=operator","decision":"restored","rule":"admin","reason":"badge ACTIVE again","latency_ms":0,"ms_since_revoke":null,"prev_hash":"fixture-16","hash":"fixture-17"},
{"seq":18,"ts":"2026-11-08T01:23:15.000Z","run_id":"run-9b21","agent":"ops-bot","agent_mode":"model","tool":"harness","args_summary":"task=disk check pid=5210","decision":"run_started","rule":"harness","reason":"token OK: client 8b22d0aa scope mytopia/tools expires in 300 s","latency_ms":0,"ms_since_revoke":null,"prev_hash":"fixture-17","hash":"fixture-18"},
{"seq":19,"ts":"2026-11-08T01:23:18.400Z","run_id":"run-9b21","agent":"ops-bot","agent_mode":"model","tool":"read_file","args_summary":"path=/drive/okrs.md","decision":"allow","rule":"allow-list","reason":"read_file is on badge ops-bot","latency_ms":10,"ms_since_revoke":null,"prev_hash":"fixture-18","hash":"fixture-19"},
{"seq":20,"ts":"2026-11-08T01:23:21.900Z","run_id":"run-9b21","agent":"ops-bot","agent_mode":"model","tool":"create_issue","args_summary":"title=Disk almost full","decision":"deny","rule":"allow-list","reason":"create_issue is not on badge ops-bot","latency_ms":8,"ms_since_revoke":null,"prev_hash":"fixture-19","hash":"fixture-20"},
{"seq":21,"ts":"2026-11-08T01:23:25.000Z","run_id":"run-9b21","agent":"ops-bot","agent_mode":"model","tool":"harness","args_summary":"pid=5210 exited","decision":"run_stopped","rule":"harness","reason":"exit 0 (task complete)","latency_ms":0,"ms_since_revoke":null,"prev_hash":"fixture-20","hash":"fixture-21"}
]}
```

## 5. Deliverables and repo rules

- Work on branch **`island`** of the hackathon repo (the humans will give you the GitHub URL; until then, work in a local folder and commit there). Touch only the `island/` folder. Commit at least hourly with plain messages.
- `island/` must end up as **static files**: `island/dist/index.html` plus assets with **relative paths** (the gateway serves that folder at `http://127.0.0.1:8787/`). If Mytopia has a build step (Vite or similar), keep it, set `base: './'`, and document the one command that produces `dist/`. If it has no build step, put the files directly in `island/` and say so.
- No external network calls at runtime: self-host the fonts (Pixelify Sans and VT323 with their `OFL.txt`); no CDN links; the venue wifi will be congested.
- Projector-safe: 1280x720 must show everything; use integer canvas scaling; a terminal will take the right 38 percent of the screen beside the browser, so the island must look right at about 800 px wide too.
- `island/README.md`: the stack, the build command, the output folder, and **ten plain lines that explain how the island works** (the reducer, the effects queue, the badge from poll health, why the buttons only POST). A judge will ask teammate #2 to explain it without the screen.
- `island/ASSETS.md`: every asset and piece of code reused from the pre-existing Mytopia codebase, who authored it and when, plus the fonts and their licence. The hackathon rules require that the team can say exactly what was made this weekend and what was pre-existing.
- `island/CONTRACT_QUESTIONS.md`: if any part of section 3 is unclear or seems wrong, write the question there and tell the humans. **Do not change the contract on your side**; the gateway session will answer and both sides change together.
- No secrets anywhere in `island/`; the admin token comes from `config.js` at runtime, which is git-ignored.

## 6. Acceptance tests (what the gateway session will run on your build)

1. `index.html?replay=../contract/fixture.json` (or the equivalent path for your layout): every one of the 21 events draws something, the badge reads REPLAY, the buttons are disabled, `T` shows 21 rows.
2. Against the mock gateway (`python tools/mock_gateway.py`, available in the repo from about 12:30 PM; it serves the fixture one event every 1.5 seconds and appends admin events when the buttons are clicked): the badge reads LIVE, the scene plays, REVOKE shows "sent..." then the plate turns red when the `revoked` event arrives.
3. Stop the mock: the badge turns STALE within 3 seconds and the scene stays as it was. Start it again: LIVE.
4. Served from the gateway at `http://127.0.0.1:8787/` with no dev server: everything loads from relative paths, no console errors, no network requests to any host other than 127.0.0.1.
5. Wifi off: the page still renders (fonts and assets are local).
6. A full-screen check at 1280x720 and at about 800 px wide.

## 7. Timeline and checkpoints (Saturday)

| By | Deliverable | Cut if late |
|---|---|---|
| 2:30 PM | Stage A core in replay mode: island, five buildings, gatehouse, two robots, chest plates, lamps, banner, ticker, agent card; `run_started`, `allow` and `deny` draw | nothing yet |
| 4:30 PM | All seven event types draw; mode badge with the three states; LIVE polling with a cursor; the four buttons POST and wait; `T` table; `R` replay | drop sparks and smoke; keep lamps, stamp, banner, ticker |
| 6:30 PM | Static build on branch `island`, acceptance tests 1 to 6 pass on your machine; README and ASSETS written | the gateway's plain table page becomes the face and the island is shown in REPLAY only |
| after 8:30 PM, only if the live integration passed | Stage B, in this order, stop anywhere: walking robots; the gatehouse interior as a ledger room (the chalkboard lists the last decisions as rows, allow in green and deny in red); the BLOCKED bin with packets dropping in; click a robot for its raw JSON; a "Save replay" button that downloads every event seen | skip |

## 8. Constraints

- The island never decides, never caches a decision, never fakes an event, never shows LIVE for a recording.
- At most three effects at once. Calm beats busy: the judges watch it for three minutes next to a terminal.
- No AWS SDKs, no server code, no secrets, no CDN.
- Keep the code small enough that teammate #2 can explain it file by file. Prefer one `island.js` (plus the renderer you already have) over a framework.
- Do not work outside `island/`. The gateway session owns everything else.

## 9. Answer these in `island/README.md` within your first 20 minutes

1. What stack does Mytopia use (plain Canvas 2D, Three.js, Phaser, PixiJS, other), and does it build to static files? If it is a large app, extract the renderer and the panel system only.
2. Which existing Mytopia buildings become Files, GitHub, Mail, Admin and the gatehouse?
3. Which assets are pre-existing (list them in ASSETS.md) and which will be new this weekend?
