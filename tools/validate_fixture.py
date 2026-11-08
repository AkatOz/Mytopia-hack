"""Checks an event file (default contract/fixture.json) against the contract: required fields, the closed sets, contiguous seq and the prev_hash links.
It prints every violation to stderr and a one-line verdict to stdout, and exits 1 on any violation (2 if the file cannot be read)."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
FIELDS = ["seq", "ts", "run_id", "agent", "agent_mode", "tool", "args_summary", "decision", "rule",
          "reason", "latency_ms", "ms_since_revoke", "prev_hash", "hash"]
DECISIONS = {"run_started", "allow", "deny", "revoked", "restored", "kill_requested", "run_stopped",
             "created", "tier_changed", "retired"}
RULES = {"allow-list", "status-revoked", "status-killed", "token", "registry-unavailable",
         "header-mismatch", "egress", "admin", "harness", "factory"}
BADGE_TOOLS = {"read_file", "search_files", "create_issue", "list_issues", "send_email", "delete_file"}
TOOLS = BADGE_TOOLS | {"tools/list", "admin", "harness"}
MODES = {"model", "scripted", "replay"}
ADMIN_DECISIONS = {"revoked", "restored", "kill_requested"}
PER_TOOL_DECISIONS = {"revoked", "restored"}
RUN_DECISIONS = {"run_started", "run_stopped"}
FACTORY_DECISIONS = {"created", "tier_changed", "retired"}  # the Factory: tool admin, rule factory
TS_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def chain_hash(record: dict[str, Any]) -> str:
    """SHA-256 hex of the canonical JSON of the record without its hash field."""
    body = {key: value for key, value in record.items() if key != "hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def check_event(event: dict[str, Any]) -> list[str]:
    """Violations of one event on its own (fields, types, closed sets)."""
    seq = event.get("seq", "?")
    missing = [name for name in FIELDS if name not in event]
    if missing:
        return [f"seq {seq}: missing fields {', '.join(missing)}"]
    problems = []
    if event["decision"] not in DECISIONS:
        problems.append(f"seq {seq}: decision {event['decision']!r} not in the closed set")
    if event["rule"] not in RULES:
        problems.append(f"seq {seq}: rule {event['rule']!r} not in the closed set")
    if event["tool"] not in TOOLS:
        problems.append(f"seq {seq}: tool {event['tool']!r} not in the closed set")
    if event["agent_mode"] not in MODES:
        problems.append(f"seq {seq}: agent_mode {event['agent_mode']!r} not in the closed set")
    # revoked/restored may name one of the six tools: a per-tool badge change (tool admin means the whole badge)
    admin_tools = {"admin"} | (BADGE_TOOLS if event["decision"] in PER_TOOL_DECISIONS else set())
    if event["decision"] in ADMIN_DECISIONS and (event["tool"] not in admin_tools or event["rule"] != "admin"):
        wanted = "tool admin or one of the six tools" if event["decision"] in PER_TOOL_DECISIONS else "tool admin"
        problems.append(f"seq {seq}: {event['decision']} needs {wanted} and rule admin")
    if event["decision"] in RUN_DECISIONS and (event["tool"], event["rule"]) != ("harness", "harness"):
        problems.append(f"seq {seq}: {event['decision']} needs tool harness and rule harness")
    if (event["decision"] in FACTORY_DECISIONS) != (event["rule"] == "factory") or \
            (event["decision"] in FACTORY_DECISIONS and event["tool"] != "admin"):
        problems.append(f"seq {seq}: {event['decision']} with rule {event['rule']}: created, tier_changed and retired "
                        "need tool admin and rule factory, and only they use rule factory")
    if event["rule"] == "egress" and (event["decision"], event["tool"]) != ("deny", "send_email"):
        problems.append(f"seq {seq}: rule egress is only for a deny of send_email")
    if not isinstance(event["seq"], int) or isinstance(event["seq"], bool):
        problems.append(f"seq {seq}: seq is not an integer")
    if not isinstance(event["ts"], str) or not TS_PATTERN.match(event["ts"]):
        problems.append(f"seq {seq}: ts {event['ts']!r} is not UTC ISO 8601 with milliseconds and Z")
    if not isinstance(event["args_summary"], str) or len(event["args_summary"]) > 120:
        problems.append(f"seq {seq}: args_summary must be a string of at most 120 characters")
    if not isinstance(event["latency_ms"], (int, float)) or isinstance(event["latency_ms"], bool):
        problems.append(f"seq {seq}: latency_ms is not a number")
    if event["ms_since_revoke"] is not None and event["decision"] != "deny":
        problems.append(f"seq {seq}: ms_since_revoke is set on a {event['decision']} event")
    for name in ("run_id", "agent", "reason", "prev_hash", "hash"):
        if not isinstance(event[name], str) or not event[name]:
            problems.append(f"seq {seq}: {name} must be a non-empty string")
    return problems


def check_events(events: list[dict[str, Any]], strict: bool) -> list[str]:
    """All violations: each event, then seq contiguity and the chain links (recomputed hashes when strict)."""
    problems: list[str] = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            problems.append(f"item {index}: not an object")
            continue
        problems += check_event(event)
        if index == 0:
            if event.get("seq") != 1:
                problems.append(f"first seq is {event.get('seq')!r}, expected 1")
            if event.get("prev_hash") != "genesis":
                problems.append(f"seq {event.get('seq')}: first prev_hash must be 'genesis'")
        else:
            previous = events[index - 1]
            if not isinstance(previous, dict):
                continue
            if isinstance(previous.get("seq"), int) and event.get("seq") != previous["seq"] + 1:
                problems.append(f"seq {event.get('seq')!r} follows seq {previous['seq']}: not contiguous")
            if event.get("prev_hash") != previous.get("hash"):
                problems.append(f"seq {event.get('seq')}: prev_hash does not equal the hash of seq {previous.get('seq')}")
        if strict and "hash" in event and event["hash"] != chain_hash(event):
            problems.append(f"seq {event.get('seq')}: hash does not match the recomputed SHA-256")
    return problems


def load_events(path: Path) -> list[Any]:
    """Accepts {"events": [...]} (the fixture and GET /events) or a bare list."""
    data = json.loads(path.read_text(encoding="utf-8"))
    events = data.get("events") if isinstance(data, dict) else data
    if not isinstance(events, list):
        raise ValueError("no event list found")
    return events


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate MYTOPIA events against the contract.")
    parser.add_argument("path", nargs="?", type=Path, default=REPO / "contract" / "fixture.json")
    parser.add_argument("--strict", action="store_true", help="also recompute every hash (not for the fixture)")
    args = parser.parse_args()
    try:
        events = load_events(args.path)
    except (OSError, ValueError) as error:
        print(f"FAIL: cannot read {args.path}: {error}")
        return 2
    problems = check_events(events, args.strict)
    for problem in problems:
        print(problem, file=sys.stderr)
    mode = "hashes recomputed" if args.strict else "links checked, hashes not recomputed"
    if problems:
        print(f"FAIL: {args.path.name}: {len(events)} events, {len(problems)} violations ({mode})")
        return 1
    print(f"OK: {args.path.name}: {len(events)} events, seq 1..{len(events)} contiguous, closed sets respected, chain intact ({mode})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
