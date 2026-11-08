"""The gateway's Starlette app: POST /mcp, the control API the island and the launcher use, /config.js and the static face.
create_app(settings) builds it; the module-level `app` (for `python -m uvicorn gateway.app:app`) is built from gateway/.env on first access."""

import hmac
import json
import os
import sys
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from gateway import warm
from gateway.config import GATEWAY_DIR, REPO_ROOT, Settings
from gateway.console import disable_quick_edit
from gateway.events import DynamoEventLog, MemoryEventLog
from gateway.mcp import MAX_LABEL_CHARS, TOOL_NAMES, McpHandler
from gateway.registry import KNOWN_AGENTS, DynamoRegistry, MemoryRegistry, RegistryUnavailable, now_iso
from gateway.stats import summarize
from gateway.tokens import CognitoVerifier, LocalVerifier, TokenError
from gateway.tools import LambdaTools, LocalTools

LOCALHOST_ORIGINS = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"
# Host headers the gateway answers; anything else (a DNS-rebinding page whose name points at 127.0.0.1) gets 400.
# "testserver" is Starlette's TestClient host; a browser cannot be made to send it.
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]", "testserver"]
DEFAULT_SECRETS = {"change-me", "change-me-too"}
ADMIN_ACTIONS = {"revoke": ("REVOKED", "revoked", "badge REVOKED by operator"),
                 "restore": ("ACTIVE", "restored", "badge ACTIVE again"),
                 "kill": ("KILLED", "kill_requested", "status KILLED by operator")}
TOOL_ACTIONS = {"revoke": ("revoked", "pulled from", "already off"),
                "restore": ("restored", "returned to", "already on")}
AGENT_KEYS = ("agent", "name", "client_id", "status", "allowed_tools", "color")
REPLAY_FILE = "/replay/demo.json"
SHUTDOWN_FLUSH_S = 5.0


def needs_aws(settings: Settings) -> bool:
    return settings.mode == "aws" or settings.tools_mode == "lambda"


def aws_session(settings: Settings) -> Any:
    """A boto3 session on the gateway's narrow profile, or None (every AWS part then fails closed).
    With no AWS_PROFILE at all it refuses to start: the default chain could pick up broad credentials."""
    profile = os.environ.get("AWS_PROFILE")
    if not profile:
        raise RuntimeError("gateway: AWS mode needs AWS_PROFILE (the narrow gateway role) in gateway/.env; "
                           "refusing to fall back to the default credential chain")
    try:
        import boto3  # imported here so local mode never needs AWS settings
        # naming the profile explicitly makes botocore skip AWS_ACCESS_KEY_ID & co. in the environment,
        # so stray broad credentials can never stand in for the narrow gateway role
        return boto3.Session(profile_name=profile, region_name=settings.aws_region)
    except Exception as exc:  # noqa: BLE001
        print(f"gateway: no AWS session ({type(exc).__name__}); AWS parts will fail closed", file=sys.stderr)
        return None


def build_handler(settings: Settings, session: Any) -> McpHandler:
    """Pick registry, event log, token verifier and tool runner from the three mode switches."""
    if settings.mode == "aws":
        registry: Any = DynamoRegistry(settings.table_agents, session)
        events: MemoryEventLog = DynamoEventLog(settings.table_events, session, settings.events_jsonl)
    else:
        registry = MemoryRegistry()
        events = MemoryEventLog(settings.events_jsonl)
    if settings.token_mode == "cognito":
        verifier: Any = CognitoVerifier(settings.cognito_pool_id, settings.aws_region, settings.cognito_scope)
    else:
        verifier = LocalVerifier(settings.local_issuer_secret, settings.cognito_scope)
    tools: Any = LambdaTools(settings.tools_function, session) if settings.tools_mode == "lambda" else LocalTools()
    handler = McpHandler(settings, registry, events, verifier, tools)
    if settings.mode != "aws":
        handler.refresh_agents()  # memory rows: free. In AWS mode the warm-up thread seeds the map (two reads).
    return handler


def static_dir(settings: Settings) -> Path | None:
    """The island build to serve at /, or None to serve table.html there instead."""
    if settings.island_dir is not None:
        return settings.island_dir if settings.island_dir.is_dir() else None
    if (REPO_ROOT / "island" / "dist").is_dir():
        return REPO_ROOT / "island" / "dist"
    if (REPO_ROOT / "island" / "index.html").is_file():
        return REPO_ROOT / "island"
    return None  # never serve gateway/ itself: it holds .env


def create_app(settings: Settings) -> Starlette:
    """Build the whole gateway for these settings."""
    session = aws_session(settings) if needs_aws(settings) else None
    handler = build_handler(settings, session)
    registry, events = handler.registry, handler.events
    if settings.admin_token in DEFAULT_SECRETS:
        print("gateway: WARNING ADMIN_TOKEN is the default value; set a random one in gateway/.env and agent/.env",
              file=sys.stderr)
    if settings.token_mode == "local" and settings.local_issuer_secret in DEFAULT_SECRETS:
        print("gateway: WARNING LOCAL_ISSUER_SECRET is the default value; anyone can mint local tokens", file=sys.stderr)

    def is_admin(request: Request) -> bool:
        given = request.headers.get("x-admin-token", "")
        return hmac.compare_digest(given.encode(), settings.admin_token.encode())

    def unauthorized() -> JSONResponse:
        return JSONResponse({"error": "X-Admin-Token missing or wrong"}, status_code=401)

    def unavailable() -> JSONResponse:
        return JSONResponse({"error": "registry-unavailable"}, status_code=503)

    async def read_json(request: Request) -> dict:
        try:
            body = json.loads(await request.body() or b"{}")
            return body if isinstance(body, dict) else {}
        except ValueError:
            return {}

    async def get_events(request: Request) -> Response:
        try:
            since = int(request.query_params.get("since_seq", "0"))
        except ValueError:
            return JSONResponse({"error": "since_seq must be an integer"}, status_code=400)
        return JSONResponse({"events": events.since(since), "server_ts": now_iso(), "chain": events.chain})

    async def get_agents(request: Request) -> Response:
        try:
            rows = await run_in_threadpool(registry.list_agents)
        except RegistryUnavailable:
            return unavailable()
        return JSONResponse([{k: row.get(k) for k in AGENT_KEYS} for row in rows])

    async def get_status(request: Request) -> Response:
        agent = request.path_params["agent_id"]
        client_id = None
        if not is_admin(request):
            try:
                token = await run_in_threadpool(handler.verifier.verify, request.headers.get("authorization"))
                own_agent = await run_in_threadpool(handler.agent_for, token.client_id)
            except (TokenError, RegistryUnavailable):
                return unauthorized()
            if own_agent != agent:
                return JSONResponse({"error": "a token may only read its own badge"}, status_code=403)
            client_id = token.client_id
        try:
            row = await run_in_threadpool(registry.get, agent)
        except RegistryUnavailable:
            return unavailable()
        if row is None:
            return JSONResponse({"error": f"unknown agent {agent}"}, status_code=404)
        if client_id is not None and row.get("client_id") != client_id:
            handler.forget(client_id)  # the fresh row no longer names this client
            return unauthorized()
        return JSONResponse({"agent": agent, "status": row["status"]})

    async def admin_action(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        agent, action = request.path_params["agent_id"], request.path_params["action"]
        if agent not in KNOWN_AGENTS or action not in ADMIN_ACTIONS:
            return JSONResponse({"error": "unknown agent or action"}, status_code=404)
        status, decision, reason = ADMIN_ACTIONS[action]
        try:
            row = await run_in_threadpool(registry.set_status, agent, status, "operator")
        except RegistryUnavailable:
            return unavailable()
        if status == "REVOKED":
            handler.note_revoked(row)
        elif status == "ACTIVE":
            handler.note_restored(agent)
        run_id = handler.latest_run(agent)
        event = await run_in_threadpool(
            handler.log, run_id=run_id, agent=agent, agent_mode=handler.agent_mode(run_id), tool="admin",
            args_summary="by=operator", decision=decision, rule="admin", reason=reason, latency_ms=0)
        return JSONResponse({"status": status, "seq": event["seq"]})

    tool_lock = threading.Lock()  # this process is the only writer of allowed_tools (besides /demo/reset)

    def change_tools(agent: str, tool: str, action: str) -> tuple[dict | None, bool]:
        """Read the badge and, unless it already says what was asked, write the new tool list: (row, changed).
        Runs in one worker thread under tool_lock, so two concurrent per-tool changes cannot lose one."""
        with tool_lock:
            row = registry.get(agent)
            current = list((row or {}).get("allowed_tools") or [])
            if row is None or (tool in current) == (action == "restore"):
                return row, False
            if action == "revoke":
                wanted = [t for t in current if t != tool]
            else:  # put it back in the catalog's order (unknown names, if a row was hand-edited, go last)
                wanted = sorted([*current, tool],
                                key=lambda t: TOOL_NAMES.index(t) if t in TOOL_NAMES else len(TOOL_NAMES))
            return registry.set_tools(agent, wanted, "operator"), True

    async def tool_action(request: Request) -> Response:
        """POST /agents/{id}/tools/{tool}/revoke|restore: take one tool off the badge or put it back.
        Idempotent: asking for the list the badge already has answers 200 with changed false and logs nothing."""
        if not is_admin(request):
            return unauthorized()
        agent, tool, action = (request.path_params[k] for k in ("agent_id", "tool", "action"))
        if agent not in KNOWN_AGENTS or action not in TOOL_ACTIONS:
            return JSONResponse({"error": "unknown agent or action"}, status_code=404)
        if tool not in TOOL_NAMES:
            return JSONResponse({"error": f"{tool[:MAX_LABEL_CHARS]} is not one of the six tools"}, status_code=400)
        decision, verb, already = TOOL_ACTIONS[action]
        try:
            row, changed = await run_in_threadpool(change_tools, agent, tool, action)
        except RegistryUnavailable:
            return unavailable()
        if row is None:
            return JSONResponse({"error": f"unknown agent {agent}"}, status_code=404)
        if not changed:  # the badge already says what was asked
            return JSONResponse({"status": row.get("status"), "seq": None, "agent": agent, "tool": tool,
                                 "allowed_tools": list(row.get("allowed_tools") or []), "changed": False,
                                 "note": f"{tool} was {already} badge {agent}; nothing changed, nothing logged"})
        if action == "revoke":
            handler.note_tool_revoked(agent, tool)
        else:
            handler.note_tool_restored(agent, tool)
        tools_now = list(row.get("allowed_tools") or [])
        run_id = handler.latest_run(agent)
        event = await run_in_threadpool(
            handler.log, run_id=run_id, agent=agent, agent_mode=handler.agent_mode(run_id), tool=tool,
            args_summary=("badge=" + ",".join(tools_now))[:80], decision=decision, rule="admin",
            reason=f"{tool} {verb} badge {agent} by operator", latency_ms=0)
        return JSONResponse({"status": row.get("status"), "seq": event["seq"], "agent": agent, "tool": tool,
                             "allowed_tools": tools_now, "changed": True})

    async def run_started(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        run_id, body = request.path_params["run_id"], await read_json(request)
        agent = str(body.get("agent", ""))
        if agent not in KNOWN_AGENTS:
            return JSONResponse({"error": f"unknown agent {agent}"}, status_code=400)
        try:
            expires_in = int(body.get("expires_in") or 300)
        except (TypeError, ValueError):
            return JSONResponse({"error": "expires_in must be a whole number of seconds"}, status_code=400)
        # agent_mode lands in every later record of this run: always a short string, whatever the body held
        run = {"agent": agent, "agent_mode": str(body.get("agent_mode") or "model")[:MAX_LABEL_CHARS],
               "pid": body.get("pid"), "task": body.get("task", "")}
        handler.runs[run_id] = run
        handler.note_run_started(agent)  # refusals from an earlier run never count toward this run's quarantine
        client = str(body.get("client_id") or "")[:8]
        if not client:  # the launcher may omit client_id; fall back to the badge row
            try:
                row = await run_in_threadpool(registry.get, agent)
                client = str((row or {}).get("client_id", "?"))[:8]
            except RegistryUnavailable:
                client = "?"
        event = await run_in_threadpool(
            handler.log, run_id=run_id, agent=agent, agent_mode=run["agent_mode"], tool="harness",
            args_summary=f"task={run['task']} pid={run['pid']}"[:80], decision="run_started", rule="harness",
            reason=f"token OK: client {client} scope mytopia/tools expires in {expires_in} s", latency_ms=0)
        return JSONResponse(event)

    async def run_stopped(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        run_id, body = request.path_params["run_id"], await read_json(request)
        run = handler.runs.get(run_id, {})
        how = str(body.get("how", "exited"))
        if isinstance(body.get("kill_ms"), int):  # the launcher's own kill-to-gone time; memory only, not in the record
            handler.last_kill_ms = body["kill_ms"]
        event = await run_in_threadpool(
            handler.log, run_id=run_id, agent=str(run.get("agent", body.get("agent", "unknown")))[:MAX_LABEL_CHARS],
            agent_mode=run.get("agent_mode", "model"), tool="harness",
            args_summary=f"pid={run.get('pid', body.get('pid'))} {how}"[:80], decision="run_stopped",
            rule="harness", reason=f"exit {body.get('exit_code')} ({how})", latency_ms=0)
        return JSONResponse(event)

    async def demo_reset(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        try:
            await run_in_threadpool(registry.reset)
        except RegistryUnavailable:
            return unavailable()
        handler.clear()
        try:
            await run_in_threadpool(handler.refresh_agents)  # client ids may have changed (re-provisioning)
        except RegistryUnavailable:
            pass  # the map keeps its old entries; a miss looks the client up again
        if settings.mode == "aws":  # a reset is followed by a launch: have the connections ready for the first calls
            threading.Thread(target=warm.warm_connections, args=(handler,), name="reset-warm", daemon=True).start()
        return JSONResponse({"ok": True, "chain": events.reset()})

    async def demo_replay(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        # The gateway never re-runs a recording; the island plays one (press R, or ?replay=/replay/demo.json).
        return JSONResponse({"ok": False, "recording": REPLAY_FILE,
                             "reason": f"the gateway does not replay; open the island with ?replay={REPLAY_FILE}"})

    async def get_stats(request: Request) -> Response:
        stats = summarize(events.all(), events.chain)  # from memory: no AWS call
        stats["last_kill_to_gone_ms"] = handler.last_kill_ms
        return JSONResponse(stats)

    async def healthz(request: Request) -> Response:
        return JSONResponse({"ok": True, "mode": settings.mode, "tools_mode": settings.tools_mode,
                             "token_mode": settings.token_mode})

    async def config_js(request: Request) -> Response:
        # A <script src> from another site is not stopped by CORS; the browser labels it, so refuse it here.
        if request.headers.get("sec-fetch-site") == "cross-site":
            return Response("// refused: cross-site", status_code=403, media_type="application/javascript")
        body = (f"window.MYTOPIA = {{api: \"\", adminToken: {json.dumps(settings.admin_token)}, "
                f"pollMs: 300, staleAfterMs: 3000}};\n")
        return Response(body, media_type="application/javascript", headers={"Cache-Control": "no-store"})

    async def table_html(request: Request) -> Response:
        return FileResponse(GATEWAY_DIR / "table.html", headers={"Cache-Control": "no-store"})

    routes: list[Any] = [
        Route("/mcp", handler.post, methods=["POST"]),
        Route("/mcp", handler.get, methods=["GET"]),
        Route("/mcp", handler.delete, methods=["DELETE"]),
        Route("/events", get_events, methods=["GET"]),
        Route("/agents", get_agents, methods=["GET"]),
        Route("/agents/{agent_id}/status", get_status, methods=["GET"]),
        Route("/agents/{agent_id}/{action}", admin_action, methods=["POST"]),
        Route("/agents/{agent_id}/tools/{tool}/{action}", tool_action, methods=["POST"]),
        Route("/runs/{run_id}/started", run_started, methods=["POST"]),
        Route("/runs/{run_id}/stopped", run_stopped, methods=["POST"]),
        Route("/demo/reset", demo_reset, methods=["POST"]),
        Route("/demo/replay", demo_replay, methods=["POST"]),
        Route("/stats", get_stats, methods=["GET"]),
        Route("/healthz", healthz, methods=["GET"]),
        Route("/config.js", config_js, methods=["GET"]),
        Route("/table.html", table_html, methods=["GET"]),
    ]
    replay_dir = REPO_ROOT / "replay"
    if replay_dir.is_dir():  # recordings only (JSON); lets the island play /replay/demo.json with no second server
        routes.append(Mount("/replay", app=StaticFiles(directory=replay_dir)))
    island = static_dir(settings)
    if island is not None:
        routes.append(Mount("/", app=StaticFiles(directory=island, html=True)))
    else:
        routes.append(Route("/", table_html, methods=["GET"]))
    middleware = [Middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS),
                  Middleware(CORSMiddleware, allow_origin_regex=LOCALHOST_ORIGINS, allow_methods=["*"],
                             allow_headers=["*"], expose_headers=["WWW-Authenticate"])]
    app = Starlette(routes=routes, middleware=middleware, lifespan=lifespan_for(settings, handler, session))
    app.state.handler = handler
    return app


def lifespan_for(settings: Settings, handler: McpHandler, session: Any) -> Any:
    """Startup: in AWS mode, warm up and keep warm on background threads (startup is not blocked).
    Shutdown: give the durable-copy writer up to 5 s to drain its queue."""

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        stop = warm.start(handler, session) if settings.mode == "aws" else None
        yield
        if stop is not None:
            stop.set()
        if not await run_in_threadpool(handler.events.flush, SHUTDOWN_FLUSH_S):
            print("gateway: some events did not reach DynamoDB before shutdown (they are in the JSONL twin)",
                  file=sys.stderr)

    return lifespan


def __getattr__(name: str) -> Starlette:
    """Build `app` from gateway/.env the first time someone asks for it (uvicorn does), so tests never read .env."""
    if name != "app":
        raise AttributeError(name)
    disable_quick_edit()  # the real server only: a click in its console must never freeze the gateway
    app = create_app(Settings.from_env())
    globals()["app"] = app
    return app
