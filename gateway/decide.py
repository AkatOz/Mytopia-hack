"""The one function that decides whether an agent may use a tool, given its badge row.
Everything else in the gateway only gathers inputs for decide() and records what it returned."""

from dataclasses import dataclass


@dataclass
class Decision:
    """The outcome of one check: ok, the rule that fired, and a sentence a human can read."""

    ok: bool
    rule: str      # allow-list | status-revoked | status-killed | token | registry-unavailable | header-mismatch
    reason: str


def short_time(iso_ts: str | None) -> str:
    """Return the HH:MM:SS part of an ISO timestamp like 2026-11-08T01:22:25.120Z (or the text as is)."""
    if iso_ts and "T" in iso_ts:
        return iso_ts.split("T", 1)[1][:8]
    return str(iso_ts)


def decide(row: dict | None, tool: str) -> Decision:
    """Decide one call; tool is a tool name or "tools/list" (allowed whenever the badge is ACTIVE)."""
    if row is None:
        return Decision(False, "token", "client is not a registered agent")
    agent = row.get("agent", "?")
    status = row.get("status")
    if status == "KILLED":
        return Decision(False, "status-killed", "badge KILLED by operator; everything refused")
    if status == "REVOKED":
        when = short_time(row.get("revoked_at"))
        return Decision(False, "status-revoked", f"badge REVOKED at {when} by {row.get('revoked_by')}")
    if status != "ACTIVE":
        return Decision(False, "status-revoked", f"badge status {status} is not ACTIVE")
    allowed = list(row.get("allowed_tools") or [])
    if tool == "tools/list":
        return Decision(True, "allow-list", f"badge {agent}: {len(allowed)} tools")
    if tool not in allowed:
        return Decision(False, "allow-list", f"{tool} is not on badge {agent}")
    return Decision(True, "allow-list", f"{tool} is on badge {agent}")
