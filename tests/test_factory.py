"""Tests for build 3's Factory: tiers on badges, the grant path and its ceiling, mint, promote/demote, retire, the reset,
the inquest, the new contract decisions, the launcher's --patrol and badge line, and the agent's patrol.
The gateway runs in local mode through Starlette's TestClient, on the memory registry or on DynamoRegistry over the
stateful fake from test_badge_changes.py; Cognito is a fake client. Nothing here calls AWS."""

import sys
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from gateway import app as app_module
from gateway.config import Settings
from gateway.events import verify_chain
from gateway.factory import add_env_lines, env_key, outcome_of, remove_env_lines
from gateway.identity import CognitoIdentity, IdentityError
from gateway.registry import DynamoRegistry, RegistryUnavailable
from tests.test_badge_changes import (ADMIN, READ, SECRET, StatefulDynamo, StatefulSession, anysecs, bearer, call,
                                      events, rpc)

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "agent"))
from validate_fixture import check_events  # type: ignore[import-not-found]  # noqa: E402

GOLD = ["read_file", "search_files", "create_issue", "list_issues", "send_email"]
BILLING = {"agent": "billing-bot", "name": "Billing Bot", "tier": "gold", "tools": GOLD, "color": "teal",
           "role": "answers billing questions"}
FAKE_SECRET = "s3cr3t-value-that-must-never-leave-the-env-file"


def make(tmp_path: Path, **overrides: Any) -> TestClient:
    settings = Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None,
                        agent_env=tmp_path / "agent.env", **overrides)
    return TestClient(app_module.create_app(settings))


@pytest.fixture(params=["memory", "dynamo"])
def fc(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    """A local-mode gateway with the env file in tmp_path, on the memory registry or DynamoRegistry over the fake."""
    if request.param == "dynamo":
        dynamo = StatefulDynamo()
        monkeypatch.setattr(app_module, "MemoryRegistry",
                            lambda: DynamoRegistry("mytopia_agents", StatefulSession(dynamo)))
    return make(tmp_path)


def env_text(c: TestClient) -> str:
    path = c.app.state.factory.settings.agent_env  # type: ignore[attr-defined]
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def agents(c: TestClient) -> dict[str, dict]:
    return {a["agent"]: a for a in c.get("/agents").json()}


def mint(c: TestClient, **changes: Any) -> Any:
    return c.post("/agents", json={**BILLING, **changes}, headers=ADMIN)


class FakeCognito:
    """create/delete_user_pool_client with the calls recorded; fail_create makes the provider look down."""

    def __init__(self, fail_create: bool = False) -> None:
        self.created: list[dict] = []
        self.deleted: list[str] = []
        self.fail_create = fail_create

    def create_user_pool_client(self, **kwargs: Any) -> dict:
        if self.fail_create:
            raise RuntimeError("ServiceUnavailable")
        self.created.append(kwargs)
        return {"UserPoolClient": {"ClientId": "3f9a1c7e" + "x" * 18, "ClientSecret": FAKE_SECRET}}

    def delete_user_pool_client(self, UserPoolId: str, ClientId: str) -> dict:  # noqa: N803
        self.deleted.append(ClientId)
        return {}


def with_cognito(c: TestClient, fake: FakeCognito) -> None:
    identity = CognitoIdentity("us-east-1_Pool", None, "mytopia/tools")
    identity._client = fake
    c.app.state.factory.identity = identity  # type: ignore[attr-defined]


# ----- tiers on badges, GET /tiers, GET /agents -----
def test_tiers_route_and_seed_badges_carry_their_tiers(fc: TestClient) -> None:
    tiers = fc.get("/tiers").json()
    assert [t["tier"] for t in tiers] == ["bronze", "silver", "gold", "diamond"]
    assert tiers[0] == {"tier": "bronze", "rank": 1, "name": "Bronze", "line": "looks, never changes anything",
                        "ceiling": ["read_file", "search_files"]}
    rows = agents(fc)
    assert (rows["research-bot"]["tier"], rows["ops-bot"]["tier"]) == ("silver", "bronze")
    assert rows["research-bot"]["ceiling"] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert rows["ops-bot"]["made_by"] == "seed" and rows["ops-bot"]["role"] == "reads documents"


def test_a_row_without_tier_gets_an_inferred_one_and_odd_statuses_are_not_listed(tmp_path: Path) -> None:
    c = make(tmp_path)
    rows = c.app.state.handler.registry._rows  # type: ignore[attr-defined]
    del rows["research-bot"]["tier"]                     # a row written before tonight
    rows["ops-bot"]["allowed_tools"] = ["read_file", "send_email"]
    del rows["ops-bot"]["tier"]
    listed = agents(c)
    assert (listed["research-bot"]["tier"], listed["ops-bot"]["tier"]) == ("silver", "gold")
    rows["ops-bot"]["status"] = "PENDING"
    assert set(agents(c)) == {"research-bot"}
    c.post("/demo/reset", headers=ADMIN)  # a reset writes the seed tiers back onto the rows
    assert rows["research-bot"]["tier"] == "silver" and rows["ops-bot"]["tier"] == "bronze"
    assert rows["ops-bot"]["status"] == "ACTIVE"


# ----- the grant path -----
def test_grant_adds_a_tool_and_logs_restored(fc: TestClient) -> None:
    fc.post("/agents/research-bot/tier", json={"tier": "gold"}, headers=ADMIN)
    r = fc.post("/agents/research-bot/tools/send_email/restore", headers=ADMIN)
    assert r.status_code == 200 and r.json()["changed"] is True
    assert r.json()["allowed_tools"] == GOLD
    event = events(fc)[-1]
    assert (event["decision"], event["tool"], event["rule"]) == ("restored", "send_email", "admin")
    assert event["reason"] == "send_email added to badge research-bot by operator"
    assert event["args_summary"] == "badge=" + ",".join(GOLD)
    # a company address: since build 5 any other `to` is refused with rule egress (tests/test_egress.py)
    assert call(fc, "send_email", {"to": "ceo@example.corp", "subject": "b", "body": "c"})["isError"] is False


def test_grant_above_the_ceiling_is_403_and_logs_nothing(fc: TestClient) -> None:
    before = len(events(fc))
    r = fc.post("/agents/research-bot/tools/delete_file/restore", headers=ADMIN)
    assert r.status_code == 403
    assert r.json() == {"error": "delete_file is above the Silver ceiling", "tier": "silver",
                        "ceiling": ["read_file", "search_files", "create_issue", "list_issues"]}
    assert len(events(fc)) == before
    assert agents(fc)["research-bot"]["allowed_tools"] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert fc.post("/agents/ops-bot/tools/create_issue/restore", headers=ADMIN).json()["error"] == (
        "create_issue is above the Bronze ceiling")
    # pulling a tool is never refused by the ceiling
    assert fc.post("/agents/research-bot/tools/create_issue/revoke", headers=ADMIN).status_code == 200


# ----- mint -----
def test_mint_creates_row_env_lines_and_created_event(fc: TestClient) -> None:
    r = mint(fc)
    assert r.status_code == 201
    body = r.json()
    assert set(body) == {"row", "event"}
    row = body["row"]
    assert row["agent"] == "billing-bot" and row["client_id"] == "local-billing-bot"
    assert (row["tier"], row["made_by"], row["status"], row["color"]) == ("gold", "factory", "ACTIVE", "teal")
    assert row["allowed_tools"] == GOLD and row["ceiling"] == GOLD and row["role"] == "answers billing questions"
    event = body["event"]
    assert (event["decision"], event["tool"], event["rule"], event["agent"], event["latency_ms"]) == (
        "created", "admin", "factory", "billing-bot", 0)
    assert event["args_summary"] == "tier=gold tools=" + ",".join(GOLD) + " color=teal"  # whole, under the 120 cap
    assert event["reason"] == "minted by the Factory: Gold badge, 5 tools, client local-bi"
    assert events(fc)[-1] == event
    listed = agents(fc)["billing-bot"]
    assert listed["tier"] == "gold" and listed["ceiling"] == GOLD and listed["created_at"]
    text = env_text(fc)
    assert "# minted by the Factory\nBILLING_BOT_CLIENT_ID=local-billing-bot\nBILLING_BOT_CLIENT_SECRET=\n" in text
    assert fc.app.state.handler.agent_by_client["local-billing-bot"] == "billing-bot"  # type: ignore[attr-defined]


def test_mint_refuses_duplicates_and_bad_input(fc: TestClient) -> None:
    assert fc.post("/agents", json=BILLING).status_code == 401
    assert mint(fc).status_code == 201
    n = len(events(fc))
    dup = mint(fc)
    assert dup.status_code == 409 and dup.json() == {"error": "agent billing-bot already exists"}
    assert mint(fc, agent="research-bot").status_code == 409
    bad = {"agent": "Billing", "name": "", "tier": "platinum", "tools": [], "color": "neon", "role": "x" * 61}
    for key, value in bad.items():
        r = mint(fc, **{"agent": "new-bot", key: value})
        assert r.status_code == 400 and isinstance(r.json()["error"], str), (key, r.json())
    assert mint(fc, agent="ab").status_code == 400                       # too short
    assert mint(fc, agent="new-bot", tools=["rm_rf"]).json()["error"] == "rm_rf is not one of the six tools"
    above = mint(fc, agent="new-bot", tier="silver")
    assert above.status_code == 400 and above.json()["error"] == "send_email is above the Silver ceiling"
    assert mint(fc, agent="new-bot", name="x" * 25).status_code == 400
    assert len(events(fc)) == n and "new-bot" not in agents(fc)
    assert "NEW_BOT" not in env_text(fc)
    tidy = mint(fc, agent="tidy-bot", tools=["send_email", "read_file", "read_file"])
    assert tidy.json()["row"]["allowed_tools"] == ["read_file", "send_email"]  # duplicates dropped, catalog order


def test_mint_with_cognito_keeps_the_secret_in_the_env_file_only(fc: TestClient, capsys: pytest.CaptureFixture) -> None:
    fake = FakeCognito()
    with_cognito(fc, fake)
    r = mint(fc)
    assert r.status_code == 201
    assert fake.created == [{"UserPoolId": "us-east-1_Pool", "ClientName": "billing-bot", "GenerateSecret": True,
                             "ExplicitAuthFlows": ["ALLOW_CLIENT_TOKEN_AUTH"], "AllowedOAuthFlowsUserPoolClient": True,
                             "AllowedOAuthFlows": ["client_credentials"], "AllowedOAuthScopes": ["mytopia/tools"],
                             "AccessTokenValidity": 5, "TokenValidityUnits": {"AccessToken": "minutes"}}]
    assert FAKE_SECRET not in r.text
    assert FAKE_SECRET not in fc.get("/events").text and FAKE_SECRET not in fc.get("/agents").text
    assert r.json()["event"]["reason"].endswith("client 3f9a1c7e")
    assert f"BILLING_BOT_CLIENT_SECRET={FAKE_SECRET}" in env_text(fc)
    out = capsys.readouterr()
    assert FAKE_SECRET not in out.out and FAKE_SECRET not in out.err


def test_mint_fails_closed_when_the_identity_provider_or_the_registry_is_down(fc: TestClient) -> None:
    with_cognito(fc, FakeCognito(fail_create=True))
    r = mint(fc)
    assert r.status_code == 503 and "no agent was created" in r.json()["error"]
    assert "billing-bot" not in agents(fc) and events(fc) == [] and env_text(fc) == ""
    fake = FakeCognito()
    with_cognito(fc, fake)
    registry = fc.app.state.handler.registry  # type: ignore[attr-defined]

    def down(row: dict) -> None:
        raise RegistryUnavailable("down")

    registry.put = down
    assert mint(fc).status_code == 503
    assert fake.deleted == ["3f9a1c7e" + "x" * 18]  # the client it had just created was deleted again
    assert events(fc) == [] and env_text(fc) == ""


def test_a_failed_env_write_undoes_the_mint(tmp_path: Path) -> None:
    (tmp_path / "agent.env").mkdir()  # a directory where the file should be: every write fails
    c = make(tmp_path)
    fake = FakeCognito()
    with_cognito(c, fake)
    r = mint(c)
    assert r.status_code == 503 and "env file" in r.json()["error"]
    assert "billing-bot" not in agents(c) and events(c) == [] and len(fake.deleted) == 1


def test_a_minted_agent_lists_and_calls_its_tools_with_a_local_token(fc: TestClient) -> None:
    mint(fc)
    who = bearer("billing-bot")
    tools = [t["name"] for t in rpc(fc, "tools/list", None, who).json()["result"]["tools"]]
    assert tools == GOLD
    assert call(fc, "send_email", {"to": "ceo@example.corp", "subject": "b", "body": "c"}, who)["isError"] is False
    denied = call(fc, "delete_file", {"path": "/x"}, who)
    assert denied["isError"] and denied["content"][0]["text"] == (
        "DENIED: delete_file is not on badge billing-bot [rule: allow-list]")
    # every control route knows it now: run start, status, revoke, restore, kill
    assert fc.post("/runs/run-b/started", json={"agent": "billing-bot", "agent_mode": "scripted", "pid": 1},
                   headers=ADMIN).status_code == 200
    assert fc.get("/agents/billing-bot/status", headers=who).json() == {"agent": "billing-bot", "status": "ACTIVE"}
    assert fc.post("/agents/billing-bot/revoke", headers=ADMIN).json()["status"] == "REVOKED"
    assert fc.post("/agents/billing-bot/restore", headers=ADMIN).json()["status"] == "ACTIVE"
    assert fc.post("/agents/billing-bot/kill", headers=ADMIN).json()["status"] == "KILLED"
    assert fc.post("/runs/run-x/started", json={"agent": "nobody-bot"}, headers=ADMIN).status_code == 400


def test_a_minted_agent_still_costs_one_badge_read_per_call(tmp_path: Path) -> None:
    c = make(tmp_path)
    mint(c)
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]
    counts = {"get": 0, "list_agents": 0}
    for name in counts:
        original = getattr(registry, name)

        def counted(*args: Any, _name: str = name, _original: Any = original) -> Any:
            counts[_name] += 1
            return _original(*args)

        setattr(registry, name, counted)
    call(c, "read_file", READ, bearer("billing-bot"))
    call(c, "delete_file", {"path": "/x"}, bearer("billing-bot"))
    assert counts == {"get": 2, "list_agents": 0}


# ----- promote and demote -----
def test_demotion_trims_and_logs_tier_changed(fc: TestClient) -> None:
    mint(fc)
    r = fc.post("/agents/billing-bot/tier", json={"tier": "silver"}, headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body == {"agent": "billing-bot", "tier": "silver", "was": "gold",
                    "allowed_tools": ["read_file", "search_files", "create_issue", "list_issues"],
                    "ceiling": ["read_file", "search_files", "create_issue", "list_issues"], "trimmed": ["send_email"],
                    "status": "ACTIVE", "changed": True, "seq": body["seq"]}
    event = events(fc)[-1]
    assert (event["decision"], event["tool"], event["rule"], event["seq"]) == ("tier_changed", "admin", "factory",
                                                                               body["seq"])
    assert event["args_summary"] == "tier=silver was=gold badge=read_file,search_files,create_issue,list_issues"
    assert event["reason"] == "Billing Bot demoted to Silver by operator (1 tool trimmed)"
    assert agents(fc)["billing-bot"]["tier"] == "silver"
    denied = call(fc, "send_email", {"to": "a", "subject": "b", "body": "c"}, bearer("billing-bot"))
    assert denied["content"][0]["text"].endswith("[rule: allow-list]")
    up = fc.post("/agents/billing-bot/tier", json={"tier": "diamond"}, headers=ADMIN).json()
    assert up["trimmed"] == [] and up["allowed_tools"] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert events(fc)[-1]["reason"] == "Billing Bot promoted to Diamond by operator"
    assert fc.post("/agents/billing-bot/tools/delete_file/restore", headers=ADMIN).status_code == 200
    same = fc.post("/agents/billing-bot/tier", json={"tier": "diamond"}, headers=ADMIN).json()
    assert same["changed"] is False and same["seq"] is None
    assert fc.post("/agents/billing-bot/tier", json={"tier": "mithril"}, headers=ADMIN).status_code == 400
    assert fc.post("/agents/nobody-bot/tier", json={"tier": "gold"}, headers=ADMIN).status_code == 404
    assert fc.post("/agents/billing-bot/tier", json={"tier": "gold"}).status_code == 401
    assert verify_chain(events(fc))


def test_trimmed_tool_refusals_never_quarantine(tmp_path: Path) -> None:
    c = make(tmp_path)
    mint(c)
    c.post("/agents/billing-bot/tier", json={"tier": "silver"}, headers=ADMIN)
    for _ in range(4):
        call(c, "send_email", {"to": "a", "subject": "b", "body": "c"}, bearer("billing-bot"))
    assert agents(c)["billing-bot"]["status"] == "ACTIVE"  # the operator already acted on send_email


# ----- retire -----
def test_retire_removes_row_env_lines_and_logs_retired(fc: TestClient) -> None:
    fake = FakeCognito()
    with_cognito(fc, fake)
    client_id = mint(fc).json()["row"]["client_id"]
    mint(fc, agent="other-bot", name="Other Bot")
    r = fc.post("/agents/billing-bot/retire", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert (body["agent"], body["retired"], body["identity_deleted"]) == ("billing-bot", True, True)
    assert fake.deleted == [client_id]
    event = events(fc)[-1]
    assert (event["decision"], event["tool"], event["rule"], event["seq"]) == ("retired", "admin", "factory", body["seq"])
    assert event["args_summary"] == f"made_by=factory client={client_id[:8]}"
    assert event["reason"] == "retired by operator: identity deleted, badge row removed"
    assert "billing-bot" not in agents(fc)
    assert "BILLING_BOT_" not in env_text(fc) and "OTHER_BOT_CLIENT_ID" in env_text(fc)
    assert client_id not in fc.app.state.handler.agent_by_client  # type: ignore[attr-defined]
    assert fc.post("/agents/billing-bot/retire", headers=ADMIN).status_code == 404
    assert fc.post("/agents/other-bot/retire").status_code == 401


def test_seed_agents_refuse_retire(fc: TestClient) -> None:
    for agent in ("research-bot", "ops-bot"):
        r = fc.post(f"/agents/{agent}/retire", headers=ADMIN)
        assert r.status_code == 409 and "seed agent" in r.json()["error"]
    assert set(agents(fc)) == {"research-bot", "ops-bot"} and events(fc) == []


def test_a_retired_agents_token_is_refused(tmp_path: Path) -> None:
    c = make(tmp_path)
    mint(c)
    assert call(c, "read_file", READ, bearer("billing-bot"))["isError"] is False
    c.post("/agents/billing-bot/retire", headers=ADMIN)
    assert rpc(c, "tools/call", {"name": "read_file", "arguments": READ}, bearer("billing-bot")).status_code == 401


def test_a_failed_identity_delete_still_retires_and_says_so(tmp_path: Path) -> None:
    c = make(tmp_path)
    fake = FakeCognito()
    with_cognito(c, fake)
    mint(c)

    def broken(**kwargs: Any) -> None:
        raise RuntimeError("AccessDenied")

    fake.delete_user_pool_client = broken  # type: ignore[method-assign]
    body = c.post("/agents/billing-bot/retire", headers=ADMIN).json()
    assert body["identity_deleted"] is False and "billing-bot" not in agents(c)
    assert "identity delete failed" in events(c)[-1]["reason"]


# ----- reset -----
def test_reset_retires_factory_agents_and_reseeds(fc: TestClient) -> None:
    fake = FakeCognito()
    with_cognito(fc, fake)
    mint(fc)
    fc.post("/agents/research-bot/tier", json={"tier": "bronze"}, headers=ADMIN)
    assert fc.post("/demo/reset", headers=ADMIN).json()["ok"] is True
    rows = agents(fc)
    assert set(rows) == {"research-bot", "ops-bot"}
    assert (rows["research-bot"]["tier"], rows["ops-bot"]["tier"]) == ("silver", "bronze")
    assert rows["research-bot"]["allowed_tools"] == ["read_file", "search_files", "create_issue", "list_issues"]
    assert len(fake.deleted) == 1 and "BILLING_BOT_" not in env_text(fc) and events(fc) == []
    assert mint(fc).status_code == 201  # the id is free again


# ----- the inquest -----
def test_inquest_of_a_quarantine(tmp_path: Path) -> None:
    c = make(tmp_path)
    mint(c)
    c.post("/runs/run-q/started", json={"agent": "billing-bot", "agent_mode": "scripted", "pid": 7}, headers=ADMIN)
    who = bearer("billing-bot")
    for _ in range(2):
        call(c, "read_file", READ, who)
    for _ in range(3):
        call(c, "delete_file", {"path": "/x"}, who)
    report = c.get("/agents/billing-bot/inquest").json()
    assert report["agent"] == "billing-bot" and report["name"] == "Billing Bot" and report["tier"] == "gold"
    assert report["run_id"] == "run-q" and report["client"] == "local-bi"
    assert report["outcome"] == "quarantined"
    assert report["calls"] == {"allowed": 2, "refused": 3}
    assert report["refused_by_tool"] == [{"tool": "delete_file", "n": 3, "rule": "allow-list", "home": "admin"}]
    assert report["first_refusal"]["tool"] == "delete_file"
    assert report["first_refusal"]["reason"] == "delete_file is not on badge billing-bot"
    trigger = report["trigger"]
    assert (trigger["kind"], trigger["by"]) == ("quarantine", "gateway")
    assert anysecs(trigger["detail"]) == "3 refused calls in N s"  # the seconds depend on the machine's load
    assert report["timings"]["revoke_to_first_deny_ms"] is None and report["timings"]["kill_to_stopped_ms"] is None
    assert isinstance(report["timings"]["decision_p50_ms"], int)
    assert report["chain"] == {"rows": 7, "verified": True}  # run_started, 5 calls, the quarantine
    assert report["verdict"] == ("Attempted delete_file 3 times; its Gold badge does not hold it; the gateway refused "
                                 "every attempt, and pulled the badge itself.")
    assert report["recommendation"] == ("Keep the badge at Gold. Restore only after the task is fixed; do not grant "
                                        "delete_file.")


def test_inquest_of_a_kill_and_of_a_revoke(tmp_path: Path) -> None:
    c = make(tmp_path)
    c.post("/runs/run-k/started", json={"agent": "research-bot", "agent_mode": "scripted", "pid": 9}, headers=ADMIN)
    call(c, "read_file", READ)
    c.post("/agents/research-bot/kill", headers=ADMIN)
    c.post("/runs/run-k/stopped", json={"exit_code": 1, "how": "killed by harness"}, headers=ADMIN)
    report = c.get("/agents/research-bot/inquest").json()
    assert report["outcome"] == "killed" and report["tier"] == "silver" and report["run_id"] == "run-k"
    assert report["calls"] == {"allowed": 1, "refused": 0} and report["refused_by_tool"] == []
    assert report["first_refusal"] is None
    assert (report["trigger"]["kind"], report["trigger"]["by"]) == ("kill", "operator")
    assert isinstance(report["timings"]["kill_to_stopped_ms"], int) and report["timings"]["kill_to_stopped_ms"] >= 0
    assert report["verdict"] == "No badge violations; the run was stopped by the operator."
    assert report["recommendation"] == "The identity stays; the next run starts clean."
    # ops-bot: revoked by the operator, then it kept calling
    c.post("/runs/run-r/started", json={"agent": "ops-bot", "agent_mode": "scripted", "pid": 10}, headers=ADMIN)
    c.post("/agents/ops-bot/revoke", headers=ADMIN)
    call(c, "read_file", READ, bearer("ops-bot"))
    ops = c.get("/agents/ops-bot/inquest").json()
    ms = ops["timings"]["revoke_to_first_deny_ms"]
    assert ops["outcome"] == "revoked" and isinstance(ms, int)
    assert ops["refused_by_tool"] == [{"tool": "read_file", "n": 1, "rule": "status-revoked", "home": "files"}]
    assert ops["verdict"] == f"Kept calling after REVOKE: refused within {ms} ms."
    assert c.get("/agents/nobody-bot/inquest").status_code == 404


def test_inquest_of_a_run_that_ended_by_itself(tmp_path: Path) -> None:
    """A finished job, an exit, a run still going: no badge violations, never "stopped by the operator"; that line
    stays for a KILL (above) and an operator REVOKE."""
    c = make(tmp_path)
    c.post("/runs/run-e/started", json={"agent": "research-bot", "agent_mode": "scripted", "pid": 11}, headers=ADMIN)
    call(c, "read_file", READ)
    c.post("/runs/run-e/stopped", json={"exit_code": 0, "how": "job done"}, headers=ADMIN)
    report = c.get("/agents/research-bot/inquest").json()
    assert (report["outcome"], report["trigger"], report["run_id"]) == ("ended", None, "run-e")
    assert (report["verdict"], report["recommendation"]) == ("No badge violations.", "Nothing to do.")
    c.post("/runs/run-f/started", json={"agent": "research-bot", "agent_mode": "scripted", "pid": 12}, headers=ADMIN)
    c.post("/runs/run-f/stopped", json={"exit_code": 1, "how": "exited"}, headers=ADMIN)
    report = c.get("/agents/research-bot/inquest").json()
    assert (report["outcome"], report["verdict"]) == ("ended", "No badge violations.")
    c.post("/runs/run-g/started", json={"agent": "research-bot", "agent_mode": "scripted", "pid": 13}, headers=ADMIN)
    call(c, "read_file", READ)
    report = c.get("/agents/research-bot/inquest").json()
    assert (report["outcome"], report["verdict"], report["recommendation"]) == (
        "active", "No badge violations.", "Nothing to do.")
    c.post("/agents/research-bot/revoke", headers=ADMIN)  # an operator REVOKE, and no call after it
    report = c.get("/agents/research-bot/inquest").json()
    assert report["outcome"] == "revoked"
    assert report["verdict"] == "No badge violations; the run was stopped by the operator."


def test_only_a_kill_makes_a_stopped_run_killed() -> None:
    def stopped(reason: str, summary: str, first: str = "run_started") -> list[dict]:
        return [{"seq": 1, "decision": first, "tool": "admin" if first == "kill_requested" else "harness"},
                {"seq": 2, "decision": "run_stopped", "tool": "harness", "reason": reason, "args_summary": summary}]

    # the reason may quote the agent's last words after " · ": only the launcher's own words, or a KILL, count
    assert outcome_of(stopped("exit 0 (job done) · JOB DONE: nothing killed", "pid=7 job done"), "ACTIVE") == "ended"
    assert outcome_of(stopped("exit None (stopped by the gateway: retire)", "pid=7 stopped by the gateway"),
                      "ACTIVE") == "ended"
    assert outcome_of(stopped("exit 1 (killed by harness)", "pid=7 killed by harness"), "ACTIVE") == "killed"
    assert outcome_of(stopped("exit 1 (exited)", "pid=7 exited", first="kill_requested"), "KILLED") == "killed"


# ----- the contract -----
def test_validate_fixture_accepts_the_factory_decisions_from_a_real_chain(tmp_path: Path) -> None:
    c = make(tmp_path)
    mint(c)
    c.post("/agents/billing-bot/tier", json={"tier": "silver"}, headers=ADMIN)
    c.post("/agents/research-bot/tools/delete_file/restore", headers=ADMIN)  # refused: not an event
    c.post("/agents/billing-bot/retire", headers=ADMIN)
    chain = events(c)
    assert [e["decision"] for e in chain] == ["created", "tier_changed", "retired"]
    assert check_events(chain, strict=True) == []
    created = chain[0]
    assert check_events([{**created, "rule": "admin"}], strict=False) != []      # a Factory decision needs rule factory
    assert check_events([{**created, "tool": "send_email"}], strict=False) != []  # and tool admin
    assert check_events([{**created, "decision": "revoked"}], strict=False) != []  # only they use rule factory


# ----- the env file helpers -----
def test_env_lines_are_added_replaced_and_removed(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text("GATEWAY_URL=http://127.0.0.1:8787\nADMIN_TOKEN=x\n", encoding="utf-8")
    add_env_lines(path, "billing-bot", "c1", "s1")
    add_env_lines(path, "billing-bot", "c2", "s2")
    add_env_lines(path, "tidy-bot", "c3", "")
    assert path.read_text(encoding="utf-8") == ("GATEWAY_URL=http://127.0.0.1:8787\nADMIN_TOKEN=x\n"
                                                "# minted by the Factory\nBILLING_BOT_CLIENT_ID=c2\n"
                                                "BILLING_BOT_CLIENT_SECRET=s2\nTIDY_BOT_CLIENT_ID=c3\n"
                                                "TIDY_BOT_CLIENT_SECRET=\n")
    remove_env_lines(path, "billing-bot")
    assert "BILLING_BOT" not in path.read_text(encoding="utf-8") and "ADMIN_TOKEN=x" in path.read_text(encoding="utf-8")
    assert env_key("billing-bot", "CLIENT_ID") == "BILLING_BOT_CLIENT_ID"


def test_dynamo_list_falls_back_to_the_seed_rows_when_scan_is_refused() -> None:
    dynamo = StatefulDynamo()
    registry = DynamoRegistry("mytopia_agents", StatefulSession(dynamo))
    assert {r["agent"] for r in registry.list_agents()} == {"research-bot", "ops-bot"}

    def refused(**kwargs: Any) -> dict:
        raise RuntimeError("AccessDeniedException")  # the role before infra/role_policy.py adds dynamodb:Scan

    dynamo.scan = refused  # type: ignore[method-assign]
    assert {r["agent"] for r in registry.list_agents()} == {"research-bot", "ops-bot"}
    dynamo.get_item = refused  # type: ignore[method-assign]
    with pytest.raises(RegistryUnavailable):  # a real outage still fails closed
        registry.list_agents()


def test_cognito_identity_without_a_session_fails_closed() -> None:
    with pytest.raises(IdentityError):
        CognitoIdentity("us-east-1_Pool", None).create("billing-bot")
    assert CognitoIdentity("", None).delete("abc") is False


# ----- launcher and agent -----
def test_launcher_patrol_flag_name_and_badge_line() -> None:
    sys.path.insert(0, str(ROOT))
    from launcher.run import badge_line, child_env, parse_args

    assert parse_args(["--scripted", "--patrol"]).patrol is True and parse_args([]).patrol is False
    env = child_env("tok", "run-1", "billing-bot", "scripted", "http://x", "t.json", {}, patrol=True,
                    agent_name="Billing Bot")
    assert env["AGENT_PATROL"] == "1" and env["AGENT_NAME"] == "Billing Bot"
    plain = child_env("tok", "run-1", "research-bot", "scripted", "http://x", "t.json", {})
    assert "AGENT_PATROL" not in plain and "AGENT_NAME" not in plain
    assert badge_line({"agent": "billing-bot", "name": "Billing Bot", "tier": "gold", "allowed_tools": GOLD}) == (
        "launching Billing Bot (Gold badge, 5 tools)")
    assert badge_line({"agent": "ops-bot", "name": "Ops Bot", "tier": "bronze", "allowed_tools": ["read_file"]}) == (
        "launching Ops Bot (Bronze badge, 1 tool)")


class StopPatrol(Exception):
    pass


class Listed:
    def __init__(self, name: str) -> None:
        self.tool_name = name


def test_agent_patrol_calls_only_listed_tools_and_follows_the_badge(monkeypatch: pytest.MonkeyPatch,
                                                                    capsys: pytest.CaptureFixture) -> None:
    """Each cycle: tools/list, then each listed tool once in catalog order, one per 3 s slot (the list takes none).
    A grant shows up in the next cycle; a pull drops out; an empty list waits one slot; never an unlisted tool."""
    import main  # type: ignore[import-not-found]

    badges = [["read_file", "search_files", "create_issue", "list_issues"],   # the opening tools/list
              ["list_issues", "read_file", "create_issue", "search_files"],   # cycle 1 (any order in, catalog order out)
              ["read_file", "search_files", "create_issue", "list_issues", "send_email"],  # cycle 2: send_email granted
              ["read_file", "send_email"],                                    # cycle 3: two pulled
              [],                                                             # cycle 4: badge revoked
              ["read_file", "send_email"]]                                    # cycle 5: back
    calls: list[str] = []
    sleeps: list[float] = []

    class Fake:
        def list_tools_sync(self) -> list:
            if not badges:
                raise StopPatrol
            calls.append("tools/list")
            return [Listed(n) for n in badges.pop(0)]

        def call_tool_sync(self, tool_use_id: str, name: str, arguments: dict) -> dict:
            calls.append(name)
            return {"status": "success", "content": [{"text": "ok"}]}

    monkeypatch.setattr(main.time, "sleep", sleeps.append)
    monkeypatch.setenv("AGENT_PATROL", "1")
    with pytest.raises(StopPatrol):
        main.run_scripted(Fake(), 1)
    opening = ["tools/list", "read_file", "search_files", "create_issue", "send_email"]
    assert calls == [*opening,
                     "tools/list", "read_file", "search_files", "create_issue", "list_issues",
                     "tools/list", "read_file", "search_files", "create_issue", "list_issues", "send_email",
                     "tools/list", "read_file", "send_email",
                     "tools/list",
                     "tools/list", "read_file", "send_email"]
    assert "delete_file" not in calls  # never listed, never called
    assert len(sleeps) == 4 + 5 + 2 + 1 + 2  # one 3 s slot per patrol call, one for the empty cycle; tools/list none
    out = capsys.readouterr().out
    assert "badge now lists 4 tools: read_file, search_files, create_issue, list_issues" in out
    assert "badge now lists 5 tools: read_file, search_files, create_issue, list_issues, send_email" in out
    assert "badge now lists 2 tools: read_file, send_email" in out and "badge now lists 0 tools: none" in out
    assert out.count("badge now lists 4 tools") == 1  # printed only when the set changes
    monkeypatch.setenv("AGENT_NAME", "Billing Bot")
    assert main.system_prompt().startswith("You are Billing Bot, an assistant")
    monkeypatch.delenv("AGENT_NAME")
    assert main.system_prompt().startswith("You are Research Bot, an assistant")
