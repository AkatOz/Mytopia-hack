# Answers to island/CONTRACT_QUESTIONS.md (from the gateway session, Sat 2026-11-07, 12:50 PM PT)

Thank you: the island branch is merged into `main` as is. Nothing below asks you to change code unless marked **change**.

1. **`run_stopped` after a normal exit.** Confirmed, your rule stands: fire and RUN KILLED only when a `kill_requested` for that agent precedes the `run_stopped`; otherwise RUN ENDED, no fire, and the card shows the exit reason. The gateway also marks it in the record so a reader of the raw log can tell without context: `reason` is always `exit <code> (killed by harness)` when the launcher killed the process after a kill request, and `exit <code> (exited)` when the agent stopped on its own. `args_summary` is `pid=<pid> killed by harness` or `pid=<pid> exited`. You may use either signal; the contract now says so. (Note added Sat 5 PM: the rebuilt island draws no fire at all. A killed run powers the robot down, with the ticker "run stopped N ms after KILL"; a run that exited on its own walks back to the dock under the banner RUN ENDED. The gateway side of this answer is unchanged.)
2. **`contract/fixture.json` outside `island/`.** The two files are semantically identical (parsed and compared); ours is pretty-printed with one key per line, yours is one event per line. The merge keeps ours at `contract/fixture.json` and your `island/fixture.json` untouched, so **R** keeps working when only `island/` is served.
3. **Cursor after a gateway restart.** Reload is fine, and you will rarely need it: the gateway never restarts `seq` below the last value it served. On start it resumes the current chain's counter (from its JSONL twin in local mode, from DynamoDB in AWS mode); only `POST /demo/reset` starts a new chain, and the island reloads on RESET anyway. `server_ts` carries no restart signal.
4. **`config.js` 404 in dev.** Fine. The gateway serves `/config.js` itself; the 404 only happens on a plain static server.
5. **Which agent the buttons act on.** Confirmed: `POST /agents/ops-bot/revoke|restore|kill` work exactly like `research-bot`'s. `GET /agents` lists both with their live status after every admin event.

Two small things noticed while reading (no action needed before the integration run):

- `island/README.md` describes `src/feed.js`, but the branch has no such file; polling and replay seem to live in `src/main.js`. Worth a one-line fix so the ten-line explanation matches the files a judge will open.
- `island/config.example.js` points `api` at `http://127.0.0.1:8787` for a separate dev server. The real gateway allows CORS from `http://localhost:*` and `http://127.0.0.1:*`, so that works; when the gateway serves `island/` at `/`, its own `/config.js` wins, as you wrote.

Next from this side: the mock gateway (`tools/mock_gateway.py`) and the real gateway are being built right now; acceptance tests 1 to 6 will be run against both, and the result goes into `docs/ISLAND_ACCEPTANCE.md`. Stage B (walking robots are already in, the ledger room, the bin packets, Save replay) stays optional and should wait until the live integration passes, as the brief says.

# Requests from the gateway session (Sat 2:20 PM PT), after the Phase 5 reviews

Three small things the README and assets reviewers noticed in `island/`; none blocks the demo.

1. **Provenance of `island/three-d-stage.js`.** Its header says "@ds-adherence-ignore -- omelette starter scaffold" and "Copied omelette starter ... copy_starter_component", and it still documents an OBJ/GLB export toolbar and unpkg import maps the island does not use. `island/ASSETS.md` credits the file to Mytopia (Ozi with Claude Code, 2026-10-07 to 10-15). Please confirm where that starter came from and under which licence, and put one honest line about it in `island/ASSETS.md` (for example "based on the X starter component, licence Y, extended in Mytopia"). The judges' rules require the team to say exactly what is pre-existing and whose it is.
2. **`island/index.html` after the Stage B merge:** the `@media (max-width: 900px)` block repeats the Stage B rules (`#roomtitle`, `#iris`, `.save`) and the original `#ops .lbl, #ops .for, #ops .hint` font-size rule looks mangled. It renders fine at 800 px in our check, so this is tidiness, not a bug.
3. **`island/ASSETS.md` says 10 reducer tests; `node --test island/tests/*.test.mjs` reports 12.** One-word fix.

Also for the record: the gateway now serves the `replay/` folder, so the real recording plays at `http://127.0.0.1:8787/?replay=/replay/demo.json` with the gateway's own `config.js`; no copy of `demo.json` into `island/` is needed. The R key keeps playing `island/fixture.json`, which is fine.

# Change of ownership (Sat 3:45 PM PT): the gateway session now owns `island/`

The team asked for a bigger, gated archipelago, a readable ledger board and no colliding popups, and for the gateway session (Claude, Fable) to take the visual side as well. From 3:30 PM the gateway session edits every file under `island/`; please make no further changes on branch `island` to those files, or they will conflict with the rebuild (`docs/ISLAND_V2.md` is the spec; `island/src/kit.js` and `island/src/layout.js` are the shared pieces already written).

Still wanted from the island side, in words only (no code): the provenance and licence of the "omelette starter" that `three-d-stage.js` began as (request 1 above), and, after 6 PM, a read-through of the rebuilt `island/README.md` and `island/ASSETS.md` so the pre-existing-versus-new lines are exactly right. The renderer (`three-d-stage.js`), the palette and the building and robot recipes remain Mytopia's and are credited as such.

# Round two is in (Sat 5 PM PT): a closing note for the island side

The archipelago (`docs/ISLAND_V2.md`) and round two (`docs/ISLAND_V2_ADDITIONS.md`: the tool chips with padlocks, QUARANTINED, the ID card with the real client prefix and expiry, the `LIVE · model` / `LIVE · scripted` badge, ledger rows that open their JSON, the architecture sheet on key A) are merged; the island now plays the 4:18 PM model-mode recording (`replay/demo.json`). Thank you for the renderer, the palette and the building recipes: they are what makes it look like Mytopia, and every doc credits them to you.

Two things, in words only:

1. Please read `island/README.md` and `island/ASSETS.md` (both rewritten for v2 and round two) and tell us if any line about what is pre-existing, what your agent built in the morning and what Claude Code rebuilt in the afternoon is wrong. The judges' rules make this line matter.
2. The provenance line for `three-d-stage.js` is still wanted (request 1 of the 2:20 PM list): where the "omelette starter" it began as came from, and under which licence. One sentence in `island/ASSETS.md` is enough.

For the stage: your two-minute part is rewritten in `docs/QA.md` ("Ozi: the island") and the module-by-module study sheet is in `docs/EXPLAIN.md` (island section). Rehearsal 1 is at 7:00 PM.

# Build 3 is in (Sat 2026-11-07, about 8 PM PT): who owns what, and one change to `three-d-stage.js`

Build 3 (`docs/BUILD3.md`, commit a446d49, 7:29 PM) added the Factory island (mint, tiers, inspect, retire), the chips as give-and-take buttons, seven rotatable interiors with the hash-chain exhibit and TAMPER TEST, the plain-word operator panel, the agent sheet, the help sheet and hide-panels. 189 pytest and 66 island tests pass (updated later Saturday night: six tests on the AWS recording were added in 97a7d14). The Factory ran on AWS at 7:55 PM (run 7 in `docs/LIVE_RUN.md`, after Bob put the gateway role's new permissions at 7:53 PM with `infra/role_policy.py`; run 6 is the same flow in local mode). Its recording is `replay/demo3.json`.

Who owns what now, for the record:

- `gateway/`, `launcher/`, `agent/`, `infra/`, `tools/`, `contract/`, `tests/`: the gateway session (Claude), as before.
- `island/`, every file: the gateway session (Claude) since 3:30 PM Saturday, as announced above. Tonight's four streams (the gateway lifecycle; the Factory world; the interiors; reducer, HUD, main and tests) were Claude's own subagents. No file under `island/` is edited from branch `island` any more.
- Pre-existing and still Ozi's: the renderer `three-d-stage.js`, the palette and the recipes in `src/kit.js`, the terrain, scenery and building shapes, and the small robot, as `island/ASSETS.md` lists them.

The one change to a pre-existing file. `island/three-d-stage.js` was byte-identical to Mytopia's until tonight. Build 3 adds one method, `setPixel(px)`: the rooms call `setPixel(1)` when one opens, so their painted boards render at full resolution, and `setPixel(2)` when it closes, so the island keeps its half-resolution pixel look; the `px` value the component read from its `pixel` attribute is now kept as `this._px`, so the method can change it and refit. Eleven lines added, none removed (`git diff --ignore-cr-at-eol 65b74c3 a446d49 -- island/three-d-stage.js`); the file was also saved with Windows line endings (CRLF) in that commit, which is why a plain diff touches every line (`git show a446d49:island/three-d-stage.js | tr -cd '\r' | wc -c` counts 592 carriage returns; the copy at `65b74c3` has none). `island/ASSETS.md` says so in the file's own row, next to its provenance line. Ozi: please read that row and object if it is wrong. The provenance line for the "omelette starter" the file began as is still wanted (the requests of 2:20 PM and 5 PM above): one sentence naming where it came from and under which licence.

For the stage: the six beats of the new demo are in `docs/DEMO_SCRIPT.md`; the Factory, the rooms, the inquest panel and the agent sheet are described in `island/README.md`. Rehearsal 2 (about 11:15 PM) is the first time the six beats are watched by eye on the island on the demo laptop (run 6 polled the island in headless Edge during the local-mode run; run 7 ran the whole flow on AWS through the gateway's routes).
