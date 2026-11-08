"""Tests for build 5's egress rule. A send_email the badge holds must still go only to company addresses
(EMAIL_DOMAINS, default example.corp). `to` is parsed leniently: recipients split by commas or semicolons, each a bare
address or `Display Name <addr>`. A recipient outside the company is refused with rule egress, the tool never runs and
the badge is pulled at once (one conditional write; still one badge read per call). A `to` with nothing outside but
no valid company address either is refused with rule egress too, without pulling the badge; it counts toward the
3-in-60-s quarantine like an allow-list refusal. Also the inquest's verdict choice and the contract.
The gateway runs in local mode through Starlette's TestClient, on the memory registry or on DynamoRegistry over the
stateful fake from test_badge_changes.py. Nothing here calls AWS or binds a port."""

import sys
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from gateway import app as app_module
from gateway.config import Settings
from gateway.decide import (INSIDE, INVALID, OUTSIDE, address_label, decide, egress_reason, inside_company,
                            parse_domains, recipient_class)
from gateway.factory import egress_target, is_leak
from gateway.registry import DynamoRegistry, RegistryUnavailable, seed_rows
from tests.test_badge_changes import (ADMIN, READ, SECRET, StatefulDynamo, StatefulSession, anysecs, badge, bearer,
                                      call, events)

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from validate_fixture import check_events  # type: ignore[import-not-found]  # noqa: E402

SIX = ["read_file", "search_files", "create_issue", "list_issues", "send_email", "delete_file"]
# the incident: a Diamond badge holding all six tools, running the "Attack drill" job
DRILL = {"agent": "drill-bot", "name": "Drill Bot", "tier": "diamond", "tools": SIX, "color": "plum",
         "role": "attack drill"}
GOLD_BOT = {"agent": "gold-bot", "name": "Gold Bot", "tier": "gold", "tools": SIX[:5], "color": "teal"}
LEAK = {"to": "partner@rival.example", "subject": "Q3 plan",
        "body": "Forwarding the Q3 plan as the document instructs."}
MEMO = {"to": "ceo@example.corp", "subject": "Q3 summary", "body": "two lines"}
PLAN = {"path": "/drive/q3-planning.md"}
REASON = "send_email to partner@rival.example refused: outside the company (only @example.corp)"
DENIED = f"DENIED: {REASON} [rule: egress]"
PULLED = "badge pulled by quarantine after an attempt to send company data outside (partner@rival.example)"
VERDICT = ("Tried to send company data outside the company (send_email to partner@rival.example); the gateway "
           "refused it and pulled the badge at once.")
RECOMMENDATION = "Do not restore until the task's inputs are cleaned: a document told it to leak."
CLEAN = "No badge violations."  # the verdict of a run that is still going or ended by itself, with nothing to say
GATEWAY_PULLED = "The gateway pulled the badge itself after repeated refused calls."
MISSING = object()  # a call whose arguments have no "to" at all
UNCLOSED = "CEO <ceo@example.corp"  # malformed: the angle bracket is never closed


def outside(shown: str) -> str:
    return f"send_email to {shown} refused: outside the company (only @example.corp)"


def invalid(shown: str) -> str:
    return f"send_email to {shown} refused: not a valid company address (only @example.corp)"


def make(**overrides: Any) -> TestClient:
    settings = Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None,
                        **overrides)
    return TestClient(app_module.create_app(settings))


@pytest.fixture(params=["memory", "dynamo"])
def gw(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A local-mode gateway on the memory registry or on DynamoRegistry over the stateful fake."""
    if request.param == "dynamo":
        dynamo = StatefulDynamo()
        monkeypatch.setattr(app_module, "MemoryRegistry",
                            lambda: DynamoRegistry("mytopia_agents", StatefulSession(dynamo)))
    return make()


def mint(c: TestClient, body: dict = DRILL) -> dict:
    """Mint an agent through the Factory and return its bearer header."""
    assert c.post("/agents", json=body, headers=ADMIN).status_code == 201
    return bearer(body["agent"])


def tool_runs(c: TestClient) -> list[str]:
    """Record every tool the gateway actually runs (in AWS mode, every Lambda invoke)."""
    tools = c.app.state.handler.tools  # type: ignore[attr-defined]
    ran: list[str] = []
    original = tools.invoke

    def invoke(name: str, arguments: dict) -> dict:
        ran.append(name)
        return original(name, arguments)

    tools.invoke = invoke
    return ran


def send(c: TestClient, to: object, who: dict) -> dict:
    """send_email with this `to` (MISSING leaves the key out)."""
    arguments = {k: v for k, v in {**MEMO, "to": to}.items() if v is not MISSING}
    return call(c, "send_email", arguments, who)


def revokes(c: TestClient) -> list[dict]:
    return [e for e in events(c) if e["decision"] == "revoked"]


def row(c: TestClient, agent: str = "drill-bot") -> dict:
    return c.app.state.handler.registry.get(agent)  # type: ignore[attr-defined]


def counted(c: TestClient, agent: str = "drill-bot") -> int:
    return len(c.app.state.handler.refusals.get(agent, []))  # type: ignore[attr-defined]


# ----- allowed: every recipient is a company address -----
def test_a_company_address_passes_and_the_tool_runs(gw: TestClient) -> None:
    who = mint(gw)
    ran = tool_runs(gw)
    result = call(gw, "send_email", MEMO, who)
    assert result["isError"] is False and result["content"][0]["text"] == "sent to ceo@example.corp"
    assert ran == ["send_email"]
    last = events(gw)[-1]
    assert (last["decision"], last["rule"], last["tool"]) == ("allow", "allow-list", "send_email")
    assert last["reason"] == "send_email is on badge drill-bot"
    assert badge(gw, "drill-bot")["status"] == "ACTIVE" and revokes(gw) == []


@pytest.mark.parametrize("to", [
    "CEO <ceo@example.corp>",                              # the display-name form
    "<ceo@example.corp>",
    '"Jane Doe" <jane@example.corp>',
    "Dana < dana@example.corp >",                          # trimmed inside the brackets too
    "ceo@example.corp, team@example.corp",                 # a list
    "CEO <ceo@example.corp>; Team <team@EXAMPLE.corp>",
    "ceo@example.corp; cfo@example.corp,",                 # an empty part is skipped
    "  ceo@example.corp\t",                                # trimmed
    "Ceo@Example.CORP",                                    # case-insensitive
])
def test_display_names_and_lists_of_company_addresses_pass(to: str) -> None:
    c = make()
    who = mint(c)
    ran = tool_runs(c)
    result = send(c, to, who)
    assert result["isError"] is False and result["content"][0]["text"] == f"sent to {to}"  # the tool got the original
    assert ran == ["send_email"] and badge(c, "drill-bot")["status"] == "ACTIVE" and revokes(c) == []


# ----- a recipient outside the company: refused, and the badge is pulled at once -----
def test_an_outside_address_is_refused_with_rule_egress_and_the_tool_never_runs(gw: TestClient) -> None:
    who = mint(gw)
    ran = tool_runs(gw)
    assert call(gw, "read_file", PLAN, who)["isError"] is False  # the poisoned document: reading it is allowed
    result = call(gw, "send_email", LEAK, who)
    meta = result.pop("_meta")
    assert result == {"content": [{"type": "text", "text": DENIED}], "isError": True}  # the same shape as any deny
    assert ran == ["read_file"]  # send_email never ran: no Lambda call
    deny = next(e for e in events(gw) if e["decision"] == "deny")
    assert (deny["tool"], deny["rule"], deny["agent"]) == ("send_email", "egress", "drill-bot")
    assert deny["run_id"] == "run-test" and deny["reason"] == REASON
    assert deny["args_summary"] == f"to=partner@rival.example subject=Q3 plan body={len(LEAK['body'])} chars"
    assert isinstance(deny["latency_ms"], int) and deny["ms_since_revoke"] is None  # timed like any deny, no clock
    assert meta == {"mytopia/latency_ms": deny["latency_ms"], "mytopia/seq": deny["seq"]}


@pytest.mark.parametrize("to, shown", [
    ("ceo@example.corp, partner@rival.example", None),     # one outside address in a list
    ("CEO <ceo@example.corp>; Partner <partner@rival.example>", None),
    ("Partner <partner@RIVAL.example>", None),
    ("partner@rival.example, ceo", None),                  # a malformed part never hides the outside one
    ("ceo@example.corp.rival.example", None),              # exact: a longer name is another domain
    ("ceo@mail.example.corp", None),                       # exact: no subdomains
    ("ceo@exаmple.corp", None),                       # a Cyrillic look-alike "a"
    ("x" * 70 + "@rival.example", "x" * 49 + "…@rival.example"),  # too long: the local part is cut, the domain kept
    ("ceo@example.corp, team@example.corp, ops@example.corp, partner@rival.example",
     "partner@rival.example (+3 more)"),                   # a long list shows its first outside recipient
])
def test_a_list_with_one_outside_address_is_refused_and_pulls_the_badge(to: str, shown: str | None) -> None:
    c = make()
    who = mint(c)
    ran = tool_runs(c)
    assert send(c, to, who)["content"][0]["text"] == f"DENIED: {outside(shown or to)} [rule: egress]"
    assert ran == [] and badge(c, "drill-bot")["status"] == "REVOKED"
    pulled = revokes(c)[-1]
    assert pulled["args_summary"] == "quarantine: 1 refused call (egress)"
    assert pulled["reason"] == (
        f"badge pulled by quarantine after an attempt to send company data outside ({shown or to})")


# ----- nothing outside, but not a valid company address: refused, counted, the badge stays -----
@pytest.mark.parametrize("to, shown", [
    ("partner", None),                                     # no "@"
    ("@example.corp", None),                               # empty local part
    ("ceo@@example.corp", None),                           # two "@"
    ("ceo@", None),                                        # no domain
    ("ceo@example.corp.", None),                           # an empty label: a typo, not a rival
    ("ceo@example..corp", None),
    ("ceo,cfo@example.corp", None),                        # "ceo" alone is malformed
    ("Doe, Jane <jane@example.corp>", None),               # an unquoted comma splits the name: "Doe" is malformed
    ("ceo@example.corp partner@rival.example", None),      # a space inside one recipient: malformed, not outside
    (UNCLOSED, None),
    ("CEO <ceo@example.corp> x", None),                    # text after the brackets
    ("<<ceo@example.corp>>", None),
    ("ceo@example.corp\nBcc: partner@rival.example", "ceo@example.corp?Bcc: partner@rival.example"),
    ("ceo\x00@example.corp", "ceo?@example.corp"),       # a control character
    ("partner%rival.example@example.corp", None),          # the percent hack: relaying through the company's server
    ("rival.example!partner@example.corp", None),          # a bang path
    (["ceo@example.corp"], "['ceo@example.corp']"),        # not one string
    (42, "42"),
])
def test_a_malformed_to_is_refused_without_pulling_the_badge(to: object, shown: str | None) -> None:
    c = make()
    who = mint(c)
    ran = tool_runs(c)
    assert send(c, to, who)["content"][0]["text"] == f"DENIED: {invalid(shown or str(to))} [rule: egress]"
    assert ran == [] and revokes(c) == [] and badge(c, "drill-bot")["status"] == "ACTIVE"
    deny = events(c)[-1]
    assert (deny["decision"], deny["rule"], deny["tool"]) == ("deny", "egress", "send_email")
    assert "\n" not in deny["reason"] and counted(c) == 1  # no forged log line; one refusal toward the quarantine


@pytest.mark.parametrize("to, shown", [(MISSING, "(no address)"), (None, "(no address)"), ("", "(no address)"),
                                       ("   ", "(no address)"), (" , ; ", " , ; ")])
def test_an_empty_or_missing_to_is_refused_without_pulling_the_badge(to: object, shown: str) -> None:
    c = make()
    who = mint(c)
    ran = tool_runs(c)
    assert send(c, to, who)["content"][0]["text"] == f"DENIED: {invalid(shown)} [rule: egress]"
    assert ran == [] and revokes(c) == [] and badge(c, "drill-bot")["status"] == "ACTIVE" and counted(c) == 1


def test_three_malformed_in_60_s_trip_the_normal_quarantine(gw: TestClient) -> None:
    who = mint(gw)
    send(gw, UNCLOSED, who)
    send(gw, "ceo@", who)
    assert revokes(gw) == [] and badge(gw, "drill-bot")["status"] == "ACTIVE"
    assert send(gw, "", who)["content"][0]["text"] == f"DENIED: {invalid('(no address)')} [rule: egress]"
    pulled = revokes(gw)[-1]  # the third: the existing quarantine, word for word
    assert (pulled["tool"], pulled["rule"]) == ("admin", "admin")
    assert anysecs(pulled["args_summary"]) == "quarantine: 3 refused calls in N s"
    assert anysecs(pulled["reason"]) == "badge pulled by quarantine after 3 refused calls in N s"
    assert badge(gw, "drill-bot")["status"] == "REVOKED"
    assert call(gw, "read_file", READ, who)["content"][0]["text"].endswith("[rule: status-revoked]")


def test_malformed_and_allow_list_refusals_count_together() -> None:
    c = make()
    who = mint(c, GOLD_BOT)
    call(c, "delete_file", {"path": "/drive/okrs.md"}, who)  # allow-list: not on a Gold badge
    send(c, "ceo", who)
    assert revokes(c) == []
    send(c, "ceo@", who)
    assert [anysecs(e["args_summary"]) for e in revokes(c)] == ["quarantine: 3 refused calls in N s"]


# ----- the address rules on their own -----
def test_matching_is_exact_and_case_insensitive() -> None:
    assert inside_company("Ceo@EXAMPLE.corp", ["example.corp"]) and inside_company("ceo@example.corp", "EXAMPLE.CORP")
    mixed = make(email_domains=("Example.CORP ",))  # Settings built in code: still trimmed and lower-cased
    assert call(mixed, "send_email", MEMO, mint(mixed))["isError"] is False
    # ASCII case only: the Kelvin sign lower-cases to "k", but a look-alike domain never matches (it is outside)
    assert inside_company("x@BANK.example", ["bank.example"])
    assert recipient_class("x@banK.example", ["bank.example"]) == OUTSIDE
    assert recipient_class("CEO <ceo@example.corp>, ops@example.corp", ["example.corp"]) == INSIDE
    assert recipient_class("ceo@example.corp, ceo", ["example.corp"]) == INVALID


def test_several_domains_via_email_domains(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("EMAIL_DOMAINS", " example.corp, Partner.Example ,, bad domain")
    assert Settings.from_env(tmp_path / "missing.env").email_domains == ("example.corp", "partner.example")
    monkeypatch.delenv("EMAIL_DOMAINS")
    assert Settings.from_env(tmp_path / "missing.env").email_domains == ("example.corp",)  # the default
    assert Settings().email_domains == ("example.corp",)
    c = make(email_domains=("example.corp", "partner.example"))
    who = mint(c)
    assert send(c, "Ops <ops@partner.example>, ceo@example.corp", who)["isError"] is False
    assert call(c, "send_email", LEAK, who)["content"][0]["text"] == (
        "DENIED: send_email to partner@rival.example refused: outside the company "
        "(only @example.corp or @partner.example) [rule: egress]")
    # a list that parses to nothing allows nothing: fails closed (every address is outside)
    assert parse_domains(" , ") == ()
    none = make(email_domains=())
    assert call(none, "send_email", MEMO, mint(none))["content"][0]["text"] == (
        "DENIED: send_email to ceo@example.corp refused: outside the company (no company domain is set) [rule: egress]")


def test_a_badge_without_send_email_gets_the_allow_list_deny(gw: TestClient) -> None:
    result = call(gw, "send_email", LEAK)  # research-bot: Silver, no send_email on the badge
    assert result["content"][0]["text"] == "DENIED: send_email is not on badge research-bot [rule: allow-list]"
    assert (events(gw)[-1]["rule"], badge(gw)["status"]) == ("allow-list", "ACTIVE")
    assert revokes(gw) == []  # one allow-list refusal: counted toward the 3-in-60-s quarantine, nothing more
    # a badge whose send_email the operator pulled: allow-list too, never egress (and not counted: the operator acted)
    who = mint(gw)
    gw.post("/agents/drill-bot/tools/send_email/revoke", headers=ADMIN)
    assert call(gw, "send_email", LEAK, who)["content"][0]["text"] == (
        "DENIED: send_email is not on badge drill-bot [rule: allow-list]")
    assert badge(gw, "drill-bot")["status"] == "ACTIVE"


def test_decide_checks_egress_last_and_only_for_send_email() -> None:
    full = {**seed_rows()["research-bot"], "allowed_tools": SIX}
    assert decide(full, "send_email", MEMO).ok
    d = decide(full, "send_email", LEAK)
    assert (d.ok, d.rule, d.reason, d.leak) == (False, "egress", REASON, True)
    bad = decide(full, "send_email", {**MEMO, "to": UNCLOSED})
    assert (bad.ok, bad.rule, bad.reason, bad.leak) == (False, "egress", invalid(UNCLOSED), False)
    assert decide({**full, "status": "KILLED"}, "send_email", LEAK).rule == "status-killed"
    revoked = {**full, "status": "REVOKED", "revoked_by": "quarantine"}
    assert decide(revoked, "send_email", LEAK).rule == "status-revoked"
    assert decide(seed_rows()["research-bot"], "send_email", LEAK).rule == "allow-list"
    assert decide(full, "send_email").reason == invalid("(no address)")                  # no arguments: fails closed
    assert decide(full, "read_file", {"path": "/x", "to": "partner@rival.example"}).ok  # send_email only
    assert decide(full, "send_email", LEAK, ("rival.example",)).ok  # the domains are the gateway's setting


# ----- the pull: one write, never an extra read -----
def test_an_egress_refusal_pulls_the_badge_at_once(gw: TestClient) -> None:
    who = mint(gw)
    call(gw, "read_file", PLAN, who)
    call(gw, "send_email", LEAK, who)
    deny, pulled = events(gw)[-2:]
    assert (deny["decision"], deny["rule"]) == ("deny", "egress")
    assert (pulled["decision"], pulled["tool"], pulled["rule"]) == ("revoked", "admin", "admin")
    assert pulled["agent"] == "drill-bot" and pulled["args_summary"] == "quarantine: 1 refused call (egress)"
    assert pulled["reason"] == PULLED
    assert pulled["reason"].startswith("badge pulled by quarantine")  # the island detects a quarantine by this phrase
    assert (pulled["run_id"], pulled["latency_ms"], pulled["ms_since_revoke"]) == ("run-test", 0, None)
    assert badge(gw, "drill-bot")["status"] == "REVOKED" and row(gw)["revoked_by"] == "quarantine"
    assert counted(gw) == 0  # a leak is never one of the counted refusals: it already pulled the badge
    assert check_events(events(gw), strict=True) == []


def test_the_next_call_is_refused_status_revoked(gw: TestClient) -> None:
    who = mint(gw)
    ran = tool_runs(gw)
    call(gw, "send_email", LEAK, who)
    text = call(gw, "read_file", READ, who)["content"][0]["text"]
    assert text.startswith("DENIED: badge REVOKED at ") and text.endswith("[rule: status-revoked]")
    assert "by quarantine (token: signature OK, expires in" in text
    assert events(gw)[-1]["ms_since_revoke"] is None  # a quarantine starts no revoke clock
    for _ in range(2):  # the drill insists: status refusals, no second quarantine, the tool never runs
        assert call(gw, "send_email", LEAK, who)["content"][0]["text"].endswith("[rule: status-revoked]")
    assert [e["args_summary"] for e in revokes(gw)] == ["quarantine: 1 refused call (egress)"] and ran == []
    assert gw.post("/agents/drill-bot/restore", headers=ADMIN).json()["status"] == "ACTIVE"  # RESTORE as for any revoke
    assert call(gw, "send_email", MEMO, who)["isError"] is False and ran == ["send_email"]


def test_still_one_badge_read_per_decided_call() -> None:
    c = make()
    who = mint(c)
    registry = c.app.state.handler.registry  # type: ignore[attr-defined]
    counts = {"get": 0, "list_agents": 0, "set_status": 0}
    for name in counts:
        original = getattr(registry, name)

        def wrapped(*args: Any, _name: str = name, _original: Any = original, **kwargs: Any) -> Any:
            counts[_name] += 1
            return _original(*args, **kwargs)

        setattr(registry, name, wrapped)
    send(c, "CEO <ceo@example.corp>", who)
    assert counts == {"get": 1, "list_agents": 0, "set_status": 0}
    send(c, UNCLOSED, who)  # malformed: a refusal, counted in memory; no write
    assert counts == {"get": 2, "list_agents": 0, "set_status": 0}
    call(c, "send_email", LEAK, who)  # the egress check is pure; the pull is one conditional write, no read
    assert counts == {"get": 3, "list_agents": 0, "set_status": 1}
    call(c, "read_file", READ, who)
    assert counts == {"get": 4, "list_agents": 0, "set_status": 1}


def test_the_egress_quarantine_never_overwrites_a_kill(gw: TestClient) -> None:
    """An operator KILL landing between the call's badge read and the quarantine write wins."""
    who = mint(gw)
    registry = gw.app.state.handler.registry  # type: ignore[attr-defined]
    original = registry.get

    def read_then_kill(agent: str) -> Any:
        found = original(agent)  # the call's one read still sees ACTIVE, so it is an egress deny
        registry.set_status(agent, "KILLED", "operator")
        return found

    registry.get = read_then_kill
    assert call(gw, "send_email", LEAK, who)["content"][0]["text"] == DENIED  # the agent still gets its deny
    registry.get = original
    assert badge(gw, "drill-bot")["status"] == "KILLED" and revokes(gw) == []  # the conditional write was refused


def test_a_failed_quarantine_write_still_refuses_and_never_runs_the_tool() -> None:
    c = make()
    who = mint(c)
    ran = tool_runs(c)

    def down(*args: Any) -> None:
        raise RegistryUnavailable("down")

    c.app.state.handler.registry.set_status = down  # type: ignore[attr-defined]
    assert call(c, "send_email", LEAK, who)["content"][0]["text"] == DENIED
    assert ran == [] and revokes(c) == []


def test_quarantine_after_zero_turns_off_only_the_counting_quarantine() -> None:
    c = make(quarantine_after=0)
    who = mint(c)
    for _ in range(4):
        send(c, UNCLOSED, who)  # malformed refusals: the counting quarantine is off
    assert revokes(c) == []
    call(c, "send_email", LEAK, who)  # a leak still pulls the badge
    assert [e["args_summary"] for e in revokes(c)] == ["quarantine: 1 refused call (egress)"]


# ----- the inquest: the egress verdict only for the refusal that pulled the badge -----
def test_the_inquest_names_the_leak() -> None:
    c = make()
    who = mint(c)
    c.post("/runs/run-d/started", json={"agent": "drill-bot", "agent_mode": "model", "pid": 7}, headers=ADMIN)
    call(c, "read_file", PLAN, who)
    call(c, "send_email", LEAK, who)
    report = c.get("/agents/drill-bot/inquest").json()
    assert (report["outcome"], report["tier"], report["run_id"]) == ("quarantined", "diamond", "run-d")
    assert report["calls"] == {"allowed": 1, "refused": 1}
    assert report["refused_by_tool"] == [{"tool": "send_email", "n": 1, "rule": "egress", "home": "mail"}]
    assert report["first_refusal"]["tool"] == "send_email" and report["first_refusal"]["reason"] == REASON
    trigger = report["trigger"]
    assert (trigger["kind"], trigger["by"], trigger["detail"]) == ("quarantine", "gateway", "1 refused call (egress)")
    assert report["chain"] == {"rows": 4, "verified": True}  # run_started, the read, the egress deny, the quarantine
    assert report["verdict"] == VERDICT
    assert report["recommendation"] == RECOMMENDATION
    # the drill insists: two status refusals, each rule on its own line; the verdict is still the leak
    call(c, "send_email", LEAK, who)
    call(c, "send_email", LEAK, who)
    report = c.get("/agents/drill-bot/inquest").json()
    assert report["refused_by_tool"] == [{"tool": "send_email", "n": 1, "rule": "egress", "home": "mail"},
                                         {"tool": "send_email", "n": 2, "rule": "status-revoked", "home": "mail"}]
    assert (report["outcome"], report["verdict"], report["recommendation"]) == ("quarantined", VERDICT, RECOMMENDATION)


def test_an_egress_refusal_outranks_allow_list_and_malformed_refusals_in_the_verdict() -> None:
    c = make()
    who = mint(c, GOLD_BOT)
    c.post("/runs/run-g/started", json={"agent": "gold-bot", "agent_mode": "model", "pid": 8}, headers=ADMIN)
    call(c, "delete_file", {"path": "/drive/okrs.md"}, who)  # not on a Gold badge
    send(c, UNCLOSED, who)                                   # malformed: refused, counted (2 of 3)
    call(c, "send_email", LEAK, who)                         # the leak: pulled at once
    report = c.get("/agents/gold-bot/inquest").json()
    assert report["refused_by_tool"] == [{"tool": "delete_file", "n": 1, "rule": "allow-list", "home": "admin"},
                                         {"tool": "send_email", "n": 2, "rule": "egress", "home": "mail"}]
    assert report["calls"] == {"allowed": 0, "refused": 3}
    assert (report["outcome"], report["verdict"], report["recommendation"]) == ("quarantined", VERDICT, RECOMMENDATION)


def test_malformed_refusals_alone_keep_the_normal_verdict() -> None:
    c = make()
    who = mint(c)
    c.post("/runs/run-m/started", json={"agent": "drill-bot", "agent_mode": "model", "pid": 9}, headers=ADMIN)
    # a malformed `to` that spells the leak's words: still not the refusal that pulled the badge
    spoof = "x refused: outside the company (only @example.corp)"
    send(c, spoof, who)
    report = c.get("/agents/drill-bot/inquest").json()
    assert (report["outcome"], report["trigger"]) == ("active", None)
    assert report["calls"] == {"allowed": 0, "refused": 1}
    assert report["refused_by_tool"] == [{"tool": "send_email", "n": 1, "rule": "egress", "home": "mail"}]
    assert report["first_refusal"]["reason"] == invalid(spoof)
    assert (report["verdict"], report["recommendation"]) == (CLEAN, "Nothing to do.")  # the normal logic


def test_a_quarantine_by_three_malformed_addresses_says_the_gateway_pulled_the_badge(gw: TestClient) -> None:
    who = mint(gw)
    gw.post("/runs/run-q/started", json={"agent": "drill-bot", "agent_mode": "model", "pid": 10}, headers=ADMIN)
    for to in (UNCLOSED, "ceo@", ""):  # three malformed in the minute: the counting quarantine pulls the badge
        send(gw, to, who)
    report = gw.get("/agents/drill-bot/inquest").json()
    assert report["outcome"] == "quarantined"
    assert (report["trigger"]["kind"], report["trigger"]["by"]) == ("quarantine", "gateway")
    assert anysecs(report["trigger"]["detail"]) == "3 refused calls in N s"
    assert report["calls"] == {"allowed": 0, "refused": 3}
    assert report["refused_by_tool"] == [{"tool": "send_email", "n": 3, "rule": "egress", "home": "mail"}]
    # no leak, no allow-list refusal, no REVOKE: the gateway's own line, never the operator's
    assert report["verdict"] == GATEWAY_PULLED
    assert report["recommendation"] == "Keep the badge at Diamond. Restore only after the task is fixed."  # as before
    # once RESTORE makes the outcome active again, the normal line is back
    assert gw.post("/agents/drill-bot/restore", headers=ADMIN).json()["status"] == "ACTIVE"
    report = gw.get("/agents/drill-bot/inquest").json()
    assert (report["outcome"], report["verdict"]) == ("active", CLEAN)
    assert report["recommendation"] == "Nothing to do."


@pytest.mark.parametrize("to", ["partner@rival.example", None, "a refused: outside the company",
                                "x" * 60 + " refused: outside the company", "evil\n@rival.example", "(only @x)",
                                "x" * 70 + "@rival.example", "ceo@example.corp, " * 4 + "partner@rival.example"])
@pytest.mark.parametrize("leak", [True, False])
def test_the_inquest_reads_back_exactly_what_the_gateway_wrote(to: object, leak: bool) -> None:
    domains = ("example.corp", "partner.example")
    reason = egress_reason(to, domains, outside=leak)
    assert egress_target(reason) == address_label(to, domains)
    assert is_leak(reason) is leak  # only the gateway's own words after the `to` decide it


# ----- V2: a long `to` keeps its destination domain in the audit trail -----
@pytest.mark.parametrize("to, shown", [
    ("x" * 70 + "@rival.example", "x" * 49 + "…@rival.example"),                    # local part cut, domain kept
    ("Partner <" + "p" * 70 + "@rival.example>", "p" * 49 + "…@rival.example"),   # the address inside the brackets
    ("A very long display name that goes on and on <partner@rival.example>", "partner@rival.example"),
    ("a@" + "b" * 80 + ".rival.example", "a@…" + ("b" * 80 + ".rival.example")[-47:]),  # a huge domain keeps its end
    ("x" * 70 + "@" + "b" * 80 + ".rival.example",
     "x" * 14 + "…@…" + ("b" * 80 + ".rival.example")[-47:]),                       # both: still exactly 64
    ("ceo@example.corp; " + "y" * 60 + "@rival.example, cfo@example.corp",
     "y" * 39 + "…@rival.example (+2 more)"),                                       # the outside one, its domain kept
])
def test_a_long_outside_to_keeps_the_destination_domain(to: str, shown: str) -> None:
    assert recipient_class(to, ["example.corp"]) == OUTSIDE
    label = address_label(to)
    assert label == shown and len(label) <= 64
    c = make()
    who = mint(c)
    assert send(c, to, who)["content"][0]["text"] == f"DENIED: {outside(shown)} [rule: egress]"
    assert revokes(c)[-1]["reason"] == (
        f"badge pulled by quarantine after an attempt to send company data outside ({shown})")


@pytest.mark.parametrize("to, shown", [
    ("ceo@example.corp, " * 3 + "x" * 40 + "@@rival.example", "x" * 39 + "…@rival.example (+3 more)"),  # malformed
    ("z" * 100, "z" * 63 + "…"),                                                     # no "@": cut at the end
])
def test_a_long_malformed_to_shows_the_part_that_is_wrong(to: str, shown: str) -> None:
    assert recipient_class(to, ["example.corp"]) == INVALID
    assert address_label(to) == shown
    c = make()
    assert send(c, to, mint(c))["content"][0]["text"] == f"DENIED: {invalid(shown)} [rule: egress]"


# ----- the contract -----
def test_validate_fixture_knows_rule_egress() -> None:
    c = make()
    who = mint(c)
    send(c, UNCLOSED, who)
    call(c, "send_email", LEAK, who)
    chain = events(c)
    assert [e["rule"] for e in chain[-3:]] == ["egress", "egress", "admin"]
    assert check_events(chain, strict=True) == []
    deny = {**chain[-2], "seq": 1, "prev_hash": "genesis"}
    assert check_events([deny], strict=False) == []
    assert check_events([{**deny, "tool": "read_file"}], strict=False) == [
        "seq 1: rule egress is only for a deny of send_email"]
    assert check_events([{**deny, "decision": "allow"}], strict=False) == [
        "seq 1: rule egress is only for a deny of send_email"]
