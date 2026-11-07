"""The event log: every decision as a record in a SHA-256 hash chain, numbered by seq.
MemoryEventLog keeps the chain in memory (plus a JSONL file); DynamoEventLog also writes a best-effort durable copy to table mytopia_events."""

import hashlib
import json
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from gateway.registry import now_iso

EVENT_DEFAULTS: dict[str, Any] = {
    "run_id": "run-unknown", "agent": "unknown", "agent_mode": "model", "tool": "tools/list",
    "args_summary": "", "decision": "deny", "rule": "token", "reason": "", "latency_ms": 0,
    "ms_since_revoke": None,
}
PAGE_SIZE = 200


def record_hash(record: dict) -> str:
    """SHA-256 hex of the canonical JSON of the record without its hash field."""
    body = {k: v for k, v in record.items() if k != "hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_chain(records: list[dict]) -> bool:
    """True when every record's hash is right and links to the previous record (first links to genesis)."""
    prev = "genesis"
    for record in records:
        if record.get("prev_hash") != prev or record.get("hash") != record_hash(record):
            return False
        prev = record["hash"]
    return True


def new_chain_id(previous: str | None) -> str:
    """A chain id like chain-20261107T200000Z; a second reset in the same second gets -2, -3, ..."""
    base = "chain-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if previous == base:
        return base + "-2"
    if previous and previous.startswith(base + "-"):
        return f"{base}-{int(previous.rsplit('-', 1)[1]) + 1}"
    return base


def load_last_chain(jsonl_path: Path | None) -> tuple[str, list[dict]]:
    """Read the JSONL twin and return the newest chain id with its records, or a fresh chain if there is none."""
    chain, records = None, []
    if jsonl_path is not None and jsonl_path.is_file():
        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue  # a half-written last line is skipped
            if row.get("pk") != chain:
                chain, records = row.get("pk"), []
            records.append({k: v for k, v in row.items() if k != "pk"})
    if chain is None or not verify_chain(records):
        return new_chain_id(chain), []
    return chain, records


class MemoryEventLog:
    """The authoritative in-memory chain that GET /events serves, mirrored line by line into a JSONL file."""

    def __init__(self, jsonl_path: Path | None = None) -> None:
        self._lock = threading.Lock()
        self._jsonl_path = jsonl_path
        self.chain, self._records = load_last_chain(jsonl_path)  # resume after a restart; seq never goes back

    def append(self, **fields: Any) -> dict:
        """Fill seq, ts, prev_hash and hash, store the record and return it."""
        with self._lock:
            record = {**EVENT_DEFAULTS, **fields}
            record["seq"] = len(self._records) + 1
            record["ts"] = now_iso()
            record["prev_hash"] = self._records[-1]["hash"] if self._records else "genesis"
            record["hash"] = record_hash(record)
            self._records.append(record)
            chain = self.chain
        self._write_jsonl(chain, record)
        self._store_durable(chain, record)
        return dict(record)

    def since(self, seq: int) -> list[dict]:
        """Records with seq greater than the given seq, ascending, at most 200."""
        with self._lock:
            return [dict(r) for r in self._records[max(seq, 0):max(seq, 0) + PAGE_SIZE]]

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._records]

    def reset(self) -> str:
        """Start a new chain: new id, counter back to 0, memory cleared; returns the chain id."""
        with self._lock:
            self.chain = new_chain_id(self.chain)
            self._records = []
            return self.chain

    def _write_jsonl(self, chain: str, record: dict) -> None:
        if self._jsonl_path is None:
            return
        try:
            self._jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            with self._jsonl_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"pk": chain, **record}) + "\n")
        except OSError as exc:
            print(f"events: JSONL write failed: {exc}", file=sys.stderr)

    def _store_durable(self, chain: str, record: dict) -> None:
        """Hook for the DynamoDB copy; the memory log has none."""


class DynamoEventLog(MemoryEventLog):
    """The memory log plus a best-effort PutItem of each record into mytopia_events (pk = chain id, sk = seq)."""

    def __init__(self, table_name: str, session: Any, jsonl_path: Path | None = None) -> None:
        super().__init__(jsonl_path)
        self.table_name = table_name
        self._table = None
        if session is not None:
            try:
                self._table = session.resource("dynamodb").Table(table_name)
            except Exception as exc:  # noqa: BLE001
                print(f"events: DynamoDB setup failed: {type(exc).__name__}", file=sys.stderr)

    def _store_durable(self, chain: str, record: dict) -> None:
        if self._table is None:
            print(f"events: no DynamoDB table, seq {record['seq']} kept in memory only", file=sys.stderr)
            return
        try:
            self._table.put_item(Item={"pk": chain, **record}, ConditionExpression="attribute_not_exists(seq)")
        except Exception as exc:  # noqa: BLE001 - a failed durable write never blocks the response
            print(f"events: DynamoDB write of seq {record['seq']} failed: {type(exc).__name__}", file=sys.stderr)
