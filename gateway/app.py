"""The gateway's Starlette app: POST /mcp, the control API the island and the launcher use, /config.js and the static face.
create_app(settings) builds it; the module-level `app` (for `python -m uvicorn gateway.app:app`) is built from gateway/.env on first access."""

import hmac
import json
import sys
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from gateway.config import GATEWAY_DIR, REPO_ROOT, Settings
from gateway.events import DynamoEventLog, MemoryEventLog
from gateway.mcp import McpHandler
from gateway.registry import KNOWN_AGENTS, DynamoRegistry, MemoryRegistry, RegistryUnavailable, now_iso
from gateway.tokens import CognitoVerifier, LocalVerifier, TokenError
from gateway.tools import LambdaTools, LocalTools

LOCALHOST_ORIGINS = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"
ADMIN_ACTIONS = {"revoke": ("REVOKED", "revoked", "badge REVOKED by operator"),
                 "restore": ("ACTIVE", "restored", "badge ACTIVE again"),
                 "kill": ("KILLED", "kill_requested", "status KILLED by operator")}
AGENT_KEYS = ("agent", "name", "client_id", "status", "allowed_tools", "color")


def aws_session(settings: Settings) -> Any:
    """A boto3 session on the gateway's narrow profile, or None (every AWS part then fails closed)."""
    try:
        import os

        import boto3  # imported here so local mode never needs AWS settings
        # naming the profile explicitly makes botocore skip AWS_ACCESS_KEY_ID & co. in the environment,
        # so stray broad credentials can never stand in for the narrow gateway role
        return boto3.Session(profile_name=os.environ.get("AWS_PROFILE") or None, region_name=settings.aws_region)
    except Exception as exc:  # noqa: BLE001
        print(f"gateway: no AWS session ({type(exc).__name__}); AWS parts will fail closed", file=sys.stderr)
        return None


def build_handler(settings: Settings) -> McpHandler:
    """Pick registry, event log, token verifier and tool runner from the three mode switches."""
    needs_aws = settings.mode == "aws" or settings.tools_mode == "lambda"
    session = aws_session(settings) if needs_aws else None
    if settings.mode == "aws":
        registry: Any = DynamoRegistry(settings.table_agents, session)
        events: MemoryEventLog = DynamoEventLog(settings.table_events, session, settings.events_jsonl)
    else:
        registry = MemoryRegistry()
        events = MemoryEventLog(settings.events_jsonl)
    if settings.token_mode == "cognito":
        verifier: Any = CognitoVerifier(settings.cognito_pool_id, settings.aws_region, settings.cognito_scope, registry)
    else:
        verifier = LocalVerifier(settings.local_issuer_secret, registry, settings.cognito_scope)
    tools: Any = LambdaTools(settings.tools_function, session) if settings.tools_mode == "lambda" else LocalTools()
    return McpHandler(settings, registry, events, verifier, tools)


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
    handler = build_handler(settings)
    registry, events = handler.registry, handler.events

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
        if not is_admin(request):
            try:
                token = await run_in_threadpool(handler.verifier.verify, request.headers.get("authorization"))
            except (TokenError, RegistryUnavailable):
                return unauthorized()
            if token.agent_id != agent:
                return JSONResponse({"error": "a token may only read its own badge"}, status_code=403)
        try:
            row = await run_in_threadpool(registry.get, agent)
        except RegistryUnavailable:
            return unavailable()
        if row is None:
            return JSONResponse({"error": f"unknown agent {agent}"}, status_code=404)
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

    async def run_started(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        run_id, body = request.path_params["run_id"], await read_json(request)
        agent = str(body.get("agent", ""))
        if agent not in KNOWN_AGENTS:
            return JSONResponse({"error": f"unknown agent {agent}"}, status_code=400)
        run = {"agent": agent, "agent_mode": body.get("agent_mode", "model"), "pid": body.get("pid"),
               "task": body.get("task", "")}
        handler.runs[run_id] = run
        client = str(body.get("client_id") or "")[:8]
        if not client:  # the launcher may omit client_id; fall back to the badge row
            try:
                row = await run_in_threadpool(registry.get, agent)
                client = str((row or {}).get("client_id", "?"))[:8]
            except RegistryUnavailable:
                client = "?"
        expires_in = int(body.get("expires_in") or 300)
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
        event = await run_in_threadpool(
            handler.log, run_id=run_id, agent=run.get("agent", body.get("agent", "unknown")),
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
        return JSONResponse({"ok": True, "chain": events.reset()})

    async def demo_replay(request: Request) -> Response:
        if not is_admin(request):
            return unauthorized()
        return JSONResponse({"ok": False, "error": "replay is phase 5, not built yet"}, status_code=501)

    async def healthz(request: Request) -> Response:
        return JSONResponse({"ok": True, "mode": settings.mode, "tools_mode": settings.tools_mode,
                             "token_mode": settings.token_mode})

    async def config_js(request: Request) -> Response:
        body = (f"window.MYTOPIA = {{api: \"\", adminToken: {json.dumps(settings.admin_token)}, "
                f"pollMs: 1000, staleAfterMs: 3000}};\n")
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
        Route("/runs/{run_id}/started", run_started, methods=["POST"]),
        Route("/runs/{run_id}/stopped", run_stopped, methods=["POST"]),
        Route("/demo/reset", demo_reset, methods=["POST"]),
        Route("/demo/replay", demo_replay, methods=["POST"]),
        Route("/healthz", healthz, methods=["GET"]),
        Route("/config.js", config_js, methods=["GET"]),
        Route("/table.html", table_html, methods=["GET"]),
    ]
    island = static_dir(settings)
    if island is not None:
        routes.append(Mount("/", app=StaticFiles(directory=island, html=True)))
    else:
        routes.append(Route("/", table_html, methods=["GET"]))
    middleware = [Middleware(CORSMiddleware, allow_origin_regex=LOCALHOST_ORIGINS, allow_methods=["*"],
                             allow_headers=["*"], expose_headers=["WWW-Authenticate"])]
    app = Starlette(routes=routes, middleware=middleware)
    app.state.handler = handler
    return app


def __getattr__(name: str) -> Starlette:
    """Build `app` from gateway/.env the first time someone asks for it (uvicorn does), so tests never read .env."""
    if name != "app":
        raise AttributeError(name)
    app = create_app(Settings.from_env())
    globals()["app"] = app
    return app
