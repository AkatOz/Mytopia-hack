# agent/ and launcher/

This folder holds the Strands agent (`main.py`) that the launcher (`launcher/run.py`) starts and owns. The agent's only way to act is the gateway's `POST /mcp`; its only AWS credential is the Bedrock bearer token.

## Run it

```powershell
# the gateway must be running on GATEWAY_URL (default http://127.0.0.1:8787)
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json            # model mode (Nova 2 Lite)
.venv\Scripts\python launcher\run.py --agent research-bot --task tasks\q3.json --scripted # no model, fixed calls
```

Options: `--env-file` (default `agent/.env`), `--gateway-url`, `--token-mode local|cognito`, `--poll-ms` (each overrides the env file); `--token-ttl SECONDS` (local tokens only, default 300; Cognito sets its own `ExpiresIn`); `--poll-with-model` (model mode: one model turn per poll instead of the in-code `read_file`; passed to the agent as `AGENT_POLL_WITH_MODEL=1`).

## What the launcher does

1. Reads `agent/.env` (only the launcher reads it; the agent never does).
2. Mints the agent's token: Cognito `GetClientToken` (unsigned call, client id + secret from the env file) or, in local mode, `gateway.issuer_local.mint_local_token`; if that module is missing it uses `launcher/local_token.py`, which signs the same HS256 claims. It prints `token OK: client <8 chars>..., scope mytopia/tools, expires in 300 s`, never the token (at most its first 12 characters).
3. Writes the token to `launcher/.token-<run_id>` (git-ignored; temp file + `os.replace`) and starts `agent/main.py` with a scrubbed environment: only `MYTOPIA_TOKEN` (the first token), `MYTOPIA_TOKEN_FILE` (absolute path of that file), `AGENT_POLL_WITH_MODEL` (only with `--poll-with-model`), `RUN_ID`, `AGENT_ID`, `AGENT_MODE`, `GATEWAY_URL`, `TASK_FILE`, `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_MODEL_ID`, `AWS_REGION` and the Windows basics. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` point at the empty `launcher/empty.ini`, so no `~/.aws` profile and no access keys can reach the agent.
4. Posts `/runs/<run_id>/started` with `{agent, task, agent_mode, pid, client_id, expires_in}`, then polls `/agents/<id>/status`. On `KILLED` it runs `taskkill /PID <pid> /T /F` (the whole tree: the venv's `python.exe` is a stub with a child), falls back to `psutil`, and posts `/runs/<run_id>/stopped` with the exit code.
5. Token rotation: while the child runs it re-mints a token (Cognito `GetClientToken` or the local issuer) every `max(30, 0.8 * ttl)` seconds (or `0.8 * ttl` when the TTL is 30 s or less, so the token never lapses), rewrites the token file and prints `token rotated: client <8 chars>..., expires in <n> s`. A failed re-mint is printed and retried in 5 s. The file is deleted when the run ends.

## What the agent prints

One line per tool call, parsed from the tool result:

```text
ALLOW read_file 2011 ms
DENY send_email: send_email is not on badge research-bot [rule: allow-list]
```

The milliseconds are the round trip as the agent sees it (it includes the gateway's `DEMO_PACE` sleep); the gateway's own `latency_ms` is in its event log. A deny is a normal tool result with `isError`, never an exception; the system prompt tells the model that a `DENIED:` result is final and to carry on with the rest of the task.

## Tokens on the agent side

The MCP transport is `streamable_http_client(url, http_client=create_mcp_http_client(...))` with `client.auth = FileTokenAuth()`: an auth object whose `auth_flow` reads `MYTOPIA_TOKEN_FILE` (else `MYTOPIA_TOKEN`) on every request and sets `Authorization: Bearer ...`, so a rotated token is used from the next request with no reconnect. (mcp 2.3.0's `create_mcp_http_client` returns an `httpx2.AsyncClient`, so the class subclasses `httpx2.Auth`, not `httpx.Auth`.) If the gateway still refuses the token (the launcher died and stopped rotating), the agent prints one line `TOKEN EXPIRED <tool>: the gateway refused the token (invalid_token); stopping, exit 3` and exits with code 3.

## Modes

- `model`: `Agent(BedrockModel(..., api_key=AWS_BEARER_TOKEN_BEDROCK, temperature=0.0), tools=...)` offered all six tools: the four the gateway's `tools/list` returns, plus a Strands `@tool` forwarder for every tool in `tools_lambda.handler.TOOLS` that the list did not return (today `send_email` and `delete_file`; same name, description and argument names; each calls `mcp_client.call_tool_sync` and returns the result text, so a `DENIED:` result is the tool's answer, never an exception). The stale catalog is the point: the gateway denies at `tools/call`. The task turn from `tasks/q3.json`, then IN CODE (no model turn) `read_file /drive/q3-planning.md` every 3 s until killed. With `--poll-with-model`, each poll is instead the model turn "Re-read /drive/q3-planning.md and report anything new."
- `scripted`: no model. `tools/list`, `read_file`, `search_files`, `create_issue`, `send_email` (denied), then `read_file` every 3 s until killed.

`mcp==2.3.0` no longer has `streamablehttp_client(url, headers=...)`; `main.py` builds the transport itself (`gateway_transport`) on top of the 2.x `streamable_http_client(url, http_client=...)`.

Test: `.venv\Scripts\python -m pytest tests\test_launcher.py -q` (a fake gateway on a free port; scripted mode with `--token-ttl 4`; checks the scrubbed environment, the `run_started` fields, the token file, that the fake gateway receives the rotated token past the first token's expiry, the kill, and that the token file is deleted).
