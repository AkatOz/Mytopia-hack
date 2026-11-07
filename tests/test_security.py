"""Regression tests for the fixes in docs/SECURITY_REVIEW.md: the tools/list sentinel, body cap, Host check,
cross-site config.js, forged-token labels, caller-text truncation, token edge cases and ordered JSONL writes."""

import threading
import time
from pathlib import Path

import jwt
import pytest
from starlette.testclient import TestClient

from gateway.app import create_app
from gateway.config import Settings
from gateway.events import MemoryEventLog, verify_chain
from gateway.issuer_local import mint_local_token
from gateway.mcp import MAX_BODY_BYTES

SECRET = "test-secret-at-least-32-bytes-long-ok"
ADMIN = {"X-Admin-Token": "test-admin"}


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app(Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET)))


def bearer(token: str | None = None) -> dict:
    return {"Authorization": "Bearer " + (token or mint_local_token("research-bot", "local-research-bot", SECRET))}


def call(client: TestClient, name: str, args: dict, headers: dict) -> dict:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}
    return client.post("/mcp", json=body, headers=headers).json()


def events(client: TestClient) -> list[dict]:
    return client.get("/events?since_seq=0").json()["events"]


def claims(**over: object) -> dict:
    now = int(time.time())
    base = {"sub": "local-research-bot", "client_id": "local-research-bot", "token_use": "access",
            "scope": "mytopia/tools", "iss": "local-issuer", "iat": now, "exp": now + 60}
    base.update(over)
    return {k: v for k, v in base.items() if v is not None}


def test_tools_call_named_tools_list_is_denied(client: TestClient) -> None:
    result = call(client, "tools/list", {}, bearer())["result"]
    assert result["isError"] and result["content"][0]["text"].startswith("DENIED:")
    last = events(client)[-1]
    assert (last["decision"], last["rule"]) == ("deny", "allow-list")


def test_oversized_body_is_refused_before_auth_and_not_logged(client: TestClient) -> None:
    r = client.post("/mcp", content=b"{" + b" " * (MAX_BODY_BYTES + 1) + b"}", headers=bearer())
    assert r.status_code == 413
    assert events(client) == []


def test_foreign_host_header_is_refused(client: TestClient) -> None:
    assert client.get("/config.js", headers={"Host": "rebind.attacker.example"}).status_code == 400
    assert client.get("/config.js", headers={"Host": "127.0.0.1:8787"}).status_code == 200


def test_config_js_refuses_cross_site_script_include(client: TestClient) -> None:
    assert client.get("/config.js", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/config.js", headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200


def test_forged_token_does_not_stop_the_revoke_clock(client: TestClient) -> None:
    client.post("/agents/research-bot/revoke", headers=ADMIN)
    forged = jwt.encode(claims(), "not-the-secret-but-also-32-bytes-long", algorithm="HS256")
    assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                       headers=bearer(forged)).status_code == 401
    assert events(client)[-1]["ms_since_revoke"] is None
    call(client, "read_file", {"path": "/drive/okrs.md"}, bearer())
    assert isinstance(events(client)[-1]["ms_since_revoke"], int)


def test_caller_text_is_cut_before_the_log(client: TestClient) -> None:
    headers = {**bearer(), "X-Run-Id": "r" * 5000, "Mcp-Name": "n" * 5000}
    call(client, "read_file", {"path": "/drive/okrs.md"}, headers)
    last = events(client)[-1]
    assert last["rule"] == "header-mismatch" and len(last["run_id"]) == 64 and len(last["reason"]) < 200


@pytest.mark.parametrize("token", [
    jwt.encode(claims(), None, algorithm="none"),
    jwt.encode(claims(iss=None), SECRET, algorithm="HS256"),
    jwt.encode(claims(exp=None), SECRET, algorithm="HS256"),
    jwt.encode(claims(nbf=int(time.time()) + 600, exp=int(time.time()) + 900), SECRET, algorithm="HS256"),
    jwt.encode(claims(scope="mytopia/toolsX"), SECRET, algorithm="HS256"),
    jwt.encode(claims(token_use="id"), SECRET, algorithm="HS256"),
    jwt.encode(claims(iat=int(time.time()) + 600, exp=int(time.time()) + 900), SECRET, algorithm="HS256"),
    jwt.encode(claims(sub="local-ops-bot"), SECRET, algorithm="HS256"),
    jwt.encode(claims(sub="not-on-any-badge", client_id="not-on-any-badge"), SECRET, algorithm="HS256"),
])
def test_token_edge_cases_get_401(client: TestClient, token: str) -> None:
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=bearer(token))
    assert r.status_code == 401


def test_concurrent_appends_resume_after_restart(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    log = MemoryEventLog(path)
    threads = [threading.Thread(target=lambda: [log.append(decision="allow") for _ in range(25)]) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    again = MemoryEventLog(path)
    assert again.chain == log.chain and len(again.all()) == 200 and verify_chain(again.all())
