# Island v2, round two: the additions (spec, Sat 2026-11-07, 4 PM)

Built after the archipelago lands and passes its screenshots. Each item is something a judge asked for in last night's assessments. Same style rules as `docs/ISLAND_V2.md`: Mytopia's palette, crisp DOM for every word, no neon, nothing moves because of a click.

## 1. Per-tool revoke from the agent card

The gateway now has `POST /agents/{id}/tools/{tool}/revoke` and `.../restore` (admin token, idempotent) and logs them as `revoked` / `restored` events whose `tool` is the tool name (a whole-badge revoke keeps `tool: "admin"`). The first allow-list deny of that agent for that tool afterwards carries `ms_since_revoke`.

- The six tool chips on the agent card become buttons when the page is live (not in replay). Clicking an allowed chip POSTs the per-tool revoke; clicking a struck chip POSTs the restore. The chip shows "sent..." until the matching event arrives (the same rule as the four big buttons: nothing changes on the click).
- Reducer: a `revoked` event with a tool name removes that tool from `agent.allowedTools` and pushes `{ kind: 'ack', action: 'tool:' + tool }`; a `restored` with a tool name adds it back. The plate does not change. The card's "badge: 3 of 6 tools" updates. No pen, no chief.
- The gate of that tool's islet gets a small **padlock plate** on the booth (a 3D box with a canvas padlock glyph) while any agent has the tool pulled; it is removed on restore. The reducer exposes `state.gates[key].locked = true/false` for the selected agent and the HUD shows the chip struck in red with "pulled".
- When the agent next calls that tool: the normal allow-list refusal ritual at that gate (red lamp, DENIED stamp over the gate, escort back). The card's note reads "blocked N ms after the tool was pulled" (from `ms_since_revoke` on an allow-list deny).
- Ticker lines: `REVOKED send_email: send_email pulled from badge research-bot by operator [admin]`.

## 2. Quarantine

A `revoked` event whose reason starts with "badge pulled by quarantine" (and `args_summary` "quarantine: 3 refused calls in 41 s") is drawn like a revoke (chief escort to the pen, plate red) with the banner **QUARANTINED** instead of REVOKED, and the card's status pill reads QUARANTINED. The REVOKE button's "sent..." must not wait for it (no ack for a quarantine; the ack only fires when `revoked_by` is the operator, which the island cannot see directly: use the reason text, operator revokes say "by operator").

## 3. The ID card with real claims

When a robot raises its ID card at a gate or the gatehouse window, a DOM **ID card** (paper, 220 px wide, 1.2 s, anchored above that gate's stamp anchor, replacing any stamp for its duration) shows three lines: `client s2ch2ppk` (the agent's `clientId`), `scope mytopia/tools`, and the token line from the last event that mentioned it: `token OK · expires in 300 s` after `run_started`, or `signature OK · expires in 243 s` parsed from a status-revoked reason. Never invent a number: if no event carried one, the third line is `token: checked by the gateway`.

## 4. The three-state mode badge

`LIVE · model`, `LIVE · scripted` and `REPLAY` (STALE stays STALE): the second word comes from the selected agent's `agent_mode` (`model` / `scripted`), so a judge always sees whether a model or a fixed script is driving the calls. Colours as today (green, amber, grey).

## 5. Ledger rows open their raw JSON

In the ledger room, clicking a row (or pressing Enter on it) opens the same JSON sheet the robot click uses, titled `#seq · decision tool · the row as the gateway stored it`, with one extra line under the JSON: `the same row sits in DynamoDB mytopia_events, pk <chain>, seq <n>` (the chain id comes from `GET /events`' `chain` field; in replay it says `recorded chain <chain>`).

## 6. The architecture sheet (key A, and an "A architecture" hint in the operator panel)

A DOM sheet like the T table: the trust boundaries drawn once as inline SVG in the island's own style (paper, ink lines, no colour but the four state colours), 960 px wide max, readable at arm's length:

- Three boxes on the laptop: **launcher** (holds the client secret; mints the 5-minute Cognito token; owns the agent process; polls the badge every 250 ms; kills the tree), **agent** (Strands on Nova 2 Lite; holds only the token and a Bedrock-only bearer token; its one MCP server is the gateway), **gateway** (the enforcement point: five token checks, one strongly consistent badge read, `decide()`, the hash chain; serves this island).
- Four boxes on AWS: **Cognito** (one machine client per agent; cannot revoke a machine token, and we say so), **DynamoDB** `mytopia_agents` (the badge: status and allowed tools; read on every call) and `mytopia_events` (the chain's durable copy, PutItem only), **Lambda** `mytopia-tools` (the six tools; invokable only by the gateway's role), **Bedrock** (the model; no server-side tools).
- Arrows labelled with what crosses them (token, tools/call, GetItem consistent, PutItem, invoke, converse) and a dashed line for the trust boundary between the laptop and AWS and between the agent and the gateway.
- Under the drawing, the mapping table: which picture proves which A10 step (ID card at the window = authenticate; gates that open = allow selected MCP tools; the chief's escort = revoke mid-task; stamps over the pen = block subsequent requests; power-down = stop the run, borrowed from Prompt 2) and the honest limits in one line (in-flight call completes; same OS user; admin token is a demo shortcut; client secret in a file stands in for an attested workload identity).

## 7. Acceptance for this round

1. Live: click the `send_email` chip (already struck) does nothing; click `create_issue`: "sent...", then the event arrives, the chip is struck red "pulled", the badge count reads 3 of 6, the GitHub booth shows the padlock; the scripted agent's next `create_issue` is refused at the GitHub gate with the escort; the card note shows the ms. Click it again: restored.
2. `--scripted --rogue 3`: three refusals at the Mail gate, then the chief escorts the robot to the pen with the banner QUARANTINED, and the next poll is refused over the pen.
3. The ID card shows the real client prefix and a real expiry once one is known.
4. Mode badge reads `LIVE · scripted` for a scripted run and `LIVE · model` for a model run; `REPLAY` on the recording.
5. A opens the sheet; the SVG reads from a metre; Esc closes it.
6. All island tests pass; the 21-event fixture and `replay/demo.json` still play; no console errors.
