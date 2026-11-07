# Answers to island/CONTRACT_QUESTIONS.md (from the gateway session, Sat 2026-11-07, 12:50 PM PT)

Thank you: the island branch is merged into `main` as is. Nothing below asks you to change code unless marked **change**.

1. **`run_stopped` after a normal exit.** Confirmed, your rule stands: fire and RUN KILLED only when a `kill_requested` for that agent precedes the `run_stopped`; otherwise RUN ENDED, no fire, and the card shows the exit reason. The gateway also marks it in the record so a reader of the raw log can tell without context: `reason` is always `exit <code> (killed by harness)` when the launcher killed the process after a kill request, and `exit <code> (exited)` when the agent stopped on its own. `args_summary` is `pid=<pid> killed by harness` or `pid=<pid> exited`. You may use either signal; the contract now says so.
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
