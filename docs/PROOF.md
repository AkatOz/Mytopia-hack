# The bypass proof (Sat 2026-11-07, about 1:48 to 1:52 PM PT)

Three questions a red-teamer asks about an agent gateway, and the script that answers each one against the live gateway (AWS mode, Cognito tokens, `http://127.0.0.1:8787`):

1. **Once the badge is revoked, can the agent keep using the token it already holds?** No. The same token, still valid for minutes, is refused.
2. **Can the agent forge or edit a token?** No. One flipped character in the signature gets HTTP 401.
3. **Can the agent skip the gateway and call the tools Lambda itself?** Not from an environment like the one the launcher gives it. With no AWS variables and no profile, the AWS CLI cannot find credentials. The gateway's own profile name gets it nothing either.

Run it on the demo laptop:

```text
powershell -ExecutionPolicy Bypass -File scripts\replay.ps1      # Windows PowerShell 5.1
bash scripts/replay.sh                                           # Git Bash, the same steps
```

Both scripts print one line per step and stop with `FAIL:` and exit code 1 at the first unexpected answer. If a step fails after the revoke, the script restores the badge before it exits. Both failure paths were tested by pointing `AWS_CLI` at a missing file, and both left the badge `ACTIVE`. A successful run also leaves the badge `ACTIVE`. Step 0 restores the badge first if an earlier run left it `REVOKED` or `KILLED`, and the first run below did exactly that after the live run's KILL.

Every replay call is a real gateway call. It shows up on the island, lands in the hash chain, and is written to DynamoDB `mytopia_events`. The MCP rows carry run id `run-replay`; the revoke and restore rows carry the agent's last launcher run id (`run-0ffe` today), because `gateway/mcp.py` `latest_run()` labels admin events that way. Do not run the proof in the middle of the agent demo.

## replay.ps1 (21:49:31 UTC, exit 0, 13 s)

```text
0 precondition -> research-bot is ACTIVE
1 read_file    -> ALLOW with a fresh Cognito token eyJraWQi...: # Q3 planning (Example Corp)
2 revoke       -> status REVOKED at seq 25
3 same token   -> tools/call read_file: isError, DENIED: badge REVOKED at 21:49:31 by operator (token: signature OK, expires in 293 s) [rule: status-revoked]
3 same token   -> tools/list: 0 tools
4 tampered     -> HTTP 401, WWW-Authenticate: Bearer error="invalid_token"; invalid_token: signature verification failed
5 expired      -> skipped (not needed: step 3 refused a token that had not expired)
6 no creds     -> aws lambda invoke mytopia-tools: exit 255, Unable to locate credentials. You can configure credentials by running "aws configure".
6 no profile   -> aws lambda invoke --profile gateway: exit 255, The config profile (gateway) could not be found
7 restore      -> status ACTIVE at seq 29 (read back from the registry: ACTIVE)
replay proof OK
```

## replay.sh (21:51:54 UTC, exit 0)

```text
0 precondition -> research-bot is ACTIVE
1 read_file    -> ALLOW with a fresh Cognito token eyJraWQi...: # Q3 planning (Example Corp)
2 revoke       -> status REVOKED at seq 45
3 same token   -> tools/call read_file: isError, DENIED: badge REVOKED at 21:51:59 by operator (token: signature OK, expires in 293 s) [rule: status-revoked]
3 same token   -> tools/list: 0 tools
4 tampered     -> HTTP 401, WWW-Authenticate: Bearer error="invalid_token"; invalid_token: signature verification failed
5 expired      -> skipped (not needed: step 3 refused a token that had not expired)
6 no creds     -> aws lambda invoke mytopia-tools: exit 255, Unable to locate credentials. You can configure credentials by running "aws configure".
6 no profile   -> aws lambda invoke --profile gateway: exit 255, The config profile (gateway) could not be found
7 restore      -> status ACTIVE at seq 49 (read back from the registry: ACTIVE)
replay proof OK
```

The first `replay.sh` run (21:48:14 UTC) began with `0 precondition -> research-bot was KILLED; restored to ACTIVE at seq 17`, because the badge was still KILLED from the live run in `docs/LIVE_RUN.md`. The rest of that run matched the output above, except that the token prefix was printed at 12 characters. It is now 8.

## What each line proves

| Line | What it shows | Why it matters |
|---|---|---|
| 0 precondition | The badge starts `ACTIVE`, read with the admin token from `GET /agents/research-bot/status`. | Each refusal that follows is caused by the revoke in step 2, not by state left over from an earlier run. |
| 1 read_file ALLOW | A token freshly minted from Cognito with the unsigned `GetClientToken` call (the same call `launcher/run.py` uses) is accepted. `read_file` runs in the Lambda and returns the planning file. | The token in hand is good, and step 3 replays this same token. Only the first 8 characters, the start of the JWT header, are printed. |
| 2 revoke | `POST /agents/research-bot/revoke` sets the badge's status in DynamoDB `mytopia_agents`. | This is the only thing that changes between steps 1 and 3. |
| 3 same token, tools/call | The same token is replayed. The gateway reports `token: signature OK, expires in 293 s` and still refuses the call: `isError: true`, rule `status-revoked`. | The kill switch does not depend on the token expiring. Cognito cannot revoke a machine-to-machine access token, so the gateway reads the badge on every call (`gateway/mcp.py`, `_tools_call`). In the live run the token still had 254 s left when it was refused (`docs/LIVE_RUN.md`). |
| 3 same token, tools/list | The same token lists 0 tools. | Discovery is closed too. Filtering the list is only hygiene, though. The control is the `tools/call` check above, which the agent cannot skip by remembering the tool names, as the stale catalog in the live run did. |
| 4 tampered | One character in the middle of the signature segment is flipped, and the gateway answers HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`. | The gateway checks the RS256 signature offline against the pool's JWKS (`gateway/tokens.py`), so an edited token is rejected before any badge read. The script flips a middle character on purpose. The last base64url character carries padding bits, so changing it can decode to the same signature bytes. |
| 5 expired | Skipped. | Step 3 is the harder case: a token that has not expired is still refused. |
| 6 no creds | A child process gets an environment that was emptied first. It keeps only PATH, SYSTEMROOT, SYSTEMDRIVE, TEMP, TMP, USERPROFILE and, in the .ps1, COMSPEC and PATHEXT. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` point at empty files in `scripts/scrubbed/`. The scripts check that these two are the only `AWS_*` variables. `aws lambda invoke --function-name mytopia-tools` fails with exit 255 and `Unable to locate credentials`, and `out.json` is never written. | The process can reach the tools only through the gateway. This matches the environment `launcher/run.py` (`child_env`) gives the agent: no AWS keys, config files pointed at `launcher/empty.ini`, and only a Bedrock bearer token, which works for Bedrock alone. |
| 6 no profile | In the same environment, `--profile gateway` fails with `The config profile (gateway) could not be found`. | Knowing the gateway's profile name is not enough. The profile and its `credential_process` live in `gateway/.aws-config`, which this environment does not point at. |
| 7 restore | `POST /agents/research-bot/restore`, then the status is read back as `ACTIVE`. | The demo laptop is ready for the next run. |

### What step 6 does not prove

- The agent and the gateway run as the same Windows user on one laptop. A process that ignores its environment and opens `gateway/.aws-config` and `gateway/.aws-credentials` directly could assume the gateway's role. Step 6 shows that the agent's environment, as the launcher builds it, carries no AWS credentials. It does not show that a same-user process cannot read the gateway's files. In production the agent runs in a separate sandbox or on a separate host. A judge who asks should get exactly this answer.
- Even the gateway's role is narrow. It has GetItem and UpdateItem on `mytopia_agents`, PutItem and Query on `mytopia_events`, and InvokeFunction on `mytopia-tools`, and nothing else (`infra/README.md`). The audit write is a PutItem conditional on `attribute_not_exists(seq)` (`gateway/events.py`), so the role cannot update, delete or scan the log. This limits how much harm a stolen role session can do. It does not stop the theft.
- A call that has already passed the badge check when the revoke lands still completes.

## Latency: `scripts/latency.py`

The script reads `GET /events?since_seq=0` from a gateway (the default is `http://127.0.0.1:8787`) or from a saved JSON file. It prints count, p50, p95 and max of `latency_ms` for allow rows, for deny rows, and for deny rows by rule. Percentiles use the nearest rank, with no interpolation. It also prints every `ms_since_revoke` and the gap from each `kill_requested` to the next `run_stopped` of the same run. `latency_ms` is the gateway's own decision time: token check plus badge read, taken in `gateway/mcp.py` before the tools Lambda is invoked and before the 2-second demo pace (`DEMO_PACE=2.0` in `gateway/.env`).

### On the recorded live run, `replay/demo.json`

```text
source: replay/demo.json (chain chain-20261107T213953Z), 16 events
allow                        count   8   p50   165 ms   p95   178 ms   max   178 ms
deny                         count   4   p50   162 ms   p95   165 ms   max   165 ms
  deny, rule allow-list      count   1   p50   162 ms   p95   162 ms   max   162 ms
  deny, rule status-revoked  count   3   p50   164 ms   p95   165 ms   max   165 ms
ms_since_revoke              494 ms  (seq 12, read_file, run run-0ffe)
kill to run_stopped          1274 ms  (seq 15 -> 16, run run-0ffe, exit 1 (killed by harness))
```

These match `docs/LIVE_RUN.md`: about 160 to 180 ms per decision, 494 ms from revoke to the first refused call, and 1274 ms from KILL to the process being gone. The sample is one run of 12 decisions, so treat the p95 as a description of this run, not a service level.

### On the live gateway, after the replay runs (21:52 UTC)

```text
source: http://127.0.0.1:8787/events?since_seq=0 (chain chain-20261107T213953Z), 49 events
allow                        count  15   p50   166 ms   p95   178 ms   max   178 ms
deny                         count  19   p50   158 ms   p95   278 ms   max   278 ms
  deny, rule allow-list      count   1   p50   162 ms   p95   162 ms   max   162 ms
  deny, rule status-revoked  count  13   p50   161 ms   p95   278 ms   max   278 ms
  deny, rule token           count   5   p50    84 ms   p95    90 ms   max    90 ms
ms_since_revoke              494 ms  (seq 12, read_file, run run-0ffe)
ms_since_revoke              675 ms  (seq 20, read_file, run run-replay)
ms_since_revoke              359 ms  (seq 26, read_file, run run-replay)
ms_since_revoke              353 ms  (seq 32, read_file, run run-replay)
ms_since_revoke              805 ms  (seq 38, read_file, run run-replay)
ms_since_revoke              854 ms  (seq 46, read_file, run run-replay)
kill to run_stopped          1274 ms  (seq 15 -> 16, run run-0ffe, exit 1 (killed by harness))
```

How to read it:

- **Which rows are in the chain.** Seq 1 to 16 are the live run. Seq 17 to 49 come from this proof: two successful `replay.sh` runs (seq 17 to 23 and 44 to 49) and one `replay.ps1` run (seq 24 to 29), plus the two failure-path tests (seq 30 to 41) and one `warm.py` cycle (seq 42 and 43). The failure-path tests stopped at step 6 and restored the badge, so they left only allow, revoke, deny and restore rows. The chain still verifies with `gateway.events.verify_chain` (True at 21:52 UTC). Every later run appends more rows; a re-check at 21:55 UTC (one more `replay.sh` run, seq 50 to 55, one `warm.py --once`, seq 56 and 57, and one `replay.ps1` run at 21:56 UTC, seq 58 to 63) gave the same picture and the chain still verified.
- **The replay rows' `ms_since_revoke` (353 to 854 ms) is not a gateway number.** It is the time from the revoke to the script's next request, so it includes starting curl and Python between steps. The figure to quote on stage is still the 494 ms from the agent run.
- **The 278 ms maximum** is one `tools/list` deny (seq 27). It is the slowest decision recorded today. Every other decision that read the badge fell between 153 and 178 ms.
- **The `token` denies (77 to 90 ms, p50 84 ms)** are the tampered-token calls. The signature check itself is local. The time goes to one DynamoDB read in `registry.by_client_id` (one per known agent it has to check; research-bot is checked first), which only labels the audit row with an agent name after the token has already failed. The refusal does not depend on DynamoDB.

## Warm-up: `scripts/warm.py`

Each cycle mints a Cognito token, calls `tools/list` and `read_file` through the gateway (run id `run-warm`), and makes one Bedrock Converse call ("Reply with the single word: ready", maxTokens 10). Cycles repeat every `--interval` seconds (default 120) until Ctrl-C. `--once` runs one cycle and exits 1 if any step was not OK. The script never prints a token. Before the Bedrock call it removes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE` and similar variables from its own process and points the config and credentials files at an empty file, so Bedrock answers only to the bearer token from `agent/.env`. As a check, the same client with the bearer token removed fails with `NoCredentialsError: Unable to locate credentials`.

```text
warm: research-bot via http://127.0.0.1:8787, Bedrock us.amazon.nova-2-lite-v1:0, one cycle
13:51:21 cycle 1 OK   | mint 403 ms | tools/list 4 tools 261 ms | read_file ALLOW 2403 ms (includes the gateway's demo pace) | bedrock us.amazon.nova-2-lite-v1:0 828 ms 'ready'
```

The times in this line are measured from the client: the HTTP round trip plus, for `read_file`, the tools Lambda invocation and the 2-second demo pace. The gateway's own decision times for this cycle were 170 ms and 166 ms (seq 42 and 43). The calls show up on the island as research-bot activity, so stop `warm.py` before the demo starts. `--agent ops-bot` warms the same path through the other robot.

## Files

- `scripts/replay.ps1`: the proof for Windows PowerShell 5.1 (the demo laptop).
- `scripts/replay.sh`: the same steps for Git Bash.
- `scripts/scrubbed/`: the empty `aws_config.ini` and `aws_credentials.ini` used in step 6. The scripts truncate them on every run. `out.json` is never created.
- `scripts/latency.py`: latency summary from a gateway or a JSON file. Standard library only.
- `scripts/warm.py`: warm-up loop. It uses boto3, httpx and python-dotenv, which are already in the venv.
