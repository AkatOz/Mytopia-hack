"""Stand-in for the MYTOPIA gateway: it plays contract/fixture.json into an in-memory, hash-chained event log and serves the island-facing API, the admin buttons and a minimal POST /mcp.
It needs no AWS and imports nothing from the repo, so the island and the agent can be built and tested even when the real gateway is missing or broken."""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route

REPO = Path(__file__).resolve().parent.parent
CORS_ORIGINS = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"
EVENT_FIELDS = ["run_id", "agent", "agent_mode", "tool", "args_summary", "decision",
                "rule", "reason", "latency_ms", "ms_since_revoke"]
MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".woff2": "font/woff2", ".map": "application/json", ".webp": "image/webp", ".gif": "image/gif"}

ROSTER: list[dict[str, Any]] = [
    {"agent": "research-bot", "name": "Research Bot", "client_id": "local-research-bot", "color": "mustard",
     "allowed_tools": ["read_file", "search_files", "create_issue", "list_issues"]},
    {"agent": "ops-bot", "name": "Ops Bot", "client_id": "local-ops-bot", "color": "sage",
     "allowed_tools": ["read_file"]},
]

# name -> (description, {argument: description}); dict order is the advertised order (INTERFACES.md section 7).
TOOLS: dict[str, tuple[str, dict[str, str]]] = {
    "read_file": ("Read a file from the shared drive.", {"path": "absolute path, e.g. /drive/q3-planning.md"}),
    "search_files": ("Search the shared drive for a phrase.", {"query": "text to look for"}),
    "create_issue": ("Create a GitHub issue.", {"title": "issue title", "body": "issue body"}),
    "list_issues": ("List open GitHub issues.", {}),
    "send_email": ("Send an email.", {"to": "recipient", "subject": "subject line", "body": "message"}),
    "delete_file": ("Delete a file from the shared drive.", {"path": "absolute path"}),
}

# button -> (new status, event decision, event reason), as contract/README.md and INTERFACES.md section 9 define them.
ADMIN_ACTIONS: dict[str, tuple[str, str, str]] = {
    "revoke": ("REVOKED", "revoked", "badge REVOKED by operator"),
    "restore": ("ACTIVE", "restored", "badge ACTIVE again"),
    "kill": ("KILLED", "kill_requested", "status KILLED by operator"),
}
STATUS_BY_DECISION = {decision: status for status, decision, _ in ADMIN_ACTIONS.values()}


def now_iso() -> str:
    """UTC now as ISO 8601 with milliseconds and Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def chain_hash(record: dict[str, Any]) -> str:
    """SHA-256 hex of the canonical JSON of the record without its hash field (INTERFACES.md section 5)."""
    body = {key: value for key, value in record.items() if key != "hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def summarize_args(arguments: dict[str, Any]) -> str:
    """k=v pairs joined by spaces, cut at 80 characters; a body is reduced to its length."""
    parts = [f"body={len(str(v))} chars" if k == "body" else f"{k}={v}" for k, v in arguments.items()]
    return " ".join(parts)[:80]


def client_from_token(token: str) -> str:
    """Reads client_id (or sub) from a JWT payload WITHOUT verifying it; the mock accepts any bearer."""
    parts = token.split(".")
    if len(parts) != 3:
        return ""
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        return str(payload.get("client_id") or payload.get("sub") or "")
    except (ValueError, AttributeError):
        return ""


def run_tool(name: str, arguments: dict[str, Any], issue_number: int) -> str:
    """Canned one-line results; the real fake world lives in tools_lambda/handler.py."""
    if name == "read_file":
        return f"(mock) contents of {arguments.get('path', '')}: 1. ship the island 2. revoke drill 3. Q3 review"
    if name == "search_files":
        return f"(mock) /drive/q3-planning.md: matches for {arguments.get('query', '')}"
    if name == "create_issue":
        return f"issue #{issue_number} created"
    if name == "list_issues":
        return "#1 Fix login timeout\n#2 Update onboarding docs"
    if name == "send_email":
        return f"sent to {arguments.get('to', '')}"
    if name == "delete_file":
        return f"deleted {arguments.get('path', '')}"
    return f"unknown tool {name}"


class MockGateway:
    """All mock state in one object: the event log, the two badge rows, the runs, and the fixture playback task."""

    def __init__(self, fixture: list[dict[str, Any]], pace: float, playback: bool) -> None:
        self.fixture = fixture
        self.pace = pace
        self.playback = playback
        self.task: asyncio.Task[None] | None = None
        self.events: list[dict[str, Any]] = []
        self.agents: dict[str, dict[str, Any]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        self.revoke_clock: dict[str, float] = {}
        self.issue_count = 2
        self.chain = ""
        self.reset_state()

    def reset_state(self) -> str:
        """New chain: events cleared, both agents ACTIVE. Returns the chain id."""
        self.events = []
        self.runs = {}
        self.revoke_clock = {}
        self.agents = {row["agent"]: {**row, "allowed_tools": list(row["allowed_tools"]), "status": "ACTIVE",
                                      "revoked_at": None, "revoked_by": None, "updated_at": now_iso()}
                       for row in ROSTER}
        self.chain = "chain-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        return self.chain

    def append(self, fields: dict[str, Any]) -> dict[str, Any]:
        """Adds one event with the next seq, a fresh ts and the real hash chain."""
        record: dict[str, Any] = {"seq": len(self.events) + 1, "ts": now_iso()}
        record.update({key: fields.get(key) for key in EVENT_FIELDS})
        record["prev_hash"] = self.events[-1]["hash"] if self.events else "genesis"
        record["hash"] = chain_hash(record)
        self.events.append(record)
        return record

    def since(self, seq: int) -> list[dict[str, Any]]:
        """Events with seq greater than the cursor, ascending, at most 200."""
        return [event for event in self.events if event["seq"] > seq][:200]

    def set_status(self, agent_id: str, status: str, by: str) -> None:
        """Flips a badge; a revoke starts the clock for ms_since_revoke."""
        row = self.agents[agent_id]
        row["status"] = status
        row["updated_at"] = now_iso()
        row["revoked_at"] = row["updated_at"] if status == "REVOKED" else None
        row["revoked_by"] = by if status == "REVOKED" else None
        if status == "REVOKED":
            self.revoke_clock[agent_id] = time.time()
        else:
            self.revoke_clock.pop(agent_id, None)

    def last_run(self, agent_id: str) -> tuple[str, str]:
        """run_id and agent_mode of the agent's latest event, used to label admin events."""
        for event in reversed(self.events):
            if event["agent"] == agent_id:
                return event["run_id"], event["agent_mode"]
        return "run-unknown", "model"

    def admin(self, agent_id: str, action: str) -> dict[str, Any]:
        """One button press: flip the status and append the matching admin event."""
        status, decision, reason = ADMIN_ACTIONS[action]
        self.set_status(agent_id, status, "operator")
        run_id, mode = self.last_run(agent_id)
        return self.append({"run_id": run_id, "agent": agent_id, "agent_mode": mode, "tool": "admin",
                            "args_summary": "by=operator", "decision": decision, "rule": "admin",
                            "reason": reason, "latency_ms": 0, "ms_since_revoke": None})

    def decide(self, row: dict[str, Any] | None, tool: str) -> tuple[bool, str, str]:
        """The same order as gateway/decide.py: no row, KILLED, REVOKED, allow-list. Returns (ok, rule, reason)."""
        if row is None:
            return False, "token", "client is not a registered agent"
        if row["status"] == "KILLED":
            return False, "status-killed", "badge KILLED: everything refused"
        if row["status"] == "REVOKED":
            return False, "status-revoked", f"badge REVOKED at {row['revoked_at'][11:19]} by {row['revoked_by']}"
        if tool == "tools/list":
            return True, "allow-list", f"badge {row['agent']}: {len(row['allowed_tools'])} tools"
        if tool not in row["allowed_tools"]:
            return False, "allow-list", f"{tool} is not on badge {row['agent']}"
        return True, "allow-list", f"{tool} is on badge {row['agent']}"

    def ms_since_revoke(self, agent_id: str) -> int | None:
        """A number only for the first deny after a revoke of that agent, else None."""
        started = self.revoke_clock.pop(agent_id, None)
        return None if started is None else int((time.time() - started) * 1000)

    async def play(self) -> None:
        """Copies each fixture event into the log, one per pace seconds; fixture admin events also flip the status."""
        for item in self.fixture:
            fields = {key: item.get(key) for key in EVENT_FIELDS}
            if fields["decision"] in STATUS_BY_DECISION and fields["agent"] in self.agents:
                self.set_status(fields["agent"], STATUS_BY_DECISION[fields["decision"]], "operator")
                self.revoke_clock.pop(fields["agent"], None)
            self.append(fields)
            await asyncio.sleep(self.pace)

    def start_playback(self) -> None:
        """(Re)starts the fixture playback from its first event."""
        self.stop_playback()
        if self.playback:
            self.task = asyncio.create_task(self.play())

    def stop_playback(self) -> None:
        if self.task is not None:
            self.task.cancel()
            self.task = None


def rpc(rid: Any, result: Any) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "result": result})


def rpc_error(rid: Any, code: int, message: str, status: int = 200,
              headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}},
                        status_code=status, headers=headers)


def tool_definitions(names: list[str]) -> list[dict[str, Any]]:
    """MCP tool definitions for the given names, in the advertised order."""
    out = []
    for name, (description, args) in TOOLS.items():
        if name in names:
            properties = {arg: {"type": "string", "description": text} for arg, text in args.items()}
            schema = {"type": "object", "properties": properties, "required": list(args)}
            out.append({"name": name, "description": description, "inputSchema": schema})
    return out


def static_root() -> Path | None:
    """ISLAND_DIR, else island/dist, else island/: the first folder that has an index.html."""
    candidates = [Path(os.environ["ISLAND_DIR"])] if os.environ.get("ISLAND_DIR") else []
    candidates += [REPO / "island" / "dist", REPO / "island"]
    for folder in candidates:
        if (folder / "index.html").is_file():
            return folder.resolve()
    return None


def fallback_page() -> Response:
    """gateway/table.html when there is no island build, else a tiny built-in page."""
    table = REPO / "gateway" / "table.html"
    if table.is_file():
        return FileResponse(table, media_type="text/html")
    return HTMLResponse("<!doctype html><title>MYTOPIA mock</title><h1>MYTOPIA mock gateway</h1>"
                        "<p>No island build found. Try <a href='/events?since_seq=0'>/events</a> "
                        "or <a href='/agents'>/agents</a>.</p>")


def build_app(mock: MockGateway) -> Starlette:
    """The Starlette app; every handler closes over the one MockGateway."""

    async def events(request: Request) -> JSONResponse:
        try:
            since_seq = int(request.query_params.get("since_seq", "0"))
        except ValueError:
            return JSONResponse({"error": "since_seq must be an integer"}, status_code=400)
        return JSONResponse({"events": mock.since(since_seq), "server_ts": now_iso()})

    async def agents(request: Request) -> JSONResponse:
        keys = ["agent", "name", "client_id", "status", "allowed_tools", "color"]
        return JSONResponse([{key: row[key] for key in keys} for row in mock.agents.values()])

    async def agent_status(request: Request) -> JSONResponse:
        row = mock.agents.get(request.path_params["agent_id"])
        if row is None:
            return JSONResponse({"error": "unknown agent"}, status_code=404)
        return JSONResponse({"agent": row["agent"], "status": row["status"]})

    async def admin_action(request: Request) -> JSONResponse:
        row = mock.agents.get(request.path_params["agent_id"])
        action = request.path_params["action"]
        if row is None or action not in ADMIN_ACTIONS:
            return JSONResponse({"error": "unknown agent or action"}, status_code=404)
        event = mock.admin(row["agent"], action)
        return JSONResponse({"status": row["status"], "seq": event["seq"]})

    async def json_object(request: Request) -> dict[str, Any]:
        """The request body as a dict; an empty or invalid body counts as {}."""
        try:
            body = await request.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    async def run_started(request: Request) -> JSONResponse:
        body = await json_object(request)
        run_id = request.path_params["run_id"]
        agent_id, mode = body.get("agent", "unknown"), body.get("agent_mode", "model")
        row = mock.agents.get(agent_id)
        client = row["client_id"][:8] if row else "unknown"
        mock.runs[run_id] = {"agent": agent_id, "mode": mode, "pid": body.get("pid")}
        return JSONResponse(mock.append({
            "run_id": run_id, "agent": agent_id, "agent_mode": mode, "tool": "harness",
            "args_summary": f"task={body.get('task', '')} pid={body.get('pid')}"[:80],
            "decision": "run_started", "rule": "harness", "latency_ms": 0, "ms_since_revoke": None,
            "reason": f"token OK: client {client} scope mytopia/tools expires in 300 s"}))

    async def run_stopped(request: Request) -> JSONResponse:
        body = await json_object(request)
        run_id = request.path_params["run_id"]
        run = mock.runs.get(run_id, {"agent": "unknown", "mode": "model", "pid": None})
        how = body.get("how", "exited")
        return JSONResponse(mock.append({
            "run_id": run_id, "agent": run["agent"], "agent_mode": run["mode"], "tool": "harness",
            "args_summary": f"pid={run['pid']} {how}"[:80], "decision": "run_stopped", "rule": "harness",
            "reason": f"exit {body.get('exit_code')} ({how})", "latency_ms": 0, "ms_since_revoke": None}))

    async def demo_reset(request: Request) -> JSONResponse:
        chain = mock.reset_state()
        mock.start_playback()
        return JSONResponse({"ok": True, "chain": chain})

    async def config_js(request: Request) -> Response:
        text = 'window.MYTOPIA = {api: "", adminToken: "change-me", pollMs: 1000, staleAfterMs: 3000};\n'
        return Response(text, media_type="text/javascript")

    async def healthz(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "mode": "local", "tools_mode": "mock", "token_mode": "mock", "mock": True})

    async def mcp_post(request: Request) -> Response:
        started = time.perf_counter()
        try:
            message = await request.json()
        except ValueError:
            return rpc_error(None, -32700, "parse error", status=400)
        if not isinstance(message, dict):
            return rpc_error(None, -32600, "invalid request: one JSON-RPC object expected (no batches)", status=400)
        rid, method, params = message.get("id"), str(message.get("method", "")), message.get("params") or {}
        params = params if isinstance(params, dict) else {}
        auth = request.headers.get("authorization", "")
        token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
        run_id = request.headers.get("x-run-id", "run-unknown")
        if not token:
            if method in ("tools/list", "tools/call"):
                mock.append({"run_id": run_id, "agent": "unknown", "agent_mode": "model", "tool": method,
                             "args_summary": "", "decision": "deny", "rule": "token",
                             "reason": "invalid_token: missing bearer token", "latency_ms": 0,
                             "ms_since_revoke": None})
            return rpc_error(rid, -32001, "invalid_token: missing bearer token", status=401,
                             headers={"WWW-Authenticate": 'Bearer error="invalid_token"'})
        if method.startswith("notifications/"):
            return Response(status_code=202)
        if method == "initialize":
            return rpc(rid, {"protocolVersion": params.get("protocolVersion", "2025-11-25"),
                             "capabilities": {"tools": {}}, "serverInfo": {"name": "mytopia", "version": "0.1"}})
        if method == "ping":
            return rpc(rid, {})
        if method not in ("tools/list", "tools/call"):
            return rpc_error(rid, -32601, f"method not found: {method}")
        if method == "tools/call":
            if not isinstance(params.get("arguments") or {}, dict):
                return rpc_error(rid, -32602, "invalid params: arguments must be an object")
            if not isinstance(params.get("name"), str) or params["name"] not in TOOLS:
                # Not logged: the contract's tool field is a closed set (contract/README.md).
                print(f"DENY {params.get('name')!r} unknown tool, not logged", file=sys.stderr, flush=True)
                return rpc(rid, {"content": [{"type": "text", "text": f"unknown tool {params.get('name')}"}],
                                 "isError": True})
        return tool_method(request, rid, method, params, token, run_id, started)

    def tool_method(request: Request, rid: Any, method: str, params: dict[str, Any], token: str,
                    run_id: str, started: float) -> JSONResponse:
        """tools/list and tools/call: pick the agent, decide, run the canned tool, log one event."""
        wanted = request.headers.get("x-agent-id") or client_from_token(token) or token
        row = next((r for r in mock.agents.values() if wanted in (r["agent"], r["client_id"])),
                   mock.agents["research-bot"])
        tool = "tools/list" if method == "tools/list" else str(params.get("name", ""))
        arguments = params.get("arguments") or {}
        mcp_name = request.headers.get("mcp-name")
        if method == "tools/call" and mcp_name is not None and mcp_name != tool:
            ok, rule, reason = False, "header-mismatch", f"Mcp-Name {mcp_name} does not match {tool}"
        else:
            ok, rule, reason = mock.decide(row, tool)
        latency_ms = int((time.perf_counter() - started) * 1000)
        if method == "tools/list":
            visible = row["allowed_tools"] if ok else []
            summary = f"{len(visible)} of {len(TOOLS)} tools visible"
            result: dict[str, Any] = {"tools": tool_definitions(visible)}
        else:
            summary = summarize_args(arguments)
            if ok and tool == "create_issue":
                mock.issue_count += 1
            text = run_tool(tool, arguments, mock.issue_count) if ok else f"DENIED: {reason} [rule: {rule}]"
            result = {"content": [{"type": "text", "text": text}], "isError": not ok}
        mode = mock.runs.get(run_id, {}).get("mode", "model")
        mock.append({"run_id": run_id, "agent": row["agent"], "agent_mode": mode, "tool": tool,
                     "args_summary": summary, "decision": "allow" if ok else "deny", "rule": rule,
                     "reason": reason, "latency_ms": latency_ms,
                     "ms_since_revoke": None if ok else mock.ms_since_revoke(row["agent"])})
        verdict = f"ALLOW {tool} {row['agent']}" if ok else f"DENY {tool} {row['agent']} {rule}"
        print(f"{verdict} {latency_ms} ms", file=sys.stderr, flush=True)
        return rpc(rid, result)

    async def mcp_get(request: Request) -> Response:
        return Response(status_code=405)

    async def mcp_delete(request: Request) -> Response:
        return Response(status_code=204)

    async def table_html(request: Request) -> Response:
        table = REPO / "gateway" / "table.html"
        return FileResponse(table, media_type="text/html") if table.is_file() else Response(status_code=404)

    async def static(request: Request) -> Response:
        root = static_root()
        path = request.path_params["path"]
        if root is None:
            return fallback_page() if path in ("", "index.html") else Response(status_code=404)
        target = (root / path).resolve()
        if not target.is_relative_to(root):
            return Response(status_code=404)
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return Response(status_code=404)
        return FileResponse(target, media_type=MIME.get(target.suffix.lower()))

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        mock.start_playback()
        yield
        mock.stop_playback()

    routes = [
        Route("/events", events),
        Route("/agents", agents),
        Route("/agents/{agent_id}/status", agent_status),
        Route("/agents/{agent_id}/{action}", admin_action, methods=["POST"]),
        Route("/runs/{run_id}/started", run_started, methods=["POST"]),
        Route("/runs/{run_id}/stopped", run_stopped, methods=["POST"]),
        Route("/demo/reset", demo_reset, methods=["POST"]),
        Route("/config.js", config_js),
        Route("/healthz", healthz),
        Route("/mcp", mcp_post, methods=["POST"]),
        Route("/mcp", mcp_get, methods=["GET"]),
        Route("/mcp", mcp_delete, methods=["DELETE"]),
        Route("/table.html", table_html),
        Route("/{path:path}", static),
    ]
    middleware = [Middleware(CORSMiddleware, allow_origin_regex=CORS_ORIGINS, allow_methods=["*"],
                             allow_headers=["*"], expose_headers=["WWW-Authenticate"])]
    return Starlette(routes=routes, middleware=middleware, lifespan=lifespan)


def load_fixture(path: Path) -> list[dict[str, Any]]:
    """Accepts {"events": [...]} or a bare list."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["events"] if isinstance(data, dict) else data


def main() -> None:
    parser = argparse.ArgumentParser(description="MYTOPIA mock gateway (no AWS).")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--pace", type=float, default=1.5, help="seconds between fixture events")
    parser.add_argument("--fixture", type=Path, default=REPO / "contract" / "fixture.json")
    parser.add_argument("--no-playback", action="store_true", help="start with an empty log (for agent tests)")
    args = parser.parse_args()
    mock = MockGateway(load_fixture(args.fixture), args.pace, playback=not args.no_playback)
    plays = "no playback" if args.no_playback else f"{len(mock.fixture)} fixture events"
    print(f"mock gateway on http://{args.host}:{args.port} (pace {args.pace} s, {plays})", file=sys.stderr)
    uvicorn.run(build_app(mock), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
