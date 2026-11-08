"""Tests for the per-tool revoke and restore routes, the per-tool ms_since_revoke clock, auto-quarantine and --rogue.
The gateway runs in local mode through Starlette's TestClient; the DynamoDB path uses a small in-memory fake of the low-level client."""

import re
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from gateway import app as app_module
from gateway.app import create_app
from gateway.config import Settings
from gateway.events import verify_chain
from gateway.issuer_local import mint_local_token
from gateway.registry import DynamoRegistry, RegistryUnavailable, seed_rows

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "agent"))
from validate_fixture import check_events, load_events  # type: ignore[import-not-found]  # noqa: E402

SECRET = "test-secret-at-least-32-bytes-long-ok"
ADMIN = {"X-Admin-Token": "test-admin"}
READ = {"path": "/drive/okrs.md"}
EMAIL = {"to": "ceo@example.corp", "subject": "Q3 summary", "body": "two lines"}
ISSUE = {"title": "t", "body": "b"}


def make_client(**overrides: Any) -> TestClient:
    settings = Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None,
                        **overrides)
    return TestClient(create_app(settings))


def bearer(agent: str = "research-bot") -> dict:
    return {"Authorization": "Bearer " + mint_local_token(agent, f"local-{agent}", SECRET)}


def rpc(client: TestClient, method: str, params: dict | None = None, headers: dict | None = None) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return client.post("/mcp", json=body, headers={"X-Run-Id": "run-test", **(headers or bearer())})


def call(client: TestClient, tool: str, args: dict, headers: dict | None = None) -> dict:
    return rpc(client, "tools/call", {"name": tool, "arguments": args}, headers).json()["result"]


def listed(client: TestClient, agent: str = "research-bot") -> list[str]:
    return [t["name"] for t in rpc(client, "tools/list", None, bearer(agent)).json()["result"]["tools"]]


def events(client: TestClient) -> list[dict]:
    return client.get("/events?since_seq=0").json()["events"]


def badge(client: TestClient, agent: str = "research-bot") -> dict:
    return next(a for a in client.get("/agents").json() if a["agent"] == agent)


# ----- a stateful fake of the low-level DynamoDB client, so the routes can run on DynamoRegistry -----
class StatefulDynamo:
    """get_item / update_item on two rows kept in DynamoDB's typed format; honours SET, attribute_exists and the
    quarantine's "#status = :expect" condition."""

    def __init__(self) -> None:
        from boto3.dynamodb.types import TypeSerializer

        to_dynamo = TypeSerializer().serialize
        self.items = {agent: {k: to_dynamo(v) for k, v in row.items()} for agent, row in seed_rows().items()}
        self.updates: list[dict] = []

    def get_item(self, TableName: str, Key: dict, ConsistentRead: bool) -> dict:  # noqa: N803 - boto3's names
        assert ConsistentRead is True
        item = self.items.get(Key["agent"]["S"])
        return {"Item": dict(item)} if item else {}

    def update_item(self, **kwargs: Any) -> dict:
        self.updates.append(kwargs)
        item = self.items[kwargs["Key"]["agent"]["S"]]  # a missing row would be a ConditionalCheckFailed
        names, values = kwargs["ExpressionAttributeNames"], kwargs["ExpressionAttributeValues"]
        if kwargs["ConditionExpression"] == "attribute_exists(#agent) AND #status = :expect":
            if item["status"] != values[":expect"]:
                raise RuntimeError("ConditionalCheckFailedException")
        else:
            assert kwargs["ConditionExpression"] == "attribute_exists(#agent)"
        for assignment in kwargs["UpdateExpression"].removeprefix("SET ").split(", "):
            name, value = assignment.split(" = ")
            item[names[name]] = values[value]
        return {"Attributes": dict(item)}

    def scan(self, TableName: str, ConsistentRead: bool, **kwargs: Any) -> dict:  # noqa: N803
        assert ConsistentRead is True
        return {"Items": [dict(item) for item in self.items.values()]}

    def put_item(self, TableName: str, Item: dict, ConditionExpression: str,  # noqa: N803
                 ExpressionAttributeNames: dict) -> dict:
        assert (ConditionExpression, ExpressionAttributeNames) == ("attribute_not_exists(#agent)", {"#agent": "agent"})
        if Item["agent"]["S"] in self.items:
            raise RuntimeError("ConditionalCheckFailedException")
        self.items[Item["agent"]["S"]] = dict(Item)
        return {}

    def delete_item(self, TableName: str, Key: dict) -> dict:  # noqa: N803
        self.items.pop(Key["agent"]["S"], None)
        return {}


class StatefulSession:
    def __init__(self, dynamo: StatefulDynamo) -> None:
        self.dynamo = dynamo

    def client(self, name: str, config: Any = None) -> StatefulDynamo:
        return self.dynamo


@pytest.fixture(params=["memory", "dynamo"])
def any_client(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The same local-mode gateway, with the memory registry or with DynamoRegistry on the stateful fake."""
    if request.param == "dynamo":
        dynamo = StatefulDynamo()
        monkeypatch.setattr(app_module, "MemoryRegistry",
                            lambda: DynamoRegistry("mytopia_agents", StatefulSession(dynamo)))
    client = make_client()
    assert type(client.app.state.handler.registry).__name__ == (  # type: ignore[attr-defined]
        "DynamoRegistry" if request.param == "dynamo" else "MemoryRegistry")
    return client


# ----- A: per-tool revoke and restore -----
def test_tool_routes_check_admin_agent_action_and_tool(any_client: TestClient) -> None:
    c = any_client
    assert c.post("/agents/research-bot/tools/create_issue/revoke").status_code == 401
    assert c.post("/agents/research-bot/tools/create_issue/revoke", headers={"X-Admin-Token": "x"}).status_code == 401
    assert c.post("/agents/nobody/tools/create_issue/revoke", headers=ADMIN).status_code == 404
    assert c.post("/agents/research-bot/tools/create_issue/kill", headers=ADMIN).status_code == 404
    bad = c.post("/agents/research-bot/tools/rm_rf/revoke", headers=ADMIN)
    assert bad.status_code == 400 and bad.json() == {"error": "rm_rf is not one of the six tools"}
    # "tools/list" is no tool: its slash means the path no longer matches the route at all
    assert c.post("/agents/research-bot/tools/tools%2Flist/revoke", headers=ADMIN).status_code in (400, 404, 405)
    assert events(c) == []  # nothing logged for a refused admin call


def test_revoke_one_tool_then_restore_it(any_client: TestClient) -> None:
    c = any_client
    assert listed(c) == ["read_file", "search_files", "create_issue", "list_issues"]
    r = c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body == {"status": "ACTIVE", "seq": body["seq"], "agent": "research-bot", "tool": "create_issue",
                    "allowed_tools": ["read_file", "search_files", "list_issues"], "changed": True}
    event = events(c)[-1]
    assert event["seq"] == body["seq"]
    assert (event["decision"], event["tool"], event["rule"], event["agent"]) == (
        "revoked", "create_issue", "admin", "research-bot")
    assert event["args_summary"] == "badge=read_file,search_files,list_issues"
    assert event["reason"] == "create_issue pulled from badge research-bot by operator"
    assert event["ms_since_revoke"] is None and event["latency_ms"] == 0
    # the next call sees it: tools/list, GET /agents, and the call itself
    assert listed(c) == ["read_file", "search_files", "list_issues"]
    assert badge(c)["allowed_tools"] == ["read_file", "search_files", "list_issues"]
    denied = call(c, "create_issue", ISSUE)
    assert denied["isError"] and denied["content"][0]["text"] == (
        "DENIED: create_issue is not on badge research-bot [rule: allow-list]")
    assert call(c, "read_file", READ)["isError"] is False  # the rest of the badge still works
    # idempotent: a second revoke changes and logs nothing
    n = len(events(c))
    again = c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    assert again.status_code == 200 and again.json()["changed"] is False and again.json()["seq"] is None
    assert again.json()["note"] == "create_issue was already off badge research-bot; nothing changed, nothing logged"
    assert len(events(c)) == n
    # restore puts it back in the catalog's order
    back = c.post("/agents/research-bot/tools/create_issue/restore", headers=ADMIN).json()
    assert back["changed"] is True and back["allowed_tools"] == ["read_file", "search_files", "create_issue",
                                                                  "list_issues"]
    restored = events(c)[-1]
    assert (restored["decision"], restored["tool"], restored["rule"]) == ("restored", "create_issue", "admin")
    assert restored["reason"] == "create_issue returned to badge research-bot by operator"
    assert restored["args_summary"] == "badge=read_file,search_files,create_issue,list_issues"
    assert call(c, "create_issue", ISSUE)["isError"] is False
    same = c.post("/agents/research-bot/tools/create_issue/restore", headers=ADMIN).json()
    assert same["changed"] is False and same["note"].startswith("create_issue was already on badge research-bot")
    assert verify_chain(events(c))


def test_whole_badge_revoke_still_logs_tool_admin(any_client: TestClient) -> None:
    any_client.post("/agents/research-bot/revoke", headers=ADMIN)
    event = events(any_client)[-1]
    assert (event["decision"], event["tool"], event["args_summary"]) == ("revoked", "admin", "by=operator")


def test_restore_can_grant_a_tool_and_reset_puts_the_seed_badges_back(any_client: TestClient) -> None:
    c = any_client
    # build 3: ops-bot is Bronze, so it may be granted search_files but not send_email (above its ceiling)
    granted = c.post("/agents/ops-bot/tools/search_files/restore", headers=ADMIN).json()
    assert granted["allowed_tools"] == ["read_file", "search_files"]
    assert events(c)[-1]["reason"] == "search_files added to badge ops-bot by operator"
    assert c.post("/agents/ops-bot/tools/send_email/restore", headers=ADMIN).status_code == 403
    c.post("/agents/research-bot/tools/read_file/revoke", headers=ADMIN)
    assert c.post("/demo/reset", headers=ADMIN).json()["ok"] is True
    assert badge(c, "ops-bot")["allowed_tools"] == ["read_file"]
    assert badge(c)["allowed_tools"] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert call(c, "read_file", READ)["isError"] is False


def test_tool_route_with_the_registry_down_is_503_and_logs_nothing() -> None:
    c = make_client()
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]

    def down(*args: Any) -> None:
        raise RegistryUnavailable("down")

    registry.get = down
    assert c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN).status_code == 503
    assert events(c) == []


# ----- the per-tool ms clock -----
def test_first_allow_list_deny_of_that_tool_carries_ms_since_revoke() -> None:
    c = make_client()
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    call(c, "send_email", EMAIL)  # another tool's deny: no number, and the create_issue clock keeps running
    assert events(c)[-1]["rule"] == "allow-list" and events(c)[-1]["ms_since_revoke"] is None
    call(c, "create_issue", ISSUE)
    first = events(c)[-1]
    assert (first["decision"], first["tool"], first["rule"]) == ("deny", "create_issue", "allow-list")
    assert isinstance(first["ms_since_revoke"], int) and first["ms_since_revoke"] >= 0
    call(c, "create_issue", ISSUE)
    assert events(c)[-1]["ms_since_revoke"] is None  # only the first deny carries it
    assert len(c.get("/stats").json()["revoke_to_first_deny_ms"]) == 1


def test_badge_clock_and_tool_clock_are_separate() -> None:
    c = make_client()
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)  # idempotent, clock unchanged
    c.post("/agents/ops-bot/revoke", headers=ADMIN)  # another agent's whole-badge revoke leaves this clock alone
    call(c, "create_issue", ISSUE)
    assert isinstance(events(c)[-1]["ms_since_revoke"], int)  # the tool clock's first deny
    c.post("/agents/research-bot/tools/list_issues/revoke", headers=ADMIN)
    c.post("/agents/research-bot/revoke", headers=ADMIN)  # a whole-badge revoke drops this agent's tool clocks
    call(c, "list_issues", {})  # a status deny: it takes the badge clock only
    status_deny = events(c)[-1]
    assert status_deny["rule"] == "status-revoked" and isinstance(status_deny["ms_since_revoke"], int)
    c.post("/agents/research-bot/restore", headers=ADMIN)
    call(c, "list_issues", {})  # ACTIVE without list_issues: no number, it would include the whole-badge time
    tool_deny = events(c)[-1]
    assert tool_deny["rule"] == "allow-list" and tool_deny["ms_since_revoke"] is None
    assert len(c.get("/stats").json()["revoke_to_first_deny_ms"]) == 2


def test_restoring_the_tool_stops_its_clock() -> None:
    c = make_client()
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    c.post("/agents/research-bot/tools/create_issue/restore", headers=ADMIN)
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    handler = c.app.state.handler  # type: ignore[attr-defined]
    assert list(handler.tool_revoked_at_ms) == [("research-bot", "create_issue")]
    c.post("/demo/reset", headers=ADMIN)
    assert handler.tool_revoked_at_ms == {}


# ----- the contract checker accepts the new event, and only in its new shape -----
def test_validate_fixture_accepts_per_tool_events_from_a_real_chain() -> None:
    c = make_client()
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    call(c, "create_issue", ISSUE)
    c.post("/agents/research-bot/tools/create_issue/restore", headers=ADMIN)
    c.post("/agents/research-bot/revoke", headers=ADMIN)
    c.post("/agents/research-bot/kill", headers=ADMIN)
    chain = events(c)
    assert [e["tool"] for e in chain] == ["create_issue", "create_issue", "create_issue", "admin", "admin"]
    assert check_events(chain, strict=True) == []
    assert set(chain[0]) == {"seq", "ts", "run_id", "agent", "agent_mode", "tool", "args_summary", "decision",
                             "rule", "reason", "latency_ms", "ms_since_revoke", "prev_hash", "hash"}  # no new field


def test_validate_fixture_still_refuses_wrong_admin_events() -> None:
    c = make_client()
    c.post("/agents/research-bot/kill", headers=ADMIN)
    c.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN)
    kill, revoke = events(c)
    assert check_events([{**kill, "tool": "send_email"}], strict=False) == [
        "seq 1: kill_requested needs tool admin and rule admin"]
    assert check_events([{**revoke, "seq": 1, "prev_hash": "genesis", "tool": "tools/list"}], strict=False) == [
        "seq 1: revoked needs tool admin or one of the six tools and rule admin"]
    assert check_events([{**revoke, "seq": 1, "prev_hash": "genesis", "rule": "allow-list"}], strict=False) == [
        "seq 1: revoked needs tool admin or one of the six tools and rule admin"]
    assert check_events(load_events(ROOT / "contract" / "fixture.json"), strict=False) == []


# ----- B: auto-quarantine -----
def refuse(c: TestClient, times: int, tool: str = "send_email") -> None:
    for _ in range(times):
        result = call(c, tool, EMAIL if tool == "send_email" else READ)
        assert result["isError"] and result["content"][0]["text"].endswith("[rule: allow-list]")


def revokes(c: TestClient) -> list[dict]:
    return [e for e in events(c) if e["decision"] == "revoked"]


def anysecs(text: str) -> str:
    """A quarantine text with its seconds written as N ("... 3 refused calls in N s"): how long three refusals take
    depends on how busy the machine is, so a test must never expect 0 s."""
    return re.sub(r"in \d+ s$", "in N s", text)


def test_quarantine_fires_at_the_threshold_and_not_below() -> None:
    c = make_client()
    refuse(c, 2)
    assert revokes(c) == [] and badge(c)["status"] == "ACTIVE"
    refuse(c, 1)  # the third refusal: the agent still gets its own deny (checked in refuse)
    deny, quarantine = events(c)[-2:]
    assert (deny["decision"], deny["rule"], deny["tool"]) == ("deny", "allow-list", "send_email")
    assert (quarantine["decision"], quarantine["tool"], quarantine["rule"]) == ("revoked", "admin", "admin")
    assert anysecs(quarantine["args_summary"]) == "quarantine: 3 refused calls in N s"
    assert anysecs(quarantine["reason"]) == "badge pulled by quarantine after 3 refused calls in N s"
    assert quarantine["run_id"] == "run-test" and quarantine["ms_since_revoke"] is None
    assert badge(c)["status"] == "REVOKED"
    # the next call is refused for status-revoked, by quarantine; a quarantine starts no revoke clock (the gap
    # would be the agent's own pacing), so it carries no ms_since_revoke and /stats gets no number
    text = call(c, "read_file", READ)["content"][0]["text"]
    assert "by quarantine (token: signature OK" in text and text.endswith("[rule: status-revoked]")
    assert events(c)[-1]["ms_since_revoke"] is None
    assert c.get("/stats").json()["revoke_to_first_deny_ms"] == []
    for _ in range(4):  # status denies never count: no second quarantine
        call(c, "send_email", EMAIL)
    assert len(revokes(c)) == 1
    assert check_events(events(c), strict=True) == []
    # RESTORE brings the agent back exactly as today
    assert c.post("/agents/research-bot/restore", headers=ADMIN).json()["status"] == "ACTIVE"
    assert call(c, "read_file", READ)["isError"] is False


def test_quarantine_keeps_one_badge_read_per_call() -> None:
    c = make_client()
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]
    reads = {"get": 0}
    original = registry.get

    def counted(agent: str) -> Any:
        reads["get"] += 1
        return original(agent)

    registry.get = counted
    refuse(c, 3)
    assert reads["get"] == 3 and revokes(c)  # the quarantine is one write, never an extra read


def test_status_token_and_gatehouse_denies_never_count() -> None:
    c = make_client()
    c.post("/agents/research-bot/revoke", headers=ADMIN)
    for _ in range(4):
        call(c, "send_email", EMAIL)  # status-revoked
    c.post("/agents/research-bot/restore", headers=ADMIN)
    bad = {"Authorization": "Bearer " + mint_local_token("research-bot", "local-research-bot", "wrong-secret-32-bytes-long-xxxxx")}
    for _ in range(4):
        assert rpc(c, "tools/call", {"name": "send_email", "arguments": EMAIL}, bad).status_code == 401
    for _ in range(4):
        call(c, "not_a_tool", {})  # logged as a gatehouse (tools/list) deny
        call(c, "read_file", READ, {**bearer(), "Mcp-Name": "send_email"})  # header-mismatch
    assert [e["args_summary"] for e in revokes(c)] == ["by=operator"]
    assert c.app.state.handler.refusals == {}  # type: ignore[attr-defined]


def test_restore_and_reset_clear_the_count() -> None:
    c = make_client()
    refuse(c, 2)
    c.post("/agents/research-bot/restore", headers=ADMIN)
    refuse(c, 2)
    assert revokes(c) == []
    c.post("/demo/reset", headers=ADMIN)
    refuse(c, 2)
    assert revokes(c) == []
    refuse(c, 1)
    assert [anysecs(e["args_summary"]) for e in revokes(c)] == ["quarantine: 3 refused calls in N s"]


def test_the_count_is_per_agent() -> None:
    c = make_client()
    refuse(c, 2)
    call(c, "send_email", EMAIL, bearer("ops-bot"))
    call(c, "send_email", EMAIL, bearer("ops-bot"))
    assert revokes(c) == []


def test_only_refusals_inside_the_window_count(monkeypatch: pytest.MonkeyPatch) -> None:
    handler = make_client().app.state.handler  # type: ignore[attr-defined]
    clock = {"now": 1000.0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["now"])

    def at(t: float) -> Any:
        clock["now"] = 1000.0 + t
        return handler.count_refusal("research-bot")

    assert at(0) is None and at(30) is None
    assert at(61) is None                 # the refusal at 0 s has left the 60 s window: two in it
    assert at(62) == (3, 32.0)            # 30, 61, 62: three inside 60 s, 32 s from first to last
    assert at(63) is None                 # the count was cleared when it tripped


def test_quarantine_after_zero_turns_it_off_and_settings_read_the_env(monkeypatch: pytest.MonkeyPatch,
                                                                        tmp_path: Path) -> None:
    c = make_client(quarantine_after=0)
    refuse(c, 6)
    assert revokes(c) == []
    monkeypatch.setenv("QUARANTINE_AFTER", "5")
    monkeypatch.setenv("QUARANTINE_WINDOW_S", "12.5")
    settings = Settings.from_env(tmp_path / "missing.env")
    assert (settings.quarantine_after, settings.quarantine_window_s) == (5, 12.5)
    monkeypatch.delenv("QUARANTINE_AFTER")
    monkeypatch.delenv("QUARANTINE_WINDOW_S")
    defaults = Settings.from_env(tmp_path / "missing.env")
    assert (defaults.quarantine_after, defaults.quarantine_window_s) == (3, 60.0)


def test_quarantine_with_the_registry_down_still_returns_the_deny() -> None:
    c = make_client()
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]

    def down(*args: Any) -> None:
        raise RegistryUnavailable("down")

    registry.set_status = down
    refuse(c, 3)  # every deny still reaches the agent
    assert revokes(c) == []


def test_the_standard_demo_never_quarantines() -> None:
    """One send_email refusal, allowed polls, a manual revoke, refused polls, restore, more polls."""
    c = make_client()
    rpc(c, "tools/list")
    call(c, "read_file", {"path": "/drive/q3-planning.md"})
    call(c, "search_files", {"query": "action items"})
    call(c, "create_issue", ISSUE)
    refuse(c, 1)
    for _ in range(10):
        assert call(c, "read_file", READ)["isError"] is False
    c.post("/agents/research-bot/revoke", headers=ADMIN)
    for _ in range(10):
        call(c, "read_file", READ)
    c.post("/agents/research-bot/restore", headers=ADMIN)
    refuse(c, 2)  # even two more refusals after a restore stay under the threshold
    assert [e["args_summary"] for e in revokes(c)] == ["by=operator"]


def test_quarantine_never_overwrites_a_kill(any_client: TestClient) -> None:
    """An operator KILL landing between the third refusal's badge read and the quarantine write wins."""
    c = any_client
    refuse(c, 2)
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]
    original = registry.get

    def read_then_kill(agent: str) -> Any:
        row = original(agent)  # the call's one read still sees ACTIVE, so it is an allow-list deny
        registry.set_status(agent, "KILLED", "operator")
        return row

    registry.get = read_then_kill
    refuse(c, 1)  # the agent still gets its deny
    registry.get = original
    assert badge(c)["status"] == "KILLED"
    assert revokes(c) == []  # no quarantine event: the conditional write was refused


def test_quarantine_never_overwrites_an_operator_revoke() -> None:
    c = make_client()
    refuse(c, 2)
    c.app.state.handler.registry.set_status("research-bot", "REVOKED", "operator")  # type: ignore[attr-defined]
    with pytest.raises(RegistryUnavailable):
        c.app.state.handler.registry.set_status(  # type: ignore[attr-defined]
            "research-bot", "REVOKED", "quarantine", "ACTIVE")
    assert c.app.state.handler.registry.get("research-bot")["revoked_by"] == "operator"  # type: ignore[attr-defined]


def test_refusals_of_a_pulled_tool_never_count() -> None:
    c = make_client()
    handler = c.app.state.handler  # type: ignore[attr-defined]
    c.post("/agents/research-bot/tools/read_file/revoke", headers=ADMIN)
    refuse(c, 5, "read_file")  # the agent's poll, refused five times: the operator already acted on it
    assert [e for e in revokes(c) if e["tool"] == "admin"] == [] and handler.refusals == {}
    assert badge(c)["status"] == "ACTIVE"
    refuse(c, 2)  # two send_email refusals count
    c.post("/agents/research-bot/tools/read_file/restore", headers=ADMIN)  # and a per-tool restore clears them
    assert handler.refusals == {} and handler.pulled == set()
    refuse(c, 2)
    assert [e for e in revokes(c) if e["tool"] == "admin"] == []
    refuse(c, 1)
    whole = [anysecs(e["args_summary"]) for e in revokes(c) if e["tool"] == "admin"]
    assert whole == ["quarantine: 3 refused calls in N s"]


def test_a_quarantine_after_a_per_tool_revoke_does_not_loop() -> None:
    """read_file pulled, then 3 send_email refusals quarantine; after RESTORE the refused polls never re-quarantine."""
    c = make_client()
    c.post("/agents/research-bot/tools/read_file/revoke", headers=ADMIN)
    refuse(c, 3)
    assert badge(c)["status"] == "REVOKED"
    c.post("/agents/research-bot/restore", headers=ADMIN)
    refuse(c, 6, "read_file")  # still off the badge: refused, but never counted
    assert badge(c)["status"] == "ACTIVE"
    whole = [anysecs(e["args_summary"]) for e in revokes(c) if e["tool"] == "admin"]
    assert whole == ["quarantine: 3 refused calls in N s"]
    c.post("/demo/reset", headers=ADMIN)
    assert c.app.state.handler.pulled == set()  # type: ignore[attr-defined]


def test_a_new_run_starts_with_a_clean_count() -> None:
    c = make_client()
    for run in ("run-a", "run-b", "run-c"):  # one refused email per run, no restore in between
        assert c.post(f"/runs/{run}/started", json={"agent": "research-bot"}, headers=ADMIN).status_code == 200
        refuse(c, 1)
    assert revokes(c) == [] and badge(c)["status"] == "ACTIVE"
    c.post("/runs/run-d/started", json={"agent": "ops-bot"}, headers=ADMIN)  # another agent's run: count kept
    refuse(c, 2)
    assert [anysecs(e["args_summary"]) for e in revokes(c)] == ["quarantine: 3 refused calls in N s"]


def test_concurrent_per_tool_changes_both_land(any_client: TestClient) -> None:
    from concurrent.futures import ThreadPoolExecutor

    c = any_client
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]
    original = registry.get

    def slow_get(agent: str) -> Any:
        row = original(agent)
        time.sleep(0.2)  # without the lock, both changes would read the same list and one write would be lost
        return row

    registry.get = slow_get
    with ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(lambda t: c.post(f"/agents/research-bot/tools/{t}/revoke", headers=ADMIN),
                                ["create_issue", "list_issues"]))
    registry.get = original
    assert [r.json()["changed"] for r in replies] == [True, True]
    assert badge(c)["allowed_tools"] == ["read_file", "search_files"]


# ----- C: --rogue in the scripted agent and the launcher -----
class StopPolling(Exception):
    pass


class FakeMcp:
    """Records the tool calls; send_email is refused unless the badge allows it."""

    def __init__(self, email_allowed: bool = False) -> None:
        self.calls: list[str] = []
        self.email_allowed = email_allowed

    def list_tools_sync(self) -> list:
        return []

    def call_tool_sync(self, tool_use_id: str, name: str, arguments: dict) -> dict:
        self.calls.append(name)
        if name == "send_email" and not self.email_allowed:
            return {"status": "success", "content": [{"text": "DENIED: send_email is not on badge research-bot "
                                                               "[rule: allow-list]"}]}
        return {"status": "success", "content": [{"text": "ok"}]}


def scripted(monkeypatch: pytest.MonkeyPatch, rogue: int, email_allowed: bool = False) -> tuple[list[str], list]:
    import main  # type: ignore[import-not-found]

    sleeps: list[float] = []
    monkeypatch.setattr(main.time, "sleep", sleeps.append)

    def stop(client: Any) -> None:
        raise StopPolling

    monkeypatch.setattr(main, "poll_forever", stop)
    fake = FakeMcp(email_allowed)
    with pytest.raises(StopPolling):
        main.run_scripted(fake, rogue)
    return fake.calls, sleeps


def test_rogue_sequence(monkeypatch: pytest.MonkeyPatch) -> None:
    head = ["read_file", "search_files", "create_issue"]
    assert scripted(monkeypatch, 1) == ([*head, "send_email"], [])
    assert scripted(monkeypatch, 3) == ([*head, "send_email", "send_email", "send_email"], [1.0, 1.0])
    assert scripted(monkeypatch, 3, email_allowed=True) == ([*head, "send_email"], [])  # retries only after a refusal


def test_rogue_command_lines() -> None:
    import main  # type: ignore[import-not-found]

    sys.path.insert(0, str(ROOT))
    from launcher.run import agent_command, parse_args

    assert main.parse_args([]).rogue == 1 and main.parse_args(["--rogue", "3"]).rogue == 3
    with pytest.raises(SystemExit):
        main.parse_args(["--rogue", "0"])
    assert parse_args(["--scripted", "--rogue", "3"]).rogue == 3
    with pytest.raises(SystemExit):
        parse_args(["--rogue", "3"])  # model mode decides its own retries
    assert agent_command(3)[-3:] == [str(ROOT / "agent" / "main.py"), "--rogue", "3"]
    assert agent_command(1)[-1] == str(ROOT / "agent" / "main.py")  # the default run is unchanged
