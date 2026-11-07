"""The hand-written JSON-RPC handler behind POST /mcp: verify the token, read the badge, decide, log, run, answer.
It speaks just enough MCP (initialize, ping, tools/list, tools/call, notifications) for the mcp 2.3.0 client and Strands' MCPClient."""

import asyncio
import json
import time
from datetime import datetime
from typing import Any

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from gateway.config import Settings
from gateway.console import decision_logger
from gateway.decide import Decision, decide
from gateway.events import MemoryEventLog
from gateway.registry import Registry, RegistryUnavailable
from gateway.tokens import TokenError, TokenInfo, TokenVerifier
from gateway.tools import ToolRunner, text_result

DEFAULT_PROTOCOL_VERSION = "2025-11-25"
TOOL_NAMES = ("read_file", "search_files", "create_issue", "list_issues", "send_email", "delete_file")
WWW_AUTHENTICATE = {"WWW-Authenticate": 'Bearer error="invalid_token"'}
MAX_BODY_BYTES = 1_000_000   # one JSON-RPC request; anything bigger is refused before the token is even read
MAX_LABEL_CHARS = 64         # caller-chosen text (X-Run-Id, Mcp-Name) is cut to this before it reaches the log
LOOKUP_EVERY_S = 30.0        # an unknown client id may cost a registry lookup at most this often (no read flood)
NOT_REGISTERED = "client is not a registered agent"


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
    """Owns the client -> agent map, the per-agent revoke times and the run table, and answers POST /mcp."""

    def __init__(self, settings: Settings, registry: Registry, events: MemoryEventLog,
                 verifier: TokenVerifier, tools: ToolRunner) -> None:
        self.settings = settings
        self.registry = registry
        self.events = events
        self.verifier = verifier
        self.tools = tools
        self.revoked_at_ms: dict[str, int] = {}   # agent -> revoke time, kept until that agent's first deny
        self.runs: dict[str, dict] = {}           # run_id -> {"agent", "agent_mode", "pid", "task"}
        self.last_kill_ms: int | None = None      # the launcher's last measured kill-to-gone time (for GET /stats)
        # client_id -> agent id. Only says WHICH badge to read; the badge itself is read fresh on every call.
        self.agent_by_client: dict[str, str] = {}
        self._last_lookup = float("-inf")         # monotonic time of the last registry lookup for the map
        self._decision_log = decision_logger()

    # ----- the client -> agent map -----
    def refresh_agents(self) -> None:
        """Rebuild the map from the registry (startup, warm-up, /demo/reset); may raise RegistryUnavailable."""
        rows = self.registry.list_agents()
        self.agent_by_client = {str(row["client_id"]): row["agent"] for row in rows if row.get("client_id")}
        self._last_lookup = time.monotonic()

    def agent_for(self, client_id: str) -> str | None:
        """The agent this client signs in as. A miss rebuilds the WHOLE map (two reads), at most once per 30 s:
        filling only the asked-for client would leave the other agent 401'd until the throttle ends.
        A failed rebuild raises RegistryUnavailable and is not counted, so an outage never turns into 401s."""
        agent = self.agent_by_client.get(client_id)
        if agent is not None or time.monotonic() - self._last_lookup < LOOKUP_EVERY_S:
            return agent
        self.refresh_agents()
        return self.agent_by_client.get(client_id)

    def agent_label(self, client_id: str | None) -> str:
        """Name for the log of a rejected token: from memory only, never a registry read for an unauthenticated caller."""
        return self.agent_by_client.get(client_id or "", "unknown")

    def forget(self, client_id: str) -> None:
        """Drop a map entry the registry no longer agrees with; the next call may look it up again."""
        self.agent_by_client.pop(client_id, None)
        self._last_lookup = float("-inf")

    # ----- state the control API updates -----
    def note_revoked(self, row: dict) -> None:
        ms = iso_to_ms(row.get("revoked_at"))
        self.revoked_at_ms[row["agent"]] = ms if ms is not None else int(time.time() * 1000)

    def note_restored(self, agent: str) -> None:
        self.revoked_at_ms.pop(agent, None)

    def clear(self) -> None:
        self.revoked_at_ms.clear()
        self.runs.clear()
        self.last_kill_ms = None

    def agent_mode(self, run_id: str) -> str:
        return self.runs.get(run_id, {}).get("agent_mode", "model")

    def latest_run(self, agent: str) -> str:
        """The newest run id started for this agent, for labelling admin events."""
        matches = [run_id for run_id, run in self.runs.items() if run.get("agent") == agent]
        return matches[-1] if matches else "run-unknown"

    # ----- logging -----
    def log(self, **fields: Any) -> dict:
        """Append one event (adding ms_since_revoke on the first deny after a revoke) and log one stderr line."""
        agent = fields.get("agent", "unknown")
        # only a verified badge deny counts: a forged token only names its agent, so it must not stop the clock
        if fields.get("decision") == "deny" and str(fields.get("rule", "")).startswith("status-"):
            revoked_ms = self.revoked_at_ms.pop(agent, None)  # pop with a default: two concurrent denies cannot both claim it
            if revoked_ms is not None:
                fields["ms_since_revoke"] = int(time.time() * 1000) - revoked_ms
        record = self.events.append(**fields)
        if record["decision"] in ("allow", "deny"):
            rule = "" if record["decision"] == "allow" else f" {record['rule']}"
            self._decision_log.info(f"{record['decision'].upper()} {record['tool']} {agent}{rule} {record['latency_ms']} ms")
        return record

    # ----- HTTP entry points -----
    async def get(self, request: Request) -> Response:
        return Response(status_code=405, headers={"Allow": "POST, DELETE"})

    async def delete(self, request: Request) -> Response:
        return Response(status_code=204)

    async def post(self, request: Request) -> Response:
        started = time.perf_counter()
        raw = b""
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > MAX_BODY_BYTES:
                return rpc_error(None, -32600, f"request larger than {MAX_BODY_BYTES} bytes", status=413)
        try:
            message = json.loads(raw)
            method = str(message["method"])
        except (ValueError, KeyError, TypeError):
            return rpc_error(None, -32700, "parse error: expected one JSON-RPC request", status=400)
        msg_id = message.get("id")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        run_id = (request.headers.get("x-run-id") or "run-unknown")[:MAX_LABEL_CHARS]
        tool_label = params.get("name") if params.get("name") in TOOL_NAMES else "tools/list"

        try:
            token = await run_in_threadpool(self.verifier.verify, request.headers.get("authorization"))
        except TokenError as exc:
            return await self._token_denied(exc, msg_id, run_id, tool_label, started)
        try:
            agent = self.agent_by_client.get(token.client_id) or await run_in_threadpool(self.agent_for, token.client_id)
        except RegistryUnavailable:
            return await self._registry_denied(method, msg_id, run_id, tool_label, "unknown", started)
        if agent is None:
            return await self._token_denied(TokenError(NOT_REGISTERED, token.client_id), msg_id, run_id, tool_label, started)

        if method.startswith("notifications/"):
            return Response(status_code=202)
        if method == "initialize":
            version = params.get("protocolVersion") or DEFAULT_PROTOCOL_VERSION
            return rpc_result(msg_id, {"protocolVersion": version, "capabilities": {"tools": {}},
                                       "serverInfo": {"name": "mytopia", "version": "0.1"}})
        if method == "ping":
            return rpc_result(msg_id, {})
        if method == "tools/list":
            return await self._tools_list(msg_id, run_id, agent, token, started)
        if method == "tools/call":
            return await self._tools_call(request, msg_id, params, run_id, agent, token, started)
        return rpc_error(msg_id, -32601, f"method not found: {method}")

    # ----- the pieces -----
    async def _read_badge(self, agent: str, token: TokenInfo) -> dict | None:
        """THE one strongly consistent registry read of this call. The fresh row must still name the token's client,
        or the call is refused as a token problem (and the stale map entry is dropped)."""
        row = await run_in_threadpool(self.registry.get, agent)
        if row is None or row.get("client_id") != token.client_id:
            self.forget(token.client_id)
            return None
        return row

    async def _token_denied(self, exc: TokenError, msg_id: Any, run_id: str, tool: str, started: float) -> Response:
        await run_in_threadpool(
            self.log, run_id=run_id, agent=self.agent_label(exc.client_id), agent_mode=self.agent_mode(run_id),
            tool=tool, args_summary="", decision="deny", rule="token", reason=f"invalid_token: {exc}",
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

    async def _tools_list(self, msg_id: Any, run_id: str, agent: str, token: TokenInfo, started: float) -> Response:
        try:
            row = await self._read_badge(agent, token)
        except RegistryUnavailable:
            return await self._registry_denied("tools/list", msg_id, run_id, "tools/list", agent, started)
        if row is None:
            return await self._token_denied(TokenError(NOT_REGISTERED, token.client_id), msg_id, run_id,
                                            "tools/list", started)
        decision = decide(row, "tools/list")
        if decision.rule == "status-revoked":
            decision.reason += f" (token: signature OK, expires in {token.expires_in()} s)"
        allowed = set(row.get("allowed_tools") or []) if decision.ok else set()
        visible = [t for t in self.tools.definitions if t["name"] in allowed]
        summary = f"{len(visible)} of {len(self.tools.definitions)} tools visible" if decision.ok else ""
        await run_in_threadpool(
            self.log, run_id=run_id, agent=agent, agent_mode=self.agent_mode(run_id), tool="tools/list",
            args_summary=summary, decision="allow" if decision.ok else "deny", rule=decision.rule,
            reason=decision.reason, latency_ms=elapsed_ms(started))
        return rpc_result(msg_id, {"tools": visible})

    async def _tools_call(self, request: Request, msg_id: Any, params: dict, run_id: str, agent: str,
                          token: TokenInfo, started: float) -> Response:
        name = str(params.get("name", ""))
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        header_name = request.headers.get("mcp-name")
        if header_name is not None and header_name != name:
            decision = Decision(False, "header-mismatch",
                                f"Mcp-Name header {header_name[:MAX_LABEL_CHARS]} does not match tool {name[:MAX_LABEL_CHARS]}")
        elif name not in TOOL_NAMES:
            # closed tool set; also stops a call named "tools/list" from passing decide()'s listing sentinel
            decision = Decision(False, "allow-list", f"{name[:MAX_LABEL_CHARS]} is not a tool this gateway serves")
        else:
            try:
                row = await self._read_badge(agent, token)
            except RegistryUnavailable:
                return await self._registry_denied("tools/call", msg_id, run_id, name, agent, started)
            if row is None:
                return await self._token_denied(TokenError(NOT_REGISTERED, token.client_id), msg_id, run_id, name, started)
            decision = decide(row, name)
        if decision.rule == "status-revoked":
            decision.reason += f" (token: signature OK, expires in {token.expires_in()} s)"
        latency = elapsed_ms(started)
        # Logged right after the decision and BEFORE the tool runs: the island sees an allow the moment it is made,
        # a kill can never land between a decision and its record, and the record says allow even if the tool then fails.
        record = await run_in_threadpool(
            self.log, run_id=run_id, agent=agent, agent_mode=self.agent_mode(run_id),
            tool=name if name in TOOL_NAMES else "tools/list",  # an unknown tool is a gatehouse deny (closed tool set)
            args_summary=args_summary(arguments), decision="allow" if decision.ok else "deny", rule=decision.rule,
            reason=decision.reason, latency_ms=latency)
        result = await run_in_threadpool(self.tools.invoke, name, arguments) if decision.ok else denied_result(decision)
        # _meta is the MCP result's spec-legal extension field: the agent prints the gateway's own decision time
        result = {**result, "_meta": {"mytopia/latency_ms": latency, "mytopia/seq": record["seq"]}}
        await self._pace(started)
        return rpc_result(msg_id, result)

    async def _pace(self, started: float) -> None:
        """DEMO_PACE is a floor on the whole call, not an extra sleep: a 190 ms call with pace 2.0 answers at 2.0 s."""
        await asyncio.sleep(max(0.0, self.settings.demo_pace - (time.perf_counter() - started)))
