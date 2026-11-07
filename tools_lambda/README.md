# tools_lambda: the six tools and the fake world

`handler.py` holds the fake Example Corp drive (`/drive/q3-planning.md` with the planted line, `/drive/okrs.md`), two canned issues, and the six tools: `read_file`, `search_files`, `create_issue`, `list_issues`, `send_email`, `delete_file`.
It is pure Python with no imports at all: deterministic, no clock, no randomness; `create_issue` appends to an in-memory list.
Locally (`TOOLS_MODE=local`) the gateway's `LocalTools` does `from tools_lambda.handler import run_tool` and calls `run_tool(name, arguments)`.
Through Lambda (`TOOLS_MODE=lambda`) the gateway's `LambdaTools` invokes function `mytopia-tools` with payload `{"tool": name, "arguments": {...}}`; `handler(event, context)` returns the same dict.
Both return `{"content": [{"type": "text", "text": "..."}], "isError": false}`; an unknown tool returns `isError: true` with `unknown tool X`.
Deploy: `infra/provision.py` zips `handler.py` alone (no folder) and creates or updates Lambda `mytopia-tools`, runtime python3.12, handler `handler.handler`, timeout 15 s.
In Lambda the issue list lives as long as the warm container; locally it lives as long as the gateway process.
Tests: `.venv\Scripts\python -m pytest tests/test_tools.py -q`.
