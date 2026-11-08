"""End-to-end test of launcher/run.py and agent/main.py in scripted mode against a tiny fake gateway defined here.
The fake answers the status, run and MCP routes; the test checks the scrubbed child environment, the run_started fields, token rotation through the token file, the scripted calls, and the kill of the process tree on KILLED."""

import contextlib
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from collections.abc import Iterator
from typing import Any

import jwt
import psutil
import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from launcher.run import EMPTY_INI, child_env, rotation_interval  # noqa: E402

SECRET = "test-secret-at-least-32-bytes-long!"
ADMIN = "test-admin"
ALLOWED_CHILD_KEYS = {"MYTOPIA_TOKEN", "MYTOPIA_TOKEN_FILE", "AGENT_POLL_WITH_MODEL", "AGENT_PATROL", "AGENT_NAME",
                      "RUN_ID", "AGENT_ID", "AGENT_MODE",
                      "GATEWAY_URL", "TASK_FILE", "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_MODEL_ID", "AWS_REGION",
                      "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "PYTHONIOENCODING", "PYTHONUNBUFFERED",
                      "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT"}
TOOLS = [{"name": n, "description": n, "inputSchema": {"type": "object", "properties": {}}}
         for n in ("read_file", "search_files", "create_issue", "list_issues")]


def make_fake_gateway(state: dict[str, Any]) -> Starlette:
    """A fake gateway: status, run start/stop, and a minimal JSON-RPC /mcp that allows the badge tools."""

    async def status(request: Request) -> Response:
        if request.headers.get("x-admin-token") != ADMIN:
            return JSONResponse({"error": "admin"}, status_code=401)
        return JSONResponse({"agent": request.path_params["agent"], "status": state["status"]})

    async def run_event(request: Request) -> Response:
        if request.headers.get("x-admin-token") != ADMIN:
            return JSONResponse({"error": "admin"}, status_code=401)
        body = await request.json()
        state[request.path_params["what"]] = {"run_id": request.path_params["run_id"], **body}
        return JSONResponse({"ok": True})

    async def mcp(request: Request) -> Response:
        if request.method == "GET":
            return Response(status_code=405)
        if request.method == "DELETE":
            return Response(status_code=204)
        msg = await request.json()
        auth = request.headers.get("authorization", "")
        try:
            jwt.decode(auth.removeprefix("Bearer "), SECRET, algorithms=["HS256"], issuer="local-issuer")
        except jwt.PyJWTError as e:
            return JSONResponse({"jsonrpc": "2.0", "id": msg.get("id"),
                                 "error": {"code": -32001, "message": f"invalid_token: {e}"}}, status_code=401)
        method = msg.get("method", "")
        if method.startswith("notifications/"):
            return Response(status_code=202)
        if method == "initialize":
            result: dict = {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-11-25"),
                            "capabilities": {"tools": {}}, "serverInfo": {"name": "mytopia", "version": "0.1"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            name = msg["params"]["name"]
            state["calls"].append(name)
            state["tokens"].append(auth.removeprefix("Bearer "))
            if name in {t["name"] for t in TOOLS}:
                result = {"content": [{"type": "text", "text": f"ok {name}"}], "isError": False}
            else:
                text = f"DENIED: {name} is not on badge research-bot [rule: allow-list]"
                result = {"content": [{"type": "text", "text": text}], "isError": True}
        else:
            return JSONResponse({"jsonrpc": "2.0", "id": msg.get("id"),
                                 "error": {"code": -32601, "message": "Method not found"}})
        return JSONResponse({"jsonrpc": "2.0", "id": msg.get("id"), "result": result})

    return Starlette(routes=[
        Route("/agents/{agent}/status", status),
        Route("/runs/{run_id}/{what}", run_event, methods=["POST"]),
        Route("/mcp", mcp, methods=["GET", "POST", "DELETE"]),
    ])


def free_port() -> int:
    """A free TCP port on 127.0.0.1 (never 8787)."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(check: Any, timeout: float) -> bool:
    """Poll check() until it is true or the timeout passes."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.1)
    return False


def test_child_env_is_scrubbed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The child environment carries only the allowed variables, never AWS keys or profiles."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAFAKE")
    monkeypatch.setenv("AWS_PROFILE", "ws")
    monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::1:role/x")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "fake")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "fake")
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "x")
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://x")
    env = child_env("tok", "run-0001", "research-bot", "scripted", "http://127.0.0.1:1", "t.json", {},
                    token_file="C:/x/.token-run-0001", poll_with_model=True)
    for bad in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_ROLE_ARN",
                "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI"):
        assert bad not in env
    assert set(env) <= ALLOWED_CHILD_KEYS, set(env) - ALLOWED_CHILD_KEYS
    assert env["AWS_CONFIG_FILE"] == str(EMPTY_INI) == env["AWS_SHARED_CREDENTIALS_FILE"]
    assert env["MYTOPIA_TOKEN"] == "tok" and env["AGENT_MODE"] == "scripted"
    assert env["MYTOPIA_TOKEN_FILE"] == "C:/x/.token-run-0001" and env["AGENT_POLL_WITH_MODEL"] == "1"
    plain = child_env("tok", "run-0001", "research-bot", "model", "http://127.0.0.1:1", "t.json", {})
    assert "AGENT_POLL_WITH_MODEL" not in plain and "MYTOPIA_TOKEN_FILE" not in plain


def test_rotation_interval() -> None:
    """Re-mint every max(30 s, 80% of the TTL), but sooner than the token's expiry when the TTL is short."""
    assert rotation_interval(300) == 240
    assert rotation_interval(35) == 30
    assert rotation_interval(20) == 16
    assert rotation_interval(4) == 3.2


class Harness:
    """What a running launcher + scripted agent + fake gateway look like to a test."""

    def __init__(self, state: dict[str, Any], launcher: subprocess.Popen, out_file: Path) -> None:
        self.state, self.launcher, self.out_file = state, launcher, out_file
        self.child_pids: list[int] = []

    def out(self) -> str:
        """Everything the launcher and the agent printed so far."""
        return self.out_file.read_text(encoding="utf-8")


@contextlib.contextmanager
def harness(tmp_path: Path, ttl: int) -> Iterator[Harness]:
    """Start the fake gateway and the launcher (scripted agent, token life ttl seconds); always clean up."""
    state: dict[str, Any] = {"status": "ACTIVE", "calls": [], "tokens": []}
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(make_fake_gateway(state), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    assert wait_for(lambda: server.started, 10)

    env_file = tmp_path / "agent.env"
    env_lines = [f"LOCAL_ISSUER_SECRET={SECRET}", f"ADMIN_TOKEN={ADMIN}", "TOKEN_MODE=cognito"]
    env_file.write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    out_file = tmp_path / "launcher.out"
    env = dict(__import__("os").environ, AWS_ACCESS_KEY_ID="AKIAFAKE", AWS_PROFILE="ws")
    cmd = [sys.executable, str(ROOT / "launcher" / "run.py"), "--env-file", str(env_file),
           "--gateway-url", f"http://127.0.0.1:{port}", "--token-mode", "local", "--agent", "research-bot",
           "--task", "tasks/q3.json", "--scripted", "--poll-ms", "200", "--token-ttl", str(ttl)]
    with open(out_file, "w", encoding="utf-8") as out:
        launcher = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, env=env, cwd=str(ROOT))
    h = Harness(state, launcher, out_file)
    try:
        assert wait_for(lambda: "started" in state, 20), h.out()
        yield h
    finally:
        for pid in [launcher.pid] + h.child_pids:
            try:
                psutil.Process(pid).kill()
            except psutil.NoSuchProcess:
                pass
        server.should_exit = True
        thread.join(timeout=10)


def test_scripted_run_then_kill(tmp_path: Path) -> None:
    """Launcher + scripted agent: run_started (with client_id and expires_in), the five calls, the first call on the
    first token, KILLED, taskkill of the tree, run_stopped, token file deleted.
    The token lives 20 s (re-mint at 16 s), far longer than the agent takes to start and make its first call, so
    which token the first call carries does not depend on how fast the child process starts."""
    with harness(tmp_path, 20) as h:
        state, launcher = h.state, h.launcher
        started = state["started"]
        assert started["agent"] == "research-bot" and started["agent_mode"] == "scripted"
        assert started["task"] == "Q3 planning" and started["run_id"].startswith("run-")
        assert started["client_id"] == "local-research-bot" and started["expires_in"] == 20
        child = psutil.Process(started["pid"])
        h.child_pids = [child.pid] + [c.pid for c in child.children(recursive=True)]
        child_environ = child.environ()
        assert "AWS_ACCESS_KEY_ID" not in child_environ and "AWS_PROFILE" not in child_environ
        assert Path(child_environ["AWS_CONFIG_FILE"]) == ROOT / "launcher" / "empty.ini"
        # __PYVENV_LAUNCHER__ is added by the venv's python.exe stub itself, not by the launcher.
        assert set(child_environ) <= ALLOWED_CHILD_KEYS | {"__PYVENV_LAUNCHER__"}, set(child_environ) - ALLOWED_CHILD_KEYS
        token_file = Path(child_environ["MYTOPIA_TOKEN_FILE"])
        assert token_file.is_absolute() and token_file.name == f".token-{started['run_id']}"
        assert token_file.exists()
        first_token = token_file.read_text(encoding="utf-8")
        assert first_token == child_environ["MYTOPIA_TOKEN"]

        expected = ["read_file", "search_files", "create_issue", "send_email", "read_file"]
        assert wait_for(lambda: state["calls"][:5] == expected, 30), state["calls"]
        assert state["tokens"][0] == first_token  # the re-mint is 16 s away; the first call is seconds after start
        state["status"] = "KILLED"
        assert launcher.wait(timeout=30) == 0
        stopped = state["stopped"]
        assert stopped["how"] == "killed by harness" and stopped["exit_code"] != 0
        assert stopped["run_id"] == started["run_id"]
        assert not any(psutil.pid_exists(p) and psutil.Process(p).status() != psutil.STATUS_ZOMBIE for p in h.child_pids)
        text = h.out()
        assert "token OK: client local-re..." in text
        assert "ALLOW read_file" in text
        assert "DENY send_email: send_email is not on badge research-bot [rule: allow-list]" in text
        assert "tools/list: 4 tools" in text
        assert "KILLED -> taskkill" in text or "KILLED -> psutil" in text
        assert "invalid_token" not in text and "TOKEN EXPIRED" not in text and "ERROR" not in text
        assert first_token not in text  # never print a whole token
        assert not token_file.exists()


def test_token_rotation_with_short_ttl(tmp_path: Path) -> None:
    """A 4 s token is re-minted at 3.2 s, over and over: the token file is rewritten, the agent's later calls carry
    the new token, and the run stays allowed past the first token's expiry. Which token the first call carries is
    left to the other test, because it depends on how fast the child starts."""
    with harness(tmp_path, 4) as h:
        state, launcher = h.state, h.launcher
        started = state["started"]
        assert started["expires_in"] == 4
        child = psutil.Process(started["pid"])
        h.child_pids = [child.pid] + [c.pid for c in child.children(recursive=True)]
        token_file = Path(child.environ()["MYTOPIA_TOKEN_FILE"])
        first_token = child.environ()["MYTOPIA_TOKEN"]

        assert wait_for(lambda: token_file.exists() and token_file.read_text(encoding="utf-8") != first_token, 15)
        rotated = token_file.read_text(encoding="utf-8")
        assert wait_for(lambda: rotated in state["tokens"], 15), h.out()
        n_calls = len(state["calls"])
        assert wait_for(lambda: len(state["calls"]) >= n_calls + 2, 15)  # still allowed past the first token's expiry
        assert wait_for(lambda: h.out().count("token rotated: client local-re..., expires in 4 s") >= 2, 15), h.out()
        state["status"] = "KILLED"
        assert launcher.wait(timeout=30) == 0
        text = h.out()
        assert "invalid_token" not in text and "TOKEN EXPIRED" not in text and "ERROR" not in text
        assert first_token not in text and rotated not in text  # never print a whole token
        assert not token_file.exists()
