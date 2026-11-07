"""The numbers behind GET /stats, computed from the in-memory chain (no AWS call).
Percentiles are nearest-rank, like scripts/latency.py, so the island's strip, the script and this route agree."""

import math
from datetime import datetime


def nearest_rank(values: list[int], pct: float) -> int | None:
    """The nearest-rank percentile of a list, or None when it is empty."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(pct / 100 * len(ordered))) - 1]


def latency_summary(values: list[int]) -> dict:
    """count, p50, p95 and max of a list of latency_ms values."""
    return {"count": len(values), "p50": nearest_rank(values, 50), "p95": nearest_rank(values, 95),
            "max": max(values) if values else None}


def ts_ms(ts: str) -> int:
    """'2026-11-07T21:40:58.372Z' -> epoch milliseconds."""
    return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)


def kill_to_stopped_ms(records: list[dict]) -> list[int]:
    """For each kill_requested, the ms until the next run_stopped of the same run (from the records' ts)."""
    gaps = []
    for i, record in enumerate(records):
        if record.get("decision") != "kill_requested":
            continue
        stop = next((r for r in records[i + 1:] if r.get("decision") == "run_stopped"
                     and r.get("run_id") == record.get("run_id")), None)
        if stop is not None:
            gaps.append(ts_ms(stop["ts"]) - ts_ms(record["ts"]))
    return gaps


def summarize(records: list[dict], chain: str) -> dict:
    """Everything GET /stats returns, from the chain's records."""
    allow = [int(r["latency_ms"]) for r in records if r.get("decision") == "allow"]
    deny = [int(r["latency_ms"]) for r in records if r.get("decision") == "deny"]
    kills = kill_to_stopped_ms(records)
    return {
        "chain": chain,
        "length": len(records),
        "latency_ms": {"allow": latency_summary(allow), "deny": latency_summary(deny),
                       "all": latency_summary(allow + deny)},
        "blocked": len(deny),
        "revoke_to_first_deny_ms": [r["ms_since_revoke"] for r in records if r.get("ms_since_revoke") is not None],
        "kill_to_stopped_ms": kills,
        "last_kill_to_stopped_ms": kills[-1] if kills else None,
    }
