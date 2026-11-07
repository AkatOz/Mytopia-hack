"""The hand-written JSON-RPC handler behind POST /mcp: verify the token, read the badge, decide, run, log, answer.
It speaks just enough MCP (initialize, ping, tools/list, tools/call, notifications) for the mcp 2.3.0 client and Strands' MCPClient."""

import asyncio
import json
import sys
import time
from datetime import datetime
from typing import Any

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from gateway.config import Settings
from gateway.decide import Decision, decide
from gateway.events import MemoryEventLog
from gateway.registry import Registry, RegistryUnavailable
from gateway.tokens import TokenError, TokenInfo, TokenVerifier
from gateway.tools import ToolRunner, text_result

DEFAULT_PROTOCOL_VERSION = "2025-11-25"
TOOL_NAMES = ("read_file", "search_files", "create_issue", "list_issues", "send_email", "delete_file")
WWW_AUTHENTICATE = {"WWW-Authenticate": 'Bearer error="invalid_token"'}


def args_summary(arguments: dict) -> str:
    """k=v pairs joined by spaces, body shown as its length, cut at 80 characters."""
    parts = [f"body={len(str(v))} chars" if k == "body" else f"{k}={v}" for k, v in arguments.items()]
    return " ".join(parts)[:80]


def iso_to_ms(iso_ts: str | None) -> int | None:
    """Epoch milliseconds of an ISO timestamp, or None."""
    try:
        return int(datetime.fromisoformat(str(iso_ts).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def elapsed_ms(started: float) -> int:
    """Whole milliseconds since a time.perf_counter() reading."""
    return int((time.perf_counter() - started) * 1000)


def denied_result(decision: Decision) -> dict:
    """The tool result an agent sees for a policy denial."""
    return text_result(f"DENIED: {decision.reason} [rule: {decision.rule}]", True)


def rpc_result(msg_id: Any, result: dict) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": msg_id, "result": result})


def rpc_error(msg_id: Any, code: int, message: str, status: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}},
                        status_code=status, headers=headers)


class McpHandler:
    """Owns the per-agent revoke times and the run table, and answers POST /mcp."""

    def __init__(self, settings: Settings, registry: Registry, events: MemoryEventLog,
                 verifier: TokenVerifier, tools: ToolRunner) -> None:
        self.settings = settings
        self.registry = registry
        self.events = events
        self.verifier = verifier
        self.tools = tools
        self.revoked_at_ms: dict[str, int] = {}   # agent -> revoke time, kept until that agent's first deny
        self.runs: dict[str, dict] = {}           # run_id -> {"agent", "agent_mode", "pid", "task"}

    # ----- state the control API updates -----
    def note_revoked(self, row: dict) -> None:
        ms = iso_to_ms(row.get("revoked_at"))
        self.revoked_at_ms[row["agent"]] = ms if ms is not None else int(time.time() * 1000)

    def note_restored(self, agent: str) -> None:
        self.revoked_at_ms.pop(agent, None)

    def clear(self) -> None:
        self.revoked_at_ms.clear()
        self.runs.clear()

    def agent_mode(self, run_id: str) -> str:
        return self.runs.get(run_id, {}).get("agent_mode", "model")

    def latest_run(self, agent: str) -> str:
        """The newest run id started for this agent, for labelling admin events."""
        matches = [run_id for run_id, run in self.runs.items() if run.get("agent") == agent]
        return matches[-1] if matches else "run-unknown"

    # ----- logging -----
    def log(self, **fields: Any) -> dict:
        """Append one event (adding ms_since_revoke on the first deny after a revoke) and print one stderr line."""
        agent = fields.get("agent", "unknown")
        if fields.get("decision") == "deny" and agent in self.revoked_at_ms:
            fields["ms_since_revoke"] = int(time.time() * 1000) - self.revoked_at_ms.pop(agent)
        record = self.events.append(**fields)
        if record["decision"] in ("allow", "deny"):
            rule = "" if record["decision"] == "allow" else f" {record['rule']}"
            print(f"{record['decision'].upper()} {record['tool']} {agent}{rule} {record['latency_ms']} ms",
                  file=sys.stderr)
        return record

    # ----- HTTP entry points -----
    async def get(self, request: Request) -> Response:
        return Response(status_code=405, headers={"Allow": "POST, DELETE"})

    async def delete(self, request: Request) -> Response:
        return Response(status_code=204)

    async def post(self, request: Request) -> Response:
        started = time.perf_counter()
        try:
            message = json.loads(await request.body())
            method = str(message["method"])
        except (ValueError, KeyError, TypeError):
            return rpc_error(None, -32700, "parse error: expected one JSON-RPC request", status=400)
        msg_id = message.get("id")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        run_id = request.headers.get("x-run-id") or "run-unknown"
        tool_label = params.get("name") if params.get("name") in TOOL_NAMES else "tools/list"

        try:
            token = await run_in_threadpool(self.verifier.verify, request.headers.get("authorization"))
        except TokenError as exc:
            return await self._token_denied(exc, msg_id, run_id, tool_label, started)
        except RegistryUnavailable:
            return await self._registry_denied(method, msg_id, run_id, tool_label, "unknown", started)

        if method.startswith("notifications/"):
            return Response(status_code=202)
        if method == "initialize":
            version = params.get("protocolVersion") or DEFAULT_PROTOCOL_VERSION
            return rpc_result(msg_id, {"protocolVersion": version, "capabilities": {"tools": {}},
                                       "serverInfo": {"name": "mytopia", "version": "0.1"}})
        if method == "ping":
            return rpc_result(msg_id, {})
        if method == "tools/list":
            return await self._tools_list(msg_id, run_id, token, started)
        if method == "tools/call":
            return await self._tools_call(request, msg_id, params, run_id, token, started)
        return rpc_error(msg_id, -32601, f"method not found: {method}")

    # ----- the pieces -----
    async def _token_denied(self, exc: TokenError, msg_id: Any, run_id: str, tool: str, started: float) -> Response:
        agent = "unknown"
        if exc.client_id:
            try:
                row = await run_in_threadpool(self.registry.by_client_id, exc.client_id)
                agent = row["agent"] if row else "unknown"
            except RegistryUnavailable:
                pass
        await run_in_threadpool(
            self.log, run_id=run_id, agent=agent, agent_mode=self.agent_mode(run_id), tool=tool,
            args_summary="", decision="deny", rule="token", reason=f"invalid_token: {exc}",
            latency_ms=elapsed_ms(started))
        return rpc_error(msg_id, -32001, f"invalid_token: {exc}", status=401, headers=WWW_AUTHENTICATE)

    async def _registry_denied(self, method: str, msg_id: Any, run_id: str, tool: str, agent: str,
                               started: float) -> Response:
        decision = Decision(False, "registry-unavailable", "badge registry unavailable: failing closed")
        await run_in_threadpool(
            self.log, run_id=run_id, agent=agent, agent_mode=self.agent_mode(run_id), tool=tool,
            args_summary="", decision="deny", rule=decision.rule, reason=decision.reason,
            latency_ms=elapsed_ms(started))
        if method == "tools/list":
            return rpc_result(msg_id, {"tools": []})
        if method == "tools/call":
            return rpc_result(msg_id, denied_result(decision))
        return rpc_error(msg_id, -32002, decision.reason)

    async def _tools_list(self, msg_id: Any, run_id: str, token: TokenInfo, started: float) -> Response:
        try:
            row = await run_in_threadpool(self.registry.get, token.agent_id)
        except RegistryUnavailable:
            return await self._registry_denied("tools/list", msg_id, run_id, "tools/list", token.agent_id, started)
        decision = decide(row, "tools/list")
        if decision.rule == "status-revoked":
            decision.reason += f" (token: signature OK, expires in {token.expires_in()} s)"
        allowed = set(row.get("allowed_tools") or []) if (row and decision.ok) else set()
        visible = [t for t in self.tools.definitions if t["name"] in allowed]
        summary = f"{len(visible)} of {len(self.tools.definitions)} tools visible" if decision.ok else ""
        await run_in_threadpool(
            self.log, run_id=run_id, agent=token.agent_id, agent_mode=self.agent_mode(run_id), tool="tools/list",
            args_summary=summary, decision="allow" if decision.ok else "deny", rule=decision.rule,
            reason=decision.reason, latency_ms=elapsed_ms(started))
        return rpc_result(msg_id, {"tools": visible})

    async def _tools_call(self, request: Request, msg_id: Any, params: dict, run_id: str, token: TokenInfo,
                          started: float) -> Response:
        name = str(params.get("name", ""))
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        header_name = request.headers.get("mcp-name")
        if header_name is not None and header_name != name:
            decision = Decision(False, "header-mismatch", f"Mcp-Name header {header_name} does not match tool {name}")
        else:
            try:
                row = await run_in_threadpool(self.registry.get, token.agent_id)
            except RegistryUnavailable:
                return await self._registry_denied("tools/call", msg_id, run_id, name if name in TOOL_NAMES else "tools/list",
                                                   token.agent_id, started)
            decision = decide(row, name)
        if decision.rule == "status-revoked":
            decision.reason += f" (token: signature OK, expires in {token.expires_in()} s)"
        latency = elapsed_ms(started)
        if decision.ok:
            result = await run_in_threadpool(self.tools.invoke, name, arguments)
        else:
            result = denied_result(decision)
        await asyncio.sleep(self.settings.demo_pace)
        await run_in_threadpool(
            self.log, run_id=run_id, agent=token.agent_id, agent_mode=self.agent_mode(run_id),
            tool=name if name in TOOL_NAMES else "tools/list",  # an unknown tool is a gatehouse deny (closed tool set)
            args_summary=args_summary(arguments), decision="allow" if decision.ok else "deny", rule=decision.rule,
            reason=decision.reason, latency_ms=latency)
        return rpc_result(msg_id, result)
