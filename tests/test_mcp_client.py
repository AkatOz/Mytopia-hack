"""Interop tests: the real mcp 2.3.0 client and Strands' MCPClient talking to a live local gateway over HTTP.
The gateway runs under uvicorn on a free port in a background thread; a small ASGI wrapper records which headers the clients send."""

import asyncio
import socket
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
import uvicorn
from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
from strands.tools.mcp import MCPClient

from gateway.app import create_app
from gateway.config import Settings
from gateway.issuer_local import mint_local_token

SECRET = "client-test-secret-at-least-32-bytes"
PLANNING = {"path": "/drive/q3-planning.md"}
EMAIL = {"to": "ceo@example.corp", "subject": "Q3 summary", "body": "two lines"}
DENY_TEXT = "DENIED: send_email is not on badge research-bot [rule: allow-list]"


class HeaderRecorder:
    """ASGI wrapper that remembers (method, headers) of every request to /mcp."""

    def __init__(self, app: Any) -> None:
        self.app = app
        self.seen: list[tuple[str, dict[str, str]]] = []

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "http" and scope["path"] == "/mcp":
            headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
            self.seen.append((scope["method"], headers))
        await self.app(scope, receive, send)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def gateway() -> Any:
    """Start the gateway on a free port; stop it after the module's tests."""
    settings = Settings(admin_token="client-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None)
    app = create_app(settings)
    recorder = HeaderRecorder(app)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(recorder, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    yield {"url": f"http://127.0.0.1:{port}/mcp", "app": app, "recorder": recorder}
    server.should_exit = True
    thread.join(timeout=10)


def headers_for(agent: str = "research-bot", run_id: str = "run-test") -> dict[str, str]:
    token = mint_local_token(agent, f"local-{agent}", SECRET)
    return {"Authorization": "Bearer " + token, "X-Run-Id": run_id}


@asynccontextmanager
async def transport(url: str, headers: dict[str, str]) -> AsyncIterator[Any]:
    """mcp 2.x way to open a streamable HTTP transport with fixed headers (2.x has no streamablehttp_client)."""
    async with create_mcp_http_client(headers=headers) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            yield streams


def text_of(result: Any) -> str:
    return result.content[0].text


def test_pinned_mcp_client(gateway: dict) -> None:
    async def run() -> dict:
        async with transport(gateway["url"], headers_for(run_id="run-mcp")) as (read, write):
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                listed = await session.list_tools()
                allowed = await session.call_tool("read_file", PLANNING)
                denied = await session.call_tool("send_email", EMAIL)
                return {"init": init, "tools": [t.name for t in listed.tools], "allowed": allowed, "denied": denied}

    out = asyncio.run(run())
    assert out["init"].protocol_version == "2025-11-25"
    assert out["init"].server_info.name == "mytopia"
    assert out["tools"] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert out["allowed"].is_error is False
    assert out["denied"].is_error is True and text_of(out["denied"]) == DENY_TEXT
    events = gateway["app"].state.handler.events.since(0)
    mine = [e for e in events if e["run_id"] == "run-mcp"]
    assert [(e["tool"], e["decision"]) for e in mine] == [("tools/list", "allow"), ("read_file", "allow"),
                                                          ("send_email", "deny")]
    report_headers(gateway["recorder"], "mcp ClientSession")


def test_pinned_mcp_client_ops_bot_sees_one_tool(gateway: dict) -> None:
    async def run() -> list[str]:
        async with transport(gateway["url"], headers_for("ops-bot")) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return [t.name for t in (await session.list_tools()).tools]

    assert asyncio.run(run()) == ["read_file"]


def test_strands_mcp_client(gateway: dict) -> None:
    url, headers = gateway["url"], headers_for(run_id="run-strands")
    client = MCPClient(lambda: transport(url, headers))
    with client:
        tools = client.list_tools_sync()
        allowed = client.call_tool_sync("t1", "read_file", PLANNING)
        denied = client.call_tool_sync("t2", "send_email", EMAIL)
    assert sorted(t.tool_name for t in tools) == ["create_issue", "list_issues", "read_file", "search_files"]
    allowed_text = allowed["content"][0]["text"]
    assert allowed["status"] == "success"
    assert "Action item" in allowed_text or allowed_text.startswith("stub: read_file")
    assert denied["status"] == "error" and denied["content"][0]["text"] == DENY_TEXT
    events = gateway["app"].state.handler.events.since(0)
    assert [(e["tool"], e["decision"]) for e in events if e["run_id"] == "run-strands"] == [
        ("tools/list", "allow"), ("read_file", "allow"), ("send_email", "deny")]
    report_headers(gateway["recorder"], "strands MCPClient")


def test_client_without_token_is_refused(gateway: dict) -> None:
    async def run() -> None:
        async with transport(gateway["url"], {"X-Run-Id": "run-anon"}) as (read, write):
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), timeout=10)

    with pytest.raises(BaseException):
        asyncio.run(run())
    denies = [e for e in gateway["app"].state.handler.events.since(0) if e["run_id"] == "run-anon"]
    assert denies and all(e["rule"] == "token" for e in denies)


def report_headers(recorder: HeaderRecorder, label: str) -> None:
    """Print what the client sent (Authorization shortened), visible with pytest -s."""
    for method, headers in recorder.seen[-6:]:
        shown = {k: (v[:19] + "..." if k == "authorization" else v) for k, v in headers.items()
                 if k in ("authorization", "accept", "content-type", "mcp-protocol-version", "mcp-name",
                          "mcp-session-id", "x-run-id", "user-agent")}
        print(f"[{label}] {method} {shown}")
