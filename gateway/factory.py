"""The Factory: mint an agent (identity + badge row + the launcher's env lines), grant or pull one tool, change its tier,
retire it, and the deterministic inquest of its latest run (docs/BUILD3.md sections 2 and 2.4).
Every write runs under one lock, so this process is the only writer of a badge's tools and tier at any moment; the
decision path (gateway/mcp.py) never comes through here and still reads the badge once per call."""

import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

from gateway.events import verify_chain
from gateway.identity import IdentityError
from gateway.mcp import MAX_LABEL_CHARS, TOOL_NAMES, iso_to_ms
from gateway.registry import AgentExists, now_iso
from gateway.tiers import ROBOT_COLORS, TIERS, above_ceiling, ceiling, infer_tier

AGENT_ID = re.compile(r"^[a-z][a-z0-9-]{2,23}$")
MAX_NAME_CHARS = 24
MAX_ROLE_CHARS = 60
PUBLIC_KEYS = ("agent", "name", "client_id", "status", "allowed_tools", "color", "tier", "role", "made_by",
               "created_at")   # never a secret: rows hold none, and only these keys leave the gateway
ENV_HEADER = "# minted by the Factory"
HOME = {"read_file": "files", "search_files": "files", "create_issue": "github", "list_issues": "github",
        "send_email": "mail", "delete_file": "admin"}
TOOL_ACTIONS = {"revoke": ("revoked", "pulled from", "already off"),
                "restore": ("restored", "returned to", "already on")}


class FactoryError(Exception):
    """A refused Factory request: the HTTP status and the JSON body to answer with. Nothing was written."""

    def __init__(self, status: int, body: dict) -> None:
        super().__init__(body.get("error", ""))
        self.status = status
        self.body = body


def refuse(status: int, sentence: str, **extra: Any) -> FactoryError:
    return FactoryError(status, {"error": sentence, **extra})


def plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def tier_of(row: dict) -> str:
    """The row's tier; a row written before tiers existed gets the lowest tier that holds its tools."""
    tier = row.get("tier")
    return tier if tier in TIERS else infer_tier(list(row.get("allowed_tools") or []))


def tier_name(tier: str) -> str:
    return TIERS.get(tier, {}).get("name", tier.title())


def catalog_order(tools: list[str]) -> list[str]:
    """Duplicates dropped, the catalog's order (unknown names, if a row was hand-edited, go last)."""
    return sorted(set(tools), key=lambda t: TOOL_NAMES.index(t) if t in TOOL_NAMES else len(TOOL_NAMES))


def public_row(row: dict) -> dict:
    """A badge as GET /agents shows it: the stored keys, the tier (inferred if missing) and its ceiling."""
    out = {k: row.get(k) for k in PUBLIC_KEYS}
    out["tier"] = tier_of(row)
    out["ceiling"] = ceiling(out["tier"])
    out["made_by"] = row.get("made_by") or "seed"
    return out


# ----- the launcher's env file -----
def env_key(agent_id: str, suffix: str) -> str:
    """billing-bot + CLIENT_ID -> BILLING_BOT_CLIENT_ID (the launcher's own rule, launcher/run.py env_key)."""
    return agent_id.upper().replace("-", "_") + "_" + suffix


def env_keys(agent_id: str) -> tuple[str, str]:
    return env_key(agent_id, "CLIENT_ID"), env_key(agent_id, "CLIENT_SECRET")


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []


def write_lines(path: Path, lines: list[str]) -> None:
    """Replace the file through a temp file, so the launcher never reads half of it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".factory-tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows refuses a replace while another process has the file open
            if attempt == 19:
                raise
            time.sleep(0.05)


def without_agent(lines: list[str], agent_id: str) -> list[str]:
    keys = env_keys(agent_id)
    return [line for line in lines if line.split("=", 1)[0].strip() not in keys]


def add_env_lines(path: Path, agent_id: str, client_id: str, secret: str) -> None:
    """Append <ENV>_CLIENT_ID and <ENV>_CLIENT_SECRET under the "# minted by the Factory" line (replacing old ones)."""
    lines = without_agent(read_lines(path), agent_id)
    if ENV_HEADER not in lines:
        lines.append(ENV_HEADER)
    id_key, secret_key = env_keys(agent_id)
    write_lines(path, [*lines, f"{id_key}={client_id}", f"{secret_key}={secret}"])


def remove_env_lines(path: Path, agent_id: str) -> None:
    lines = read_lines(path)
    kept = without_agent(lines, agent_id)
    if kept != lines:
        write_lines(path, kept)


# ----- the Factory -----
class Factory:
    """Mint, grant/pull, tier, retire and inquest, on the handler's registry, event log and client map."""

    def __init__(self, settings: Any, handler: Any, identity: Any) -> None:
        self.settings = settings
        self.handler = handler
        self.registry = handler.registry
        self.events = handler.events
        self.identity = identity
        self.lock = threading.Lock()   # one writer of rows, tools and tiers at a time (besides /demo/reset)

    def log(self, agent: str, decision: str, args_summary: str, reason: str, rule: str = "factory",
            tool: str = "admin") -> dict:
        run_id = self.handler.latest_run(agent)
        return self.handler.log(run_id=run_id, agent=agent, agent_mode=self.handler.agent_mode(run_id), tool=tool,
                                args_summary=args_summary[:120], decision=decision, rule=rule, reason=reason,
                                latency_ms=0)

    def row_or_404(self, agent: str) -> dict:
        row = self.registry.get(agent)
        if row is None:
            raise refuse(404, f"unknown agent {agent[:MAX_LABEL_CHARS]}")
        return row

    # ----- mint -----
    def validate(self, body: dict) -> dict:
        """The mint form's rules; returns the clean fields or raises a 400 with one plain sentence."""
        agent, name, tier = body.get("agent"), body.get("name"), body.get("tier")
        tools, color, role = body.get("tools"), body.get("color"), body.get("role", "")
        if not isinstance(agent, str) or not AGENT_ID.match(agent):
            raise refuse(400, "agent must be 3 to 24 characters: a lowercase letter, then lowercase letters, "
                              "digits or dashes")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= MAX_NAME_CHARS:
            raise refuse(400, f"name must be 1 to {MAX_NAME_CHARS} characters")
        if tier not in TIERS:
            raise refuse(400, "tier must be one of bronze, silver, gold, diamond")
        if not isinstance(tools, list) or not tools or not all(isinstance(t, str) for t in tools):
            raise refuse(400, "tools must be a non-empty list of tool names")
        unknown = [t for t in tools if t not in TOOL_NAMES]
        if unknown:
            raise refuse(400, f"{unknown[0][:MAX_LABEL_CHARS]} is not one of the six tools")
        too_high = above_ceiling(tier, catalog_order(tools))
        if too_high:
            raise refuse(400, f"{too_high[0]} is above the {tier_name(tier)} ceiling", tier=tier,
                         ceiling=ceiling(tier))
        if color not in ROBOT_COLORS:
            raise refuse(400, "color must be one of " + ", ".join(ROBOT_COLORS))
        if not isinstance(role, str) or len(role.strip()) > MAX_ROLE_CHARS:
            raise refuse(400, f"role must be at most {MAX_ROLE_CHARS} characters")
        return {"agent": agent, "name": name.strip(), "tier": tier, "allowed_tools": catalog_order(tools),
                "color": color, "role": role.strip()}

    def mint(self, body: dict) -> dict:
        """Identity first, then the row (attribute_not_exists), then the env lines, then the map, then `created`.
        Any failure after the identity exists deletes it again: nothing is left half-made."""
        fields = self.validate(body)
        agent = fields["agent"]
        with self.lock:
            if self.registry.get(agent) is not None:
                raise refuse(409, f"agent {agent} already exists")
            try:
                client_id, secret = self.identity.create(agent)
            except IdentityError as exc:
                print(f"factory: identity for {agent} not created: {exc}", file=sys.stderr)
                raise refuse(503, "identity provider unavailable: no agent was created") from None
            now = now_iso()
            row = {**fields, "client_id": client_id, "status": "ACTIVE", "made_by": "factory", "created_at": now,
                   "updated_at": now, "revoked_at": None, "revoked_by": None}
            try:
                self.registry.put(row)
            except AgentExists:
                self.identity.delete(client_id)
                raise refuse(409, f"agent {agent} already exists") from None
            except Exception:
                self.identity.delete(client_id)
                raise  # RegistryUnavailable -> 503 in app.py
            try:
                if self.settings.agent_env is not None:
                    add_env_lines(Path(self.settings.agent_env), agent, client_id, secret)
            except OSError as exc:
                print(f"factory: env file not written for {agent}: {type(exc).__name__}", file=sys.stderr)
                self.undo_mint(agent, client_id)
                raise refuse(503, "could not write the launcher's env file: no agent was created") from None
            self.handler.agent_by_client[client_id] = agent  # the map knows the new client before any token arrives
        event = self.log(agent, "created",
                         f"tier={fields['tier']} tools={','.join(fields['allowed_tools'])} color={fields['color']}",
                         f"minted by the Factory: {tier_name(fields['tier'])} badge, "
                         f"{plural(len(fields['allowed_tools']), 'tool')}, client {client_id[:8]}")
        return {"row": public_row(row), "event": event}

    def undo_mint(self, agent: str, client_id: str) -> None:
        try:
            self.registry.delete(agent)
        except Exception as exc:  # noqa: BLE001 - best effort: the row names a client that is deleted next
            print(f"factory: rollback of row {agent} failed: {type(exc).__name__}", file=sys.stderr)
        self.identity.delete(client_id)

    # ----- one tool: pull or grant -----
    def change_tools(self, agent: str, tool: str, action: str) -> tuple[dict | None, bool]:
        """Read the badge and, unless it already says what was asked, write the new tool list: (row, changed).
        A grant above the tier's ceiling raises a 403 and writes nothing (and logs nothing)."""
        with self.lock:
            row = self.registry.get(agent)
            current = list((row or {}).get("allowed_tools") or [])
            if row is None or (tool in current) == (action == "restore"):
                return row, False
            if action == "revoke":
                return self.registry.set_tools(agent, [t for t in current if t != tool], "operator"), True
            tier = tier_of(row)
            if tool not in ceiling(tier):
                raise refuse(403, f"{tool} is above the {tier_name(tier)} ceiling", tier=tier, ceiling=ceiling(tier))
            return self.registry.set_tools(agent, catalog_order([*current, tool]), "operator"), True

    # ----- tier -----
    def change_tier(self, agent: str, body: dict) -> dict:
        """Promote or demote; a demotion trims the badge to the new ceiling in the same write."""
        tier = body.get("tier")
        if tier not in TIERS:
            raise refuse(400, "tier must be one of bronze, silver, gold, diamond")
        with self.lock:
            row = self.row_or_404(agent)
            was = tier_of(row)
            current = list(row.get("allowed_tools") or [])
            if tier == was:
                if row.get("tier") != tier:  # a row from before tiers: write the inferred tier, quietly
                    self.registry.set_tier(agent, tier, current, "operator")
                return {"agent": agent, "tier": tier, "was": was, "allowed_tools": current, "ceiling": ceiling(tier),
                        "trimmed": [], "status": row.get("status"), "changed": False, "seq": None,
                        "note": f"{agent} is already {tier_name(tier)}; nothing changed, nothing logged"}
            trimmed = above_ceiling(tier, current)
            kept = [t for t in current if t not in trimmed]
            new_row = self.registry.set_tier(agent, tier, kept, "operator")
        for tool in trimmed:  # the operator took these off: their refusals never count toward quarantine
            self.handler.pulled.add((agent, tool))
        name = row.get("name") or agent
        if TIERS[tier]["rank"] >= TIERS[was]["rank"]:
            reason = f"{name} promoted to {tier_name(tier)} by operator"
        else:
            reason = f"{name} demoted to {tier_name(tier)} by operator"
            if trimmed:
                reason += f" ({plural(len(trimmed), 'tool')} trimmed)"
        event = self.log(agent, "tier_changed", f"tier={tier} was={was} badge={','.join(kept)}", reason)
        return {"agent": agent, "tier": tier, "was": was, "allowed_tools": kept, "ceiling": ceiling(tier),
                "trimmed": trimmed, "status": new_row.get("status"), "changed": True, "seq": event["seq"]}

    # ----- retire -----
    def retire(self, agent: str) -> dict:
        """Factory-made agents only: identity deleted (best effort), row deleted, map entry and env lines gone."""
        with self.lock:
            row = self.row_or_404(agent)
            if row.get("made_by") != "factory":
                raise refuse(409, f"{agent} is a seed agent; only agents the Factory made can be retired")
            client_id = str(row.get("client_id") or "")
            deleted = self.identity.delete(client_id) if client_id else True
            self.registry.delete(agent)
            self.forget(agent, client_id)
        reason = "retired by operator: identity deleted, badge row removed" if deleted else \
            "retired by operator: badge row removed (identity delete failed, see the gateway log)"
        event = self.log(agent, "retired", f"made_by=factory client={client_id[:8]}", reason)
        return {"agent": agent, "retired": True, "identity_deleted": deleted, "seq": event["seq"], "event": event}

    def forget(self, agent: str, client_id: str) -> None:
        """Drop everything this process remembers about a retired agent (map entry, clocks, counts, env lines)."""
        if client_id:
            self.handler.forget(client_id)
        self.handler.refusals.pop(agent, None)
        self.handler.revoked_at_ms.pop(agent, None)
        self.handler.drop_tool_clocks(agent)
        self.handler.pulled -= {key for key in self.handler.pulled if key[0] == agent}
        if self.settings.agent_env is not None:
            try:
                remove_env_lines(Path(self.settings.agent_env), agent)
            except OSError as exc:
                print(f"factory: env lines of {agent} not removed: {type(exc).__name__}", file=sys.stderr)

    def retire_all(self) -> int:
        """For /demo/reset: delete every Factory-made identity and forget it (best effort, no events: the chain is
        about to start over). The rows themselves are deleted by registry.reset(). Returns how many there were."""
        try:
            rows = [row for row in self.registry.all_rows() if row.get("made_by") == "factory"]
        except Exception as exc:  # noqa: BLE001 - reset carries on; registry.reset() reports the outage
            print(f"factory: could not list the Factory's agents for reset: {type(exc).__name__}", file=sys.stderr)
            return 0
        with self.lock:
            for row in rows:
                client_id = str(row.get("client_id") or "")
                if client_id:
                    self.identity.delete(client_id)
                self.forget(row["agent"], client_id)
        return len(rows)

    # ----- the inquest -----
    def inquest(self, agent: str) -> dict:
        """The deterministic report of the agent's latest run, computed from the chain in memory."""
        row = self.registry.get(agent)
        chain = self.events.all()
        mine = [e for e in chain if e.get("agent") == agent]
        if row is None and not mine:
            raise refuse(404, f"unknown agent {agent[:MAX_LABEL_CHARS]}")
        return inquest_report(agent, row, mine, verify_chain(chain))


def latest_run_rows(rows: list[dict]) -> tuple[str | None, list[dict]]:
    """The newest run's id and this agent's rows from its run_started on (admin rows included)."""
    starts = [e for e in rows if e.get("decision") == "run_started"]
    if not starts:
        return (rows[-1].get("run_id") if rows else None), rows
    start = starts[-1]
    return start.get("run_id"), [e for e in rows if e["seq"] >= start["seq"]]


def outcome_of(rows: list[dict], status: str | None) -> str:
    """active | revoked | quarantined | killed | ended: the last thing that happened to the badge or the run."""
    outcome = {"REVOKED": "revoked", "KILLED": "killed"}.get(status or "", "active")  # the run's rows override it
    for e in rows:
        decision, whole = e.get("decision"), e.get("tool") == "admin"
        if decision == "revoked" and whole:
            outcome = "quarantined" if str(e.get("args_summary", "")).startswith("quarantine:") else "revoked"
        elif decision == "restored" and whole:
            outcome = "active"
        elif decision == "kill_requested":
            outcome = "killed"
        elif decision == "run_stopped":
            if "killed" in str(e.get("reason", "")):
                outcome = "killed"
            elif outcome == "active":
                outcome = "ended"
    return outcome


def trigger_of(rows: list[dict]) -> dict | None:
    """The last whole-badge revoke or kill of the run: who did it, when, and why."""
    trigger = None
    for e in rows:
        if e.get("decision") == "revoked" and e.get("tool") == "admin":
            summary = str(e.get("args_summary", ""))
            if summary.startswith("quarantine:"):
                trigger = {"kind": "quarantine", "ts": e["ts"], "by": "gateway",
                           "detail": summary.removeprefix("quarantine:").strip()}
            else:
                trigger = {"kind": "revoke", "ts": e["ts"], "by": "operator", "detail": e.get("reason", "")}
        elif e.get("decision") == "kill_requested":
            trigger = {"kind": "kill", "ts": e["ts"], "by": "operator", "detail": e.get("reason", "")}
    return trigger


def timings_of(rows: list[dict]) -> dict:
    """revoke-to-first-deny (the first ms_since_revoke), kill-to-stopped (kill_requested ts to run_stopped ts) and the
    median gateway decision time of the six tools (the lower middle value); None where not measured."""
    revoke = next((e["ms_since_revoke"] for e in rows if e.get("ms_since_revoke") is not None), None)
    kill = None
    kills = [e for e in rows if e.get("decision") == "kill_requested"]
    if kills:
        stop = next((e for e in rows if e.get("decision") == "run_stopped" and e["seq"] > kills[-1]["seq"]), None)
        start_ms, stop_ms = iso_to_ms(kills[-1].get("ts")), iso_to_ms(stop.get("ts")) if stop else None
        if start_ms is not None and stop_ms is not None:
            kill = stop_ms - start_ms
    latencies = sorted(e["latency_ms"] for e in rows
                       if e.get("decision") in ("allow", "deny") and e.get("tool") in TOOL_NAMES)
    p50 = latencies[(len(latencies) - 1) // 2] if latencies else None
    return {"revoke_to_first_deny_ms": revoke, "kill_to_stopped_ms": kill, "decision_p50_ms": p50}


def refused_by_tool(rows: list[dict]) -> list[dict]:
    """Refused calls of the six tools grouped by (tool, rule), in the order they first happened."""
    groups: dict[tuple[str, str], int] = {}
    for e in rows:
        if e.get("decision") == "deny" and e.get("tool") in TOOL_NAMES:
            key = (e["tool"], e.get("rule", ""))
            groups[key] = groups.get(key, 0) + 1
    return [{"tool": tool, "n": n, "rule": rule, "home": HOME[tool]} for (tool, rule), n in groups.items()]


def verdict_of(refused: list[dict], rows: list[dict], tier: str, revoke_ms: int | None) -> tuple[str, str | None]:
    """The verdict sentences in the spec's order, and the most-refused allow-list tool (for the recommendation)."""
    badge = [r for r in refused if r["rule"] == "allow-list"]
    worst = max(badge, key=lambda r: r["n"]) if badge else None  # max keeps the first of equal counts
    sentences = []
    if worst:
        sentence = (f"Attempted {worst['tool']} {plural(worst['n'], 'time')}; its {tier_name(tier)} badge does not "
                    f"hold it; the gateway refused every attempt")
        if any(e.get("decision") == "revoked" and str(e.get("args_summary", "")).startswith("quarantine:")
               for e in rows):
            sentence += ", and pulled the badge itself"
        sentences.append(sentence + ".")
    operator_revoke = next((e["seq"] for e in rows if e.get("decision") == "revoked" and e.get("tool") == "admin"
                            and not str(e.get("args_summary", "")).startswith("quarantine:")), None)
    if operator_revoke is not None and any(e.get("decision") == "deny" and e.get("rule") == "status-revoked"
                                           and e["seq"] > operator_revoke for e in rows):
        sentences.append(f"Kept calling after REVOKE: refused within {revoke_ms} ms." if revoke_ms is not None
                         else "Kept calling after REVOKE: every call was refused.")
    if not sentences:
        sentences.append("No badge violations; the run was stopped by the operator.")
    return " ".join(sentences), (worst["tool"] if worst else None)


def recommendation_of(outcome: str, tier: str, tool: str | None) -> str:
    if outcome == "quarantined":
        tail = f"; do not grant {tool}." if tool else "."
        return f"Keep the badge at {tier_name(tier)}. Restore only after the task is fixed{tail}"
    if outcome == "killed":
        return "The identity stays; the next run starts clean."
    if outcome == "revoked":
        return "Restore the badge only after the cause is understood."
    return "Nothing to do."


def inquest_report(agent: str, row: dict | None, mine: list[dict], verified: bool) -> dict:
    """Section 2.4's report from this agent's rows (all of them, oldest first) and the whole chain's verdict."""
    run_id, rows = latest_run_rows(mine)
    tier = tier_of(row) if row else next((e["args_summary"].split()[0].removeprefix("tier=") for e in reversed(mine)
                                          if e.get("decision") in ("created", "tier_changed")), "bronze")
    outcome = outcome_of(rows, (row or {}).get("status"))
    calls = [e for e in rows if e.get("decision") in ("allow", "deny") and e.get("tool") in TOOL_NAMES]
    refused = refused_by_tool(rows)
    first = next((e for e in calls if e["decision"] == "deny"), None)
    timings = timings_of(rows)
    verdict, worst = verdict_of(refused, rows, tier, timings["revoke_to_first_deny_ms"])
    return {
        "agent": agent, "name": (row or {}).get("name") or agent, "tier": tier, "run_id": run_id,
        "client": str((row or {}).get("client_id") or "")[:8] or None,
        "outcome": outcome,
        "calls": {"allowed": sum(1 for e in calls if e["decision"] == "allow"),
                  "refused": sum(1 for e in calls if e["decision"] == "deny")},
        "refused_by_tool": refused,
        "first_refusal": {"tool": first["tool"], "ts": first["ts"], "reason": first["reason"]} if first else None,
        "trigger": trigger_of(rows),
        "timings": timings,
        "chain": {"rows": len(rows), "verified": verified},
        "verdict": verdict,
        "recommendation": recommendation_of(outcome, tier, worst),
    }
