"""Tests for gateway/decide.py: every rule decide() can return, in the order the spec gives.
The rows are built by hand so these tests need no registry, no token and no network."""

from gateway.decide import decide
from gateway.registry import seed_rows


def research_row(**changes: object) -> dict:
    row = seed_rows()["research-bot"]
    row.update(changes)
    return row


def test_no_row_is_a_token_deny() -> None:
    d = decide(None, "read_file")
    assert (d.ok, d.rule, d.reason) == (False, "token", "client is not a registered agent")


def test_allowed_tool() -> None:
    d = decide(research_row(), "read_file")
    assert (d.ok, d.rule, d.reason) == (True, "allow-list", "read_file is on badge research-bot")


def test_tool_not_on_badge() -> None:
    d = decide(research_row(), "send_email")
    assert (d.ok, d.rule, d.reason) == (False, "allow-list", "send_email is not on badge research-bot")


def test_revoked_beats_allow_list() -> None:
    d = decide(research_row(status="REVOKED", revoked_at="2026-11-08T01:22:25.120Z", revoked_by="operator"),
               "read_file")
    assert (d.ok, d.rule) == (False, "status-revoked")
    assert d.reason == "badge REVOKED at 01:22:25 by operator"


def test_killed_beats_everything() -> None:
    d = decide(research_row(status="KILLED"), "read_file")
    assert (d.ok, d.rule) == (False, "status-killed")


def test_tools_list_allowed_only_when_active() -> None:
    assert decide(research_row(), "tools/list").ok
    assert decide(research_row(), "tools/list").reason == "badge research-bot: 4 tools"
    assert decide(research_row(status="REVOKED", revoked_at=None, revoked_by="x"), "tools/list").rule == "status-revoked"
    assert decide(research_row(status="KILLED"), "tools/list").rule == "status-killed"
    assert decide(research_row(status="KILLED"), "read_file").reason == "badge KILLED by operator; everything refused"
    assert decide(None, "tools/list").rule == "token"


def test_ops_bot_reads_only() -> None:
    ops = seed_rows()["ops-bot"]
    assert decide(ops, "read_file").ok
    assert decide(ops, "create_issue").reason == "create_issue is not on badge ops-bot"
