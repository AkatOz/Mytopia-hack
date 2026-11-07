"""Tests for the latency pass: one badge read per call, decision logged before the tool runs, the pace floor, _meta,
GET /stats, the code-quality fixes, the low-level DynamoDB registry, the console guard and the launcher's psutil kill."""

import asyncio
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import jwt
import psutil
import pytest
from starlette.testclient import TestClient

from gateway.app import create_app
from gateway.config import Settings
from gateway.console import ENABLE_EXTENDED_FLAGS, ENABLE_QUICK_EDIT_MODE, disable_quick_edit, quick_edit_off_mode
from gateway.decide import decide
from gateway.issuer_local import mint_local_token
from gateway.registry import DynamoRegistry
from gateway.stats import nearest_rank, summarize

ROOT = Path(__file__).resolve().parent.parent
SECRET = "test-secret-at-least-32-bytes-long-ok"
ADMIN = {"X-Admin-Token": "test-admin"}
READ = {"path": "/drive/okrs.md"}


def make_client(pace: float = 0.0) -> TestClient:
    return TestClient(create_app(Settings(admin_token="test-admin", demo_pace=pace, local_issuer_secret=SECRET)))


def bearer(agent: str = "research-bot", client_id: str | None = None) -> dict:
    return {"Authorization": "Bearer " + mint_local_token(agent, client_id or f"local-{agent}", SECRET)}


def rpc(client: TestClient, method: str, params: dict | None = None, headers: dict | None = None) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return client.post("/mcp", json=body, headers=headers if headers is not None else bearer())


def count_reads(client: TestClient) -> dict:
    """Wrap the registry's read methods with counters (the memory registry stands in for DynamoDB)."""
    registry = client.app.state.handler.registry  # type: ignore[attr-defined]
    counts = {"get": 0, "list_agents": 0}
    for name in counts:
        original = getattr(registry, name)

        def counted(*args: Any, _name: str = name, _original: Any = original) -> Any:
            counts[_name] += 1
            return _original(*args)

        setattr(registry, name, counted)
    return counts


# ----- A: exactly one consistent read per call -----
def test_each_call_reads_the_badge_exactly_once() -> None:
    client = make_client()
    counts = count_reads(client)
    assert rpc(client, "tools/call", {"name": "read_file", "arguments": READ}).json()["result"]["isError"] is False
    assert counts == {"get": 1, "list_agents": 0}
    rpc(client, "tools/call", {"name": "send_email", "arguments": {"to": "x", "subject": "y", "body": "z"}})
    rpc(client, "tools/list", None, bearer("ops-bot"))
    assert counts == {"get": 3, "list_agents": 0}


def test_revoke_is_seen_on_the_very_next_call() -> None:
    client = make_client()
    assert rpc(client, "tools/call", {"name": "read_file", "arguments": READ}).json()["result"]["isError"] is False
    client.post("/agents/research-bot/revoke", headers=ADMIN)
    text = rpc(client, "tools/call", {"name": "read_file", "arguments": READ}).json()["result"]["content"][0]["text"]
    assert text.endswith("[rule: status-revoked]")  # no cache: the fresh row decided


def test_unregistered_client_gets_401_without_any_registry_read() -> None:
    client = make_client()
    counts = count_reads(client)
    r = rpc(client, "tools/call", {"name": "read_file", "arguments": READ}, bearer("research-bot", "not-on-any-badge"))
    assert r.status_code == 401 and r.json()["error"]["message"] == "invalid_token: client is not a registered agent"
    forged = jwt.encode({"sub": "local-research-bot", "client_id": "local-research-bot", "token_use": "access",
                         "scope": "mytopia/tools", "iss": "local-issuer", "iat": int(time.time()),
                         "exp": int(time.time()) + 60}, "not-the-secret-but-also-32-bytes-long", algorithm="HS256")
    assert rpc(client, "tools/list", None, {"Authorization": "Bearer " + forged}).status_code == 401
    assert counts == {"get": 0, "list_agents": 0}
    last = client.get("/events").json()["events"][-1]
    assert (last["rule"], last["agent"]) == ("token", "research-bot")  # labelled from the in-memory map


def test_row_whose_client_id_changed_is_refused_as_a_token_problem() -> None:
    client = make_client()
    registry = client.app.state.handler.registry  # type: ignore[attr-defined]
    registry._rows["research-bot"]["client_id"] = "re-provisioned-client"
    r = rpc(client, "tools/call", {"name": "read_file", "arguments": READ})
    assert r.status_code == 401 and "client is not a registered agent" in r.json()["error"]["message"]
    assert "local-research-bot" not in client.app.state.handler.agent_by_client  # type: ignore[attr-defined]


def test_map_miss_rebuilds_the_whole_map_when_not_seeded() -> None:
    client = make_client()
    handler = client.app.state.handler  # type: ignore[attr-defined]
    handler.agent_by_client.clear()
    handler._last_lookup = float("-inf")  # as if the AWS warm-up has not seeded the map yet
    counts = count_reads(client)
    assert rpc(client, "tools/call", {"name": "read_file", "arguments": READ}).json()["result"]["isError"] is False
    # only before the map is seeded: one rebuild (both rows) plus the badge read
    assert counts == {"get": 3, "list_agents": 1}
    # the OTHER agent, right after and inside the 30 s throttle, is already in the map: no 401, one read
    r = rpc(client, "tools/call", {"name": "read_file", "arguments": READ}, bearer("ops-bot"))
    assert r.status_code == 200 and r.json()["result"]["isError"] is False
    assert counts == {"get": 4, "list_agents": 1}
    assert handler.agent_by_client == {"local-research-bot": "research-bot", "local-ops-bot": "ops-bot"}


def test_failed_map_rebuild_fails_closed_and_is_retried() -> None:
    from gateway.registry import RegistryUnavailable
    client = make_client()
    handler = client.app.state.handler  # type: ignore[attr-defined]
    handler.agent_by_client.clear()
    handler._last_lookup = float("-inf")
    original = handler.registry.list_agents

    def down() -> list:
        raise RegistryUnavailable("outage")

    handler.registry.list_agents = down
    text = rpc(client, "tools/call", {"name": "read_file", "arguments": READ}).json()["result"]["content"][0]["text"]
    assert text.endswith("[rule: registry-unavailable]")  # a deny, never a 401 that would end the agent
    handler.registry.list_agents = original
    assert rpc(client, "tools/call", {"name": "read_file", "arguments": READ}).json()["result"]["isError"] is False


def test_reset_rebuilds_the_client_map() -> None:
    client = make_client()
    handler = client.app.state.handler  # type: ignore[attr-defined]
    handler.agent_by_client.clear()
    assert client.post("/demo/reset", headers=ADMIN).json()["ok"] is True
    assert handler.agent_by_client == {"local-research-bot": "research-bot", "local-ops-bot": "ops-bot"}


def test_status_route_with_a_bearer_token() -> None:
    client = make_client()
    assert client.get("/agents/research-bot/status", headers=bearer()).json()["status"] == "ACTIVE"
    assert client.get("/agents/ops-bot/status", headers=bearer()).status_code == 403
    assert client.get("/agents/research-bot/status", headers=bearer("x", "nobody")).status_code == 403


# ----- C: the allow is logged before the tool runs -----
def test_allow_is_logged_before_the_tool_finishes() -> None:
    client = make_client()
    handler = client.app.state.handler  # type: ignore[attr-defined]
    seen_during_tool: list[list[dict]] = []
    original = handler.tools.invoke

    def slow_tool(name: str, arguments: dict) -> dict:
        seen_during_tool.append(handler.events.all())  # what GET /events would serve right now
        time.sleep(0.3)
        return original(name, arguments)

    handler.tools.invoke = slow_tool
    polled: list[list[dict]] = []
    poller = threading.Thread(target=lambda: (time.sleep(0.15), polled.append(client.get("/events").json()["events"])))
    poller.start()
    rpc(client, "tools/call", {"name": "read_file", "arguments": READ})
    poller.join()
    assert [e["decision"] for e in seen_during_tool[0]] == ["allow"]
    assert [e["decision"] for e in polled[0]] == ["allow"]  # a concurrent GET /events saw it mid-tool


# ----- G: DEMO_PACE is a floor, not an extra sleep -----
def test_demo_pace_is_a_floor_on_the_whole_call() -> None:
    client = make_client(pace=0.4)
    handler = client.app.state.handler  # type: ignore[attr-defined]
    original = handler.tools.invoke
    handler.tools.invoke = lambda name, args: (time.sleep(0.3), original(name, args))[1]
    t0 = time.perf_counter()
    rpc(client, "tools/call", {"name": "read_file", "arguments": READ})
    elapsed = time.perf_counter() - t0
    assert 0.39 <= elapsed < 0.6  # pace 0.4 s with a 0.3 s tool: about 0.4 s, not 0.7 s


# ----- H: the gateway's time reaches the agent through the pinned mcp client and Strands -----
def test_meta_reaches_the_mcp_client_and_strands() -> None:
    import uvicorn
    from mcp import ClientSession
    from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
    from strands.tools.mcp import MCPClient

    sys.path.insert(0, str(ROOT / "agent"))
    from main import result_line  # type: ignore[import-not-found]

    app = create_app(Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET))
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    url, headers = f"http://127.0.0.1:{port}/mcp", bearer()

    async def via_mcp() -> Any:
        async with create_mcp_http_client(headers=headers) as http:
            async with streamable_http_client(url, http_client=http) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    return await session.call_tool("read_file", READ)

    try:
        raw = asyncio.run(via_mcp())
        assert set(raw.meta) == {"mytopia/latency_ms", "mytopia/seq"}
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def transport() -> Any:
            async with create_mcp_http_client(headers=headers) as http:
                async with streamable_http_client(url, http_client=http) as streams:
                    yield streams

        with MCPClient(transport) as client:
            result = client.call_tool_sync("t1", "read_file", READ)
        ms = result["metadata"]["mytopia/latency_ms"]
        assert result_line("read_file", result) == f"ALLOW read_file (gateway {ms} ms)"
        assert result_line("read_file", {"status": "success", "content": [{"text": "x"}]}) == "ALLOW read_file"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def test_agent_poll_cadence() -> None:
    from main import MIN_GAP_S, POLL_S, next_wait  # type: ignore[import-not-found]
    assert next_wait(10.0, 12.0) == pytest.approx(POLL_S - 2.0)  # a 2 s call (the pace) waits 1 s: 3 s cadence
    assert next_wait(10.0, 15.0) == MIN_GAP_S                   # a slow call still gets a short pause


# ----- I: GET /stats -----
def test_stats_route_matches_the_chain() -> None:
    client = make_client()
    for _ in range(3):
        rpc(client, "tools/call", {"name": "read_file", "arguments": READ})
    rpc(client, "tools/call", {"name": "send_email", "arguments": {"to": "a", "subject": "b", "body": "c"}})
    client.post("/agents/research-bot/revoke", headers=ADMIN)
    rpc(client, "tools/call", {"name": "read_file", "arguments": READ})
    client.post("/runs/run-1/started", headers=ADMIN, json={"agent": "research-bot", "pid": 1})
    client.post("/agents/research-bot/kill", headers=ADMIN)
    client.post("/runs/run-1/stopped", headers=ADMIN, json={"exit_code": 1, "how": "killed by harness", "kill_ms": 31})
    stats = client.get("/stats").json()
    chain = client.get("/events").json()
    assert stats["chain"] == chain["chain"] and stats["length"] == len(chain["events"])
    assert stats["latency_ms"]["allow"]["count"] == 3 and stats["latency_ms"]["deny"]["count"] == 2
    assert stats["latency_ms"]["all"]["count"] == 5 and stats["blocked"] == 2
    assert len(stats["revoke_to_first_deny_ms"]) == 1
    assert isinstance(stats["last_kill_to_stopped_ms"], int) and stats["last_kill_to_gone_ms"] == 31


def test_nearest_rank_and_summary() -> None:
    assert nearest_rank([], 50) is None
    assert nearest_rank([5, 1, 3, 2, 4], 50) == 3 and nearest_rank(list(range(1, 101)), 95) == 95
    records = [{"decision": "kill_requested", "run_id": "r", "ts": "2026-11-07T21:40:58.372Z"},
               {"decision": "run_stopped", "run_id": "r", "ts": "2026-11-07T21:40:59.646Z"}]
    assert summarize(records, "c")["kill_to_stopped_ms"] == [1274]


# ----- J: the code-quality fixes -----
def test_run_started_with_a_bad_expires_in_is_400() -> None:
    client = make_client()
    r = client.post("/runs/run-1/started", headers=ADMIN, json={"agent": "research-bot", "expires_in": "soon"})
    assert r.status_code == 400 and client.get("/events").json()["events"] == []


def test_run_fields_from_the_body_are_stored_as_strings() -> None:
    client = make_client()
    started = client.post("/runs/run-1/started", headers=ADMIN, json={"agent": "research-bot", "agent_mode": 1.5})
    assert started.json()["agent_mode"] == "1.5"  # a float would be refused by DynamoDB's serializer
    stopped = client.post("/runs/run-2/stopped", headers=ADMIN, json={"agent": 2.5, "exit_code": 0})
    assert stopped.json()["agent"] == "2.5"


def test_demo_replay_points_at_the_recording() -> None:
    client = make_client()
    assert client.post("/demo/replay").status_code == 401
    body = client.post("/demo/replay", headers=ADMIN).json()
    assert body["recording"] == "/replay/demo.json" and body["ok"] is False
    assert client.get("/replay/demo.json").status_code == 200


def test_aws_mode_without_a_profile_refuses_to_start(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    with pytest.raises(RuntimeError, match="AWS_PROFILE"):
        create_app(Settings(mode="aws", admin_token="test-admin", local_issuer_secret=SECRET))


def test_concurrent_denies_claim_the_revoke_clock_once() -> None:
    client = make_client()
    handler = client.app.state.handler  # type: ignore[attr-defined]
    handler.revoked_at_ms["research-bot"] = int(time.time() * 1000)
    errors: list[BaseException] = []

    def deny() -> None:
        try:
            handler.log(agent="research-bot", decision="deny", rule="status-revoked", tool="read_file")
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=deny) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sum(e["ms_since_revoke"] is not None for e in handler.events.all()) == 1


def test_unknown_status_fails_closed_under_status_revoked() -> None:
    d = decide({"agent": "x", "status": "SUSPENDED", "allowed_tools": ["read_file"]}, "read_file")
    assert (d.ok, d.rule, d.reason) == (False, "status-revoked", "badge status SUSPENDED is not ACTIVE")


def test_latency_script_pages_until_empty() -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    import io
    import json

    from latency import fetch_all  # type: ignore[import-not-found]

    pages = {0: [{"seq": i} for i in range(1, 201)], 200: [{"seq": 201}], 201: []}

    def opener(url: str, timeout: int) -> Any:
        since = int(url.rsplit("=", 1)[1])
        return io.BytesIO(json.dumps({"events": pages[since], "chain": "c"}).encode())

    data = fetch_all("http://x/events", opener)
    assert len(data["events"]) == 201 and data["chain"] == "c"


# ----- E: the low-level DynamoDB registry -----
class FakeDynamo:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.item = {"agent": {"S": "research-bot"}, "client_id": {"S": "abc"}, "status": {"S": "ACTIVE"},
                     "allowed_tools": {"L": [{"S": "read_file"}]}, "revoked_at": {"NULL": True}}

    def get_item(self, **kwargs: Any) -> dict:
        self.calls.append(("get_item", kwargs))
        return {"Item": self.item}

    def update_item(self, **kwargs: Any) -> dict:
        self.calls.append(("update_item", kwargs))
        return {"Attributes": self.item}


class FakeSession:
    def __init__(self, dynamo: FakeDynamo) -> None:
        self.dynamo = dynamo

    def client(self, name: str, config: Any = None) -> FakeDynamo:
        assert config.connect_timeout == 1 and config.read_timeout == 2 and config.tcp_keepalive is True
        assert config.retries == {"mode": "standard", "total_max_attempts": 2}
        return self.dynamo


def test_dynamo_registry_uses_a_consistent_get_item_and_aliased_update() -> None:
    dynamo = FakeDynamo()
    registry = DynamoRegistry("mytopia_agents", FakeSession(dynamo))
    row = registry.get("research-bot")
    assert row == {"agent": "research-bot", "client_id": "abc", "status": "ACTIVE", "allowed_tools": ["read_file"],
                   "revoked_at": None}
    name, kwargs = dynamo.calls[0]
    assert kwargs == {"TableName": "mytopia_agents", "Key": {"agent": {"S": "research-bot"}}, "ConsistentRead": True}
    registry.set_status("research-bot", "REVOKED", "operator")
    _, update = dynamo.calls[1]
    assert update["ConditionExpression"] == "attribute_exists(#agent)"
    assert update["ExpressionAttributeNames"]["#status"] == "status"
    assert update["ExpressionAttributeValues"][":status"] == {"S": "REVOKED"}
    assert update["ExpressionAttributeValues"][":revoked_by"] == {"S": "operator"}


# ----- D: warm-up and keep-warm -----
class Recorder:
    """A stand-in for the handler, its parts and the boto3 session that records which warm-up steps ran."""

    def __init__(self) -> None:
        self.done: list[str] = []
        self.verifier = self.tools = self.registry = self
        self.agent_by_client: dict[str, str] = {}

    def warm(self) -> None:
        self.done.append("warm")

    def refresh_agents(self) -> None:
        self.done.append("refresh_agents")
        self.agent_by_client = {"local-research-bot": "research-bot"}

    def get(self, agent: str) -> None:
        self.done.append(f"get {agent}")

    def get_credentials(self) -> "Recorder":
        return self

    def get_frozen_credentials(self) -> None:
        self.done.append("credentials")


def test_warm_up_runs_every_step_and_keep_warm_repeats(monkeypatch: pytest.MonkeyPatch) -> None:
    from gateway import warm
    fake = Recorder()
    warm.warm_up(fake, fake)
    assert fake.done == ["refresh_agents", "credentials", "warm", "warm"]  # rows first, then credentials, JWKS, Lambda
    fake.done.clear()
    monkeypatch.setattr(warm, "KEEP_WARM_S", 0.01)
    monkeypatch.setattr(warm, "LAMBDA_PING_S", 0.0)
    stop = threading.Event()
    thread = threading.Thread(target=warm.keep_warm, args=(fake, fake, stop))
    thread.start()
    time.sleep(0.1)
    stop.set()
    thread.join(timeout=2)
    assert "credentials" in fake.done and "get research-bot" in fake.done and "warm" in fake.done
    assert warm.step("broken", lambda: 1 / 0) == "broken FAILED (ZeroDivisionError)"


def test_keep_warm_rebuilds_a_map_the_warm_up_could_not_fill(monkeypatch: pytest.MonkeyPatch) -> None:
    from gateway import warm
    fake = Recorder()  # agent_by_client is empty: as if the warm-up's registry step failed
    monkeypatch.setattr(warm, "KEEP_WARM_S", 0.01)
    stop = threading.Event()
    thread = threading.Thread(target=warm.keep_warm, args=(fake, fake, stop))
    thread.start()
    time.sleep(0.1)
    stop.set()
    thread.join(timeout=2)
    assert fake.done.count("refresh_agents") == 1  # rebuilt once; later ticks see a filled map and do one get
    assert "get research-bot" in fake.done


def test_credentials_are_refreshed_before_botocore_would_do_it_on_a_request() -> None:
    from datetime import datetime, timedelta, timezone

    from botocore.credentials import RefreshableCredentials

    from gateway import warm
    calls: list[int] = []

    def fetch(minutes: int) -> dict:
        expiry = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
        return {"access_key": "AKIDTEST", "secret_key": "s", "token": "t", "expiry_time": expiry}

    def refresh() -> dict:
        calls.append(1)
        return fetch(60)

    creds = RefreshableCredentials.create_from_metadata(fetch(16), refresh, "test")  # 16 min left
    session = type("S", (), {"get_credentials": lambda self: creds})()
    assert not creds.refresh_needed()  # botocore itself would not refresh yet (its window opens at 15 min)
    warm.refresh_credentials(session)
    assert calls == [1]  # the keep-warm thread did it early, so no request thread ever runs credential_process
    warm.refresh_credentials(session)
    assert calls == [1]  # fresh credentials: nothing to do


# ----- B: the JWKS warm-up fills the per-kid cache, which outlives the key-set cache -----
def test_cognito_warm_fills_the_signing_key_cache() -> None:
    from cryptography.hazmat.primitives.asymmetric import rsa

    from gateway.tokens import JWKS_TIMEOUT_S, CognitoVerifier
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = {**jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key(), as_dict=True),
           "kid": "k1", "use": "sig", "alg": "RS256"}
    verifier = CognitoVerifier("us-east-1_pool", "us-east-1", "mytopia/tools")
    assert verifier._jwks.timeout == JWKS_TIMEOUT_S == 2
    fetches: list[int] = []
    verifier._jwks.fetch_data = lambda: (fetches.append(1), {"keys": [jwk]})[1]
    verifier.warm()
    assert fetches == [1]
    verifier._jwks.jwk_set_cache.put(None)  # the 5 min key-set cache has expired, as before a demo

    def offline() -> dict:
        raise AssertionError("a request fetched the JWKS")

    verifier._jwks.fetch_data = offline
    now = int(time.time())
    token = jwt.encode({"sub": "c1", "client_id": "c1", "token_use": "access", "scope": "mytopia/tools",
                        "iss": verifier.issuer, "iat": now, "exp": now + 60}, private, algorithm="RS256",
                       headers={"kid": "k1"})
    assert verifier.verify("Bearer " + token).client_id == "c1"


# ----- K: the console guard is import-safe and keeps the extended-flags bit -----
def test_quick_edit_mode_bits_and_no_console() -> None:
    mode = quick_edit_off_mode(0x01F7)
    assert not mode & ENABLE_QUICK_EDIT_MODE and mode & ENABLE_EXTENDED_FLAGS


@pytest.mark.skipif(sys.platform != "win32", reason="the Windows console API")
def test_disable_quick_edit_uses_a_fake_console(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never calls the real SetConsoleMode: running the tests must not change the developer's own terminal."""
    import ctypes

    class FakeKernel32:
        def __init__(self, is_console: bool) -> None:
            self.is_console, self.set_to = is_console, None

        def GetStdHandle(self, which: int) -> int:  # noqa: N802 - the Win32 name
            return 7

        def GetConsoleMode(self, handle: int, ref: Any) -> int:  # noqa: N802
            ref._obj.value = 0x01F7
            return 1 if self.is_console else 0

        def SetConsoleMode(self, handle: int, mode: int) -> int:  # noqa: N802
            self.set_to = mode
            return 1

    console = FakeKernel32(is_console=True)
    monkeypatch.setattr(ctypes, "windll", type("W", (), {"kernel32": console})())
    assert disable_quick_edit() is True and console.set_to == quick_edit_off_mode(0x01F7)
    pipe = FakeKernel32(is_console=False)
    monkeypatch.setattr(ctypes, "windll", type("W", (), {"kernel32": pipe})())
    assert disable_quick_edit() is False and pipe.set_to is None


# ----- F: the launcher kills with psutil first -----
def test_kill_tree_uses_psutil_on_a_real_process_tree() -> None:
    sys.path.insert(0, str(ROOT))
    from launcher.run import kill_tree

    grandchild = "import time; time.sleep(60)"
    child = f"import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {grandchild!r}]); time.sleep(60)"
    python = getattr(sys, "_base_executable", sys.executable)  # not the venv stub, which adds a process of its own
    proc = subprocess.Popen([python, "-c", child])
    parent = psutil.Process(proc.pid)
    deadline = time.monotonic() + 10
    while not parent.children(recursive=True) and time.monotonic() < deadline:
        time.sleep(0.05)
    tree = [proc.pid] + [c.pid for c in parent.children(recursive=True)]
    assert len(tree) == 2
    t0 = time.perf_counter()
    assert kill_tree(proc.pid) == "psutil"
    assert time.perf_counter() - t0 < 2.0
    proc.wait(timeout=5)
    assert not any(psutil.pid_exists(p) and psutil.Process(p).status() != psutil.STATUS_ZOMBIE for p in tree)


def test_access_denied_falls_through_to_the_second_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    sys.path.insert(0, str(ROOT))
    import launcher.run as run

    class Denied:
        def __init__(self, pid: int) -> None:
            raise psutil.AccessDenied(pid)

    second_pass: list[list[str]] = []
    monkeypatch.setattr(psutil, "Process", Denied)
    monkeypatch.setattr(run.os, "killpg", lambda *a: second_pass.append(["killpg"]), raising=False)
    monkeypatch.setattr(run.subprocess, "run", lambda cmd, **kw: second_pass.append(cmd))
    assert run.kill_with_psutil(1234) is False  # no exception escapes the kill
    assert run.kill_tree(1234).startswith("psutil+") and second_pass  # taskkill (or killpg) still ran


class FakeProc:
    def __init__(self, running: bool) -> None:
        self.running, self.pid = running, 4321

    def poll(self) -> int | None:
        return None if self.running else 1


def test_a_slow_kill_is_not_killed_again_or_relabelled(monkeypatch: pytest.MonkeyPatch) -> None:
    sys.path.insert(0, str(ROOT))
    import launcher.run as run

    stops: list[int] = []
    monkeypatch.setattr(run, "stop_child", lambda proc: stops.append(proc.pid) or "psutil")
    still_exiting = FakeProc(running=True)  # stop_child hit its 15 s timeout: the process is still going
    assert run.stop_if_unowned(still_exiting, "killed by harness") == "killed by harness" and stops == []
    assert run.stop_if_unowned(still_exiting, "launcher interrupted") == "launcher interrupted" and stops == []
    assert run.stop_if_unowned(FakeProc(running=False), "exited") == "exited" and stops == []
    assert run.stop_if_unowned(still_exiting, "exited") == "launcher error" and stops == [4321]  # no kill yet: kill now
