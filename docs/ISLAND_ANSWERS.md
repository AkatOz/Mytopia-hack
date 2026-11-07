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
