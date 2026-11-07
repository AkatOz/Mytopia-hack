"""End-to-end tests for tools/mock_gateway.py and tools/validate_fixture.py: the mock is started as a real process on port 8788 and stopped at the end.
They cover fixture playback with the real hash chain, cursor polling, the admin buttons, reset, CORS, the static page and POST /mcp allow and deny."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest

REPO = Path(__file__).resolve().parent.parent
PYTHON = sys.executable
BASE = "http://127.0.0.1:8788"
ADMIN = {"X-Admin-Token": "anything"}
FIXTURE_COUNT = len(json.loads((REPO / "contract" / "fixture.json").read_text(encoding="utf-8"))["events"])


@pytest.fixture(scope="module")
def client() -> Iterator[httpx.Client]:
    """Starts the mock on 8788 with a fast pace, yields an HTTP client, then kills the process."""
    proc = subprocess.Popen([PYTHON, str(REPO / "tools" / "mock_gateway.py"), "--port", "8788", "--pace", "0.02"],
                            cwd=str(REPO), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    http = httpx.Client(base_url=BASE, timeout=5)
    try:
        for _ in range(100):
            try:
                if http.get("/healthz").status_code == 200:
                    break
            except httpx.TransportError:
                time.sleep(0.1)
        else:
            pytest.fail("mock gateway did not start on 8788")
        yield http
    finally:
        http.close()
        proc.kill()
        proc.wait(timeout=10)


def all_events(http: httpx.Client) -> list[dict[str, Any]]:
    return http.get("/events", params={"since_seq": 0}).json()["events"]


def reset_and_wait(http: httpx.Client) -> None:
    """Resets the mock and waits until the whole fixture has played."""
    assert http.post("/demo/reset", headers=ADMIN).json()["ok"] is True
    for _ in range(200):
        if len(all_events(http)) >= FIXTURE_COUNT:
            return
        time.sleep(0.05)
    pytest.fail("fixture playback did not finish")


def mcp(http: httpx.Client, method: str, params: dict[str, Any] | None = None,
        agent: str = "research-bot", token: str = "any-token") -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}", "X-Agent-Id": agent, "X-Run-Id": "run-test"}
    return http.post("/mcp", json={"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}},
                     headers=headers)


def call_text(http: httpx.Client, name: str, arguments: dict[str, Any], agent: str = "research-bot") -> tuple[str, bool]:
    result = mcp(http, "tools/call", {"name": name, "arguments": arguments}, agent).json()["result"]
    return result["content"][0]["text"], result["isError"]


def test_playback_rehashes_the_fixture(client: httpx.Client, tmp_path: Path) -> None:
    reset_and_wait(client)
    events = all_events(client)
    assert [e["seq"] for e in events] == list(range(1, FIXTURE_COUNT + 1))
    assert events[0]["prev_hash"] == "genesis"
    assert events[5]["decision"] == "deny" and events[5]["tool"] == "send_email"
    dump = tmp_path / "events.json"
    dump.write_text(json.dumps({"events": events}), encoding="utf-8")
    checked = subprocess.run([PYTHON, str(REPO / "tools" / "validate_fixture.py"), str(dump), "--strict"],
                             capture_output=True, text=True)
    assert checked.returncode == 0, checked.stderr
    statuses = {row["agent"]: row["status"] for row in client.get("/agents").json()}
    assert statuses == {"research-bot": "ACTIVE", "ops-bot": "ACTIVE"}


def test_cursor_polling(client: httpx.Client) -> None:
    reset_and_wait(client)
    body = client.get("/events", params={"since_seq": 10}).json()
    assert [e["seq"] for e in body["events"]] == list(range(11, FIXTURE_COUNT + 1))
    assert body["server_ts"].endswith("Z")
    assert client.get("/events", params={"since_seq": FIXTURE_COUNT}).json()["events"] == []
    assert client.get("/events", params={"since_seq": "x"}).status_code == 400


def test_buttons_and_mcp_after_revoke_and_kill(client: httpx.Client) -> None:
    reset_and_wait(client)
    answer = client.post("/agents/research-bot/revoke", headers=ADMIN).json()
    assert answer == {"status": "REVOKED", "seq": FIXTURE_COUNT + 1}
    last = all_events(client)[-1]
    assert (last["decision"], last["tool"], last["rule"], last["reason"]) == (
        "revoked", "admin", "admin", "badge REVOKED by operator")
    assert client.get("/agents/research-bot/status").json()["status"] == "REVOKED"

    text, is_error = call_text(client, "read_file", {"path": "/drive/q3-planning.md"})
    assert is_error and text.startswith("DENIED: badge REVOKED at ") and text.endswith("[rule: status-revoked]")
    first_deny = all_events(client)[-1]
    assert isinstance(first_deny["ms_since_revoke"], int)
    call_text(client, "read_file", {"path": "/drive/q3-planning.md"})
    assert all_events(client)[-1]["ms_since_revoke"] is None
    assert mcp(client, "tools/list").json()["result"]["tools"] == []

    assert client.post("/agents/research-bot/restore", headers=ADMIN).json()["status"] == "ACTIVE"
    assert all_events(client)[-1]["reason"] == "badge ACTIVE again"
    kill = client.post("/agents/research-bot/kill", headers=ADMIN).json()
    assert kill["status"] == "KILLED" and all_events(client)[-1]["decision"] == "kill_requested"
    text, is_error = call_text(client, "read_file", {"path": "/x"})
    assert is_error and text.endswith("[rule: status-killed]")
    statuses = {row["agent"]: row["status"] for row in client.get("/agents").json()}
    assert statuses == {"research-bot": "KILLED", "ops-bot": "ACTIVE"}
    assert client.post("/agents/nobody/revoke", headers=ADMIN).status_code == 404


def test_reset_starts_a_new_chain(client: httpx.Client) -> None:
    reset_and_wait(client)
    client.post("/agents/ops-bot/kill", headers=ADMIN)
    before = all_events(client)
    chain = client.post("/demo/reset", headers=ADMIN).json()["chain"]
    assert chain.startswith("chain-")
    after = all_events(client)
    while not after:
        time.sleep(0.02)
        after = all_events(client)
    assert len(after) < len(before) and after[0]["seq"] == 1 and after[0]["prev_hash"] == "genesis"
    statuses = {row["agent"]: row["status"] for row in client.get("/agents").json()}
    assert statuses == {"research-bot": "ACTIVE", "ops-bot": "ACTIVE"}


def test_mcp_allow_and_deny(client: httpx.Client) -> None:
    reset_and_wait(client)
    init = mcp(client, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18" and init["serverInfo"]["name"] == "mytopia"
    assert mcp(client, "notifications/initialized").status_code == 202
    names = [t["name"] for t in mcp(client, "tools/list").json()["result"]["tools"]]
    assert names == ["read_file", "search_files", "create_issue", "list_issues"]
    assert [t["name"] for t in mcp(client, "tools/list", agent="ops-bot").json()["result"]["tools"]] == ["read_file"]

    text, is_error = call_text(client, "read_file", {"path": "/drive/q3-planning.md"})
    assert not is_error and "q3-planning" in text
    allowed = all_events(client)[-1]
    assert (allowed["decision"], allowed["tool"], allowed["run_id"]) == ("allow", "read_file", "run-test")

    text, is_error = call_text(client, "send_email", {"to": "ceo@example.corp", "subject": "Q3", "body": "hi"})
    assert is_error and text == "DENIED: send_email is not on badge research-bot [rule: allow-list]"
    assert all_events(client)[-1]["args_summary"] == "to=ceo@example.corp subject=Q3 body=2 chars"
    text, _ = call_text(client, "create_issue", {"title": "t", "body": "b"}, agent="ops-bot")
    assert text == "DENIED: create_issue is not on badge ops-bot [rule: allow-list]"

    unauth = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert unauth.status_code == 401 and unauth.headers["www-authenticate"] == 'Bearer error="invalid_token"'
    assert unauth.json()["error"]["code"] == -32001
    assert mcp(client, "nope").json()["error"]["code"] == -32601
    assert client.get("/mcp").status_code == 405


def test_cors_config_health_and_static(client: httpx.Client) -> None:
    ok = client.get("/agents", headers={"Origin": "http://localhost:5173"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    evil = client.get("/agents", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in evil.headers
    preflight = client.options("/agents/research-bot/revoke", headers={
        "Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-admin-token"})
    assert preflight.status_code == 200
    assert client.get("/config.js").text.startswith('window.MYTOPIA = {api: "", adminToken: ')
    assert client.get("/healthz").json()["ok"] is True
    home = client.get("/")
    assert home.status_code == 200 and "text/html" in home.headers["content-type"]
    assert client.get("/%2e%2e/requirements.txt").status_code == 404
    assert client.get("/..%2f..%2frequirements.txt").status_code == 404


def test_mcp_bad_input_never_breaks_the_log(client: httpx.Client, tmp_path: Path) -> None:
    reset_and_wait(client)
    headers = {"Authorization": "bearer any", "X-Run-Id": "run-bad", "Content-Type": "application/json"}
    assert client.post("/mcp", content=b"[]", headers=headers).status_code == 400
    bad_args = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "read_file", "arguments": ["x"]}}
    assert client.post("/mcp", json=bad_args, headers=headers).json()["error"]["code"] == -32602
    for params in ({"name": "rm_rf", "arguments": {}}, {"arguments": {}}, []):
        body = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": params}
        assert client.post("/mcp", json=body, headers=headers).json()["result"]["isError"] is True
    assert client.post("/runs/run-empty/started").status_code == 200
    client.post("/runs/run-s/started", json={"agent": "research-bot", "task": "t", "agent_mode": "scripted", "pid": 1})
    call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_file", "arguments": {"path": "/x"}}}
    client.post("/mcp", json=call, headers={**headers, "X-Run-Id": "run-s", "X-Agent-Id": "research-bot"})
    events = all_events(client)
    assert events[-1]["agent_mode"] == "scripted"
    dump = tmp_path / "events.json"
    dump.write_text(json.dumps({"events": events}), encoding="utf-8")
    checked = subprocess.run([PYTHON, str(REPO / "tools" / "validate_fixture.py"), str(dump), "--strict"],
                             capture_output=True, text=True)
    assert checked.returncode == 0, checked.stderr
