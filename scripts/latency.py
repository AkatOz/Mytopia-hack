"""Decision-latency summary of a MYTOPIA event chain.

Reads GET /events?since_seq=0 from a running gateway (default http://127.0.0.1:8787) or a saved JSON file
(replay/demo.json: {"events": [...]}, or a bare list), and prints count, p50, p95 and max of latency_ms for the
allow rows and the deny rows (deny also split by rule), every ms_since_revoke, and the gap from each
kill_requested to the next run_stopped of the same run.

Percentiles are nearest-rank over the rows (no interpolation). Standard library only.
Usage: python scripts/latency.py [URL_OR_FILE] [--run RUN_ID]
"""

import argparse
import json
import math
import sys
import urllib.request
from datetime import datetime
from pathlib import Path


def load_events(source: str) -> tuple[list[dict], str]:
    """Return (events, label) from a gateway URL or a JSON file."""
    if source.startswith(("http://", "https://")):
        url = source.rstrip("/") + "/events?since_seq=0"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.load(resp)
        label = f"{url} (chain {data.get('chain', '?')})"
    else:
        data = json.loads(Path(source).read_text(encoding="utf-8"))
        label = f"{source}" + (f" (chain {data.get('chain')})" if isinstance(data, dict) and data.get("chain") else "")
    events = data["events"] if isinstance(data, dict) else data
    return list(events), label


def nearest_rank(values: list[int], pct: float) -> int:
    """The nearest-rank percentile of a non-empty list."""
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[rank - 1]


def summary_line(label: str, values: list[int]) -> str:
    """One line: count, p50, p95, max (or a note that there are no rows)."""
    if not values:
        return f"{label:<28} count 0"
    return (f"{label:<28} count {len(values):>3}   p50 {nearest_rank(values, 50):>5} ms   "
            f"p95 {nearest_rank(values, 95):>5} ms   max {max(values):>5} ms")


def parse_ts(ts: str) -> datetime:
    """'2026-11-07T21:40:58.372Z' -> aware datetime."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Latency summary of a MYTOPIA event chain.")
    p.add_argument("source", nargs="?", default="http://127.0.0.1:8787", help="gateway URL or JSON file")
    p.add_argument("--run", default=None, help="only rows of this run_id")
    args = p.parse_args(argv)

    try:
        events, label = load_events(args.source)
    except (OSError, ValueError, KeyError) as e:
        print(f"latency: cannot read {args.source}: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    if args.run:
        events = [e for e in events if e.get("run_id") == args.run]
        label += f", run {args.run}"
    print(f"source: {label}, {len(events)} events")

    allow = [int(e["latency_ms"]) for e in events if e.get("decision") == "allow"]
    deny = [e for e in events if e.get("decision") == "deny"]
    print(summary_line("allow", allow))
    print(summary_line("deny", [int(e["latency_ms"]) for e in deny]))
    for rule in sorted({e.get("rule", "?") for e in deny}):
        print(summary_line(f"  deny, rule {rule}", [int(e["latency_ms"]) for e in deny if e.get("rule") == rule]))

    revokes = [e for e in events if e.get("ms_since_revoke") is not None]
    if revokes:
        for e in revokes:
            print(f"ms_since_revoke              {e['ms_since_revoke']} ms  (seq {e['seq']}, {e.get('tool')}, run {e.get('run_id')})")
    else:
        print("ms_since_revoke              none in this chain")

    gaps = []
    for i, e in enumerate(events):
        if e.get("decision") != "kill_requested":
            continue
        stop = next((s for s in events[i + 1:] if s.get("decision") == "run_stopped"
                     and s.get("run_id") == e.get("run_id")), None)
        if stop is not None:
            ms = int((parse_ts(stop["ts"]) - parse_ts(e["ts"])).total_seconds() * 1000)
            gaps.append(ms)
            print(f"kill to run_stopped          {ms} ms  (seq {e['seq']} -> {stop['seq']}, run {e.get('run_id')}, {stop.get('reason')})")
    if not gaps:
        print("kill to run_stopped          none in this chain")
    return 0


if __name__ == "__main__":
    sys.exit(main())
