"""Tests for gateway/mcp.py and the control API in gateway/app.py, driven with Starlette's TestClient in local mode.
They cover the 401s, badge filtering of tools/list, deny texts, the Mcp-Name check, revoke, kill, reset and the hash chain."""

import pytest
from starlette.testclient import TestClient

from gateway.app import create_app
from gateway.config import Settings
from gateway.events import verify_chain
from gateway.issuer_local import mint_local_token

SECRET = "test-secret-at-least-32-bytes-long-ok"
ADMIN = {"X-Admin-Token": "test-admin"}


@pytest.fixture()
def client() -> TestClient:
    settings = Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None)
    return TestClient(create_app(settings))


def bearer(agent: str = "research-bot", ttl_s: int = 300, secret: str = SECRET) -> dict:
    return {"Authorization": "Bearer " + mint_local_token(agent, f"local-{agent}", secret, ttl_s)}


def rpc(client: TestClient, method: str, params: dict | None = None, headers: dict | None = None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return client.post("/mcp", json=body, headers={"X-Run-Id": "run-test", **(headers or {})})


def call(client: TestClient, tool: str, args: dict, headers: dict | None = None) -> dict:
    return rpc(client, "tools/call", {"name": tool, "arguments": args}, headers or bearer()).json()["result"]


def events(client: TestClient) -> list[dict]:
    return client.get("/events?since_seq=0").json()["events"]


def tampered_token() -> str:
    token = mint_local_token("research-bot", "local-research-bot", SECRET)
    head, payload, sig = token.split(".")
    return ".".join([head, payload, ("A" if sig[0] != "A" else "B") + sig[1:]])


@pytest.mark.parametrize("headers, reason", [
    ({}, "missing bearer token"),
    ("expired", "token expired"),
    ("tampered", "signature verification failed"),
    ("wrong-secret", "signature verification failed"),
    ({"Authorization": "Basic abc"}, "malformed authorization header"),
])
def test_bad_tokens_get_401(client: TestClient, headers: object, reason: str) -> None:
    if headers == "expired":
        headers = bearer(ttl_s=-10)
    elif headers == "tampered":
        headers = {"Authorization": "Bearer " + tampered_token()}
    elif headers == "wrong-secret":
        headers = bearer(secret="not-the-secret-but-also-32-bytes-long")
    r = rpc(client, "tools/call", {"name": "read_file", "arguments": {"path": "/drive/okrs.md"}}, headers)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == 'Bearer error="invalid_token"'
    assert r.json()["error"] == {"code": -32001, "message": f"invalid_token: {reason}"}
    last = events(client)[-1]
    assert (last["decision"], last["rule"], last["tool"]) == ("deny", "token", "read_file")


def test_initialize_needs_a_token_and_echoes_version(client: TestClient) -> None:
    assert rpc(client, "initialize", {"protocolVersion": "2025-06-18"}).status_code == 401
    r = rpc(client, "initialize", {"protocolVersion": "2025-06-18"}, bearer())
    assert r.json()["result"]["protocolVersion"] == "2025-06-18"
    assert r.json()["result"]["serverInfo"] == {"name": "mytopia", "version": "0.1"}
    assert rpc(client, "initialize", {}, bearer()).json()["result"]["protocolVersion"] == "2025-11-25"
    assert rpc(client, "notifications/initialized", None, bearer()).status_code == 202
    assert rpc(client, "ping", None, bearer()).json()["result"] == {}
    assert rpc(client, "server/discover", None, bearer()).json()["error"]["code"] == -32601
    assert client.get("/mcp").status_code == 405
    assert client.delete("/mcp").status_code == 204


def test_tools_list_is_filtered_by_badge(client: TestClient) -> None:
    research = rpc(client, "tools/list", None, bearer()).json()["result"]["tools"]
    assert [t["name"] for t in research] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert all("inputSchema" in t for t in research)
    ops = rpc(client, "tools/list", None, bearer("ops-bot")).json()["result"]["tools"]
    assert [t["name"] for t in ops] == ["read_file"]
    first = events(client)[0]
    assert (first["decision"], first["args_summary"], first["run_id"]) == ("allow", "4 of 6 tools visible", "run-test")


def test_allowed_call_runs_the_tool(client: TestClient) -> None:
    result = call(client, "read_file", {"path": "/drive/q3-planning.md"})
    assert result["isError"] is False
    last = events(client)[-1]
    assert (last["decision"], last["reason"]) == ("allow", "read_file is on badge research-bot")
    assert last["args_summary"] == "path=/drive/q3-planning.md"


def test_send_email_denied_with_exact_text(client: TestClient) -> None:
    result = call(client, "send_email", {"to": "ceo@example.corp", "subject": "Q3 summary", "body": "two lines"})
    assert result == {"content": [{"type": "text",
                                   "text": "DENIED: send_email is not on badge research-bot [rule: allow-list]"}],
                      "isError": True}
    last = events(client)[-1]
    assert last["args_summary"] == "to=ceo@example.corp subject=Q3 summary body=9 chars"
    assert (last["decision"], last["rule"], last["ms_since_revoke"]) == ("deny", "allow-list", None)


def test_mcp_name_mismatch(client: TestClient) -> None:
    result = call(client, "read_file", {"path": "/drive/okrs.md"}, {**bearer(), "Mcp-Name": "send_email"})
    assert result["isError"] is True
    assert result["content"][0]["text"].endswith("[rule: header-mismatch]")
    assert events(client)[-1]["rule"] == "header-mismatch"
    assert call(client, "read_file", {"path": "/drive/okrs.md"}, {**bearer(), "Mcp-Name": "read_file"})["isError"] is False


def test_admin_routes_need_the_admin_token(client: TestClient) -> None:
    assert client.post("/agents/research-bot/revoke").status_code == 401
    assert client.post("/agents/research-bot/revoke", headers={"X-Admin-Token": "nope"}).status_code == 401
    assert client.post("/demo/reset").status_code == 401
    assert client.post("/agents/nobody/revoke", headers=ADMIN).status_code == 404


def test_revoke_then_deny_with_ms_since_revoke(client: TestClient) -> None:
    token = bearer()
    assert call(client, "read_file", {"path": "/drive/okrs.md"}, token)["isError"] is False
    r = client.post("/agents/research-bot/revoke", headers=ADMIN)
    assert r.json()["status"] == "REVOKED" and isinstance(r.json()["seq"], int)
    result = call(client, "read_file", {"path": "/drive/okrs.md"}, token)
    text = result["content"][0]["text"]
    assert result["isError"] and "badge REVOKED at" in text and "by operator (token: signature OK, expires in" in text
    assert text.endswith("[rule: status-revoked]")
    first_deny, = [e for e in events(client) if e["decision"] == "deny"]
    assert isinstance(first_deny["ms_since_revoke"], int) and first_deny["ms_since_revoke"] >= 0
    call(client, "read_file", {"path": "/drive/okrs.md"}, token)
    assert events(client)[-1]["ms_since_revoke"] is None  # only the first deny carries it
    assert rpc(client, "tools/list", None, token).json()["result"]["tools"] == []
    assert "(token: signature OK, expires in" in events(client)[-1]["reason"]
    assert client.get("/agents/research-bot/status", headers=token).json() == {"agent": "research-bot",
                                                                               "status": "REVOKED"}
    assert client.post("/agents/research-bot/restore", headers=ADMIN).json()["status"] == "ACTIVE"
    assert call(client, "read_file", {"path": "/drive/okrs.md"}, token)["isError"] is False


def test_kill_then_tools_list_empty_and_logged(client: TestClient) -> None:
    assert client.post("/agents/research-bot/kill", headers=ADMIN).json()["status"] == "KILLED"
    assert rpc(client, "tools/list", None, bearer()).json()["result"]["tools"] == []
    kill, deny = events(client)[-2:]
    assert (kill["decision"], kill["tool"], kill["reason"]) == ("kill_requested", "admin", "status KILLED by operator")
    assert deny["reason"] == "badge KILLED by operator; everything refused"
    assert (deny["decision"], deny["tool"], deny["rule"]) == ("deny", "tools/list", "status-killed")
    assert client.get("/agents/research-bot/status", headers=ADMIN).json()["status"] == "KILLED"


def test_runs_and_reset_start_a_new_chain(client: TestClient) -> None:
    started = client.post("/runs/run-7f3a/started", headers=ADMIN,
                          json={"agent": "research-bot", "task": "Q3 planning", "agent_mode": "model", "pid": 4120})
    assert started.json()["decision"] == "run_started"
    assert started.json()["args_summary"] == "task=Q3 planning pid=4120"
    assert started.json()["reason"] == "token OK: client local-re scope mytopia/tools expires in 300 s"
    with_client = client.post("/runs/run-0001/started", headers=ADMIN, json={
        "agent": "ops-bot", "task": "disk check", "pid": 1, "client_id": "8b22d0aa99", "expires_in": 287})
    assert with_client.json()["reason"] == "token OK: client 8b22d0aa scope mytopia/tools expires in 287 s"
    stopped = client.post("/runs/run-7f3a/stopped", headers=ADMIN, json={"exit_code": 1, "how": "killed by harness"})
    assert stopped.json()["reason"] == "exit 1 (killed by harness)"
    assert stopped.json()["args_summary"] == "pid=4120 killed by harness"
    client.post("/agents/ops-bot/revoke", headers=ADMIN)
    before = client.get("/events").json()
    assert verify_chain(before["events"]) and len(before["events"]) == 4

    reset = client.post("/demo/reset", headers=ADMIN).json()
    assert reset["ok"] is True and reset["chain"] != before["chain"]
    after = client.get("/events?since_seq=0").json()
    assert after["events"] == [] and after["chain"] == reset["chain"]
    assert all(a["status"] == "ACTIVE" for a in client.get("/agents").json())
    assert call(client, "read_file", {"path": "/drive/okrs.md"}, bearer("ops-bot"))["isError"] is False
    new = client.get("/events").json()["events"]
    assert new[0]["seq"] == 1 and new[0]["prev_hash"] == "genesis" and verify_chain(new)


def test_island_facing_routes(client: TestClient) -> None:
    agents = client.get("/agents").json()
    assert [a["agent"] for a in agents] == ["research-bot", "ops-bot"]
    assert set(agents[0]) == {"agent", "name", "client_id", "status", "allowed_tools", "color"}
    assert client.get("/healthz").json() == {"ok": True, "mode": "local", "tools_mode": "local",
                                             "token_mode": "local"}
    js = client.get("/config.js").text
    assert js.startswith('window.MYTOPIA = {api: "", adminToken: "test-admin", pollMs: 1000, staleAfterMs: 3000};')
    assert "X-Admin-Token" in client.get("/table.html").text
    cors = client.get("/events", headers={"Origin": "http://localhost:5173"})
    assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in client.get("/events", headers={"Origin": "http://evil.example"}).headers
    assert client.get("/.env").status_code == 404


def test_aws_mode_without_aws_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: object) -> None:
    monkeypatch.setenv("AWS_PROFILE", "mytopia-test-no-such-profile")
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "none.ini"))  # type: ignore[operator]
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "none.ini"))  # type: ignore[operator]
    settings = Settings(mode="aws", tools_mode="lambda", admin_token="test-admin", demo_pace=0.0,
                        local_issuer_secret=SECRET, events_jsonl=None)
    aws = TestClient(create_app(settings))
    result = call(aws, "read_file", {"path": "/drive/okrs.md"})
    assert result["isError"] and result["content"][0]["text"].endswith("[rule: registry-unavailable]")
    assert rpc(aws, "tools/list", None, bearer()).json()["result"]["tools"] == []
    assert events(aws)[-1]["rule"] == "registry-unavailable"
    assert aws.get("/agents").status_code == 503
    assert aws.post("/agents/research-bot/revoke", headers=ADMIN).status_code == 503


def test_lambda_tools_without_aws_return_is_error() -> None:
    from gateway.tools import LambdaTools
    result = LambdaTools("mytopia-tools", None).invoke("read_file", {"path": "/drive/okrs.md"})
    assert result["isError"] is True and result["content"][0]["text"].startswith("tool error:")
