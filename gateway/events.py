"""The event log: every decision as a record in a SHA-256 hash chain, numbered by seq.
MemoryEventLog keeps the chain in memory (plus a JSONL file); DynamoEventLog also writes a best-effort durable copy to table mytopia_events from a background thread."""

import hashlib
import json
import queue
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from gateway.registry import dynamo_client, now_iso

EVENT_DEFAULTS: dict[str, Any] = {
    "run_id": "run-unknown", "agent": "unknown", "agent_mode": "model", "tool": "tools/list",
    "args_summary": "", "decision": "deny", "rule": "token", "reason": "", "latency_ms": 0,
    "ms_since_revoke": None,
}
PAGE_SIZE = 200
RESET_MARKER = "reset"         # JSONL line {"pk": <new chain id>, "marker": "reset"}: not an event, only "a new chain starts here"
WRITE_RETRIES = 3              # extra attempts per durable write, after the first one
RETRY_BACKOFF_S = 0.2          # doubled after each failed attempt: 0.2, 0.4, 0.8 s


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
    """Read the JSONL twin and return the newest chain id with its records, or a fresh chain if there is none.
    A reset marker line starts an empty chain, so a restart after /demo/reset does not bring the old chain back."""
    chain, records = None, []
    if jsonl_path is not None and jsonl_path.is_file():
        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue  # a half-written last line is skipped
            if row.get("marker") == RESET_MARKER:
                chain, records = row.get("pk"), []
                continue
            if row.get("pk") != chain:
                chain, records = row.get("pk"), []
            records.append({k: v for k, v in row.items() if k != "pk"})
    if chain is None:
        return new_chain_id(None), []
    if not verify_chain(records):  # verified once, at startup
        print(f"events: chain {chain} in {jsonl_path} does not verify; starting a new chain", file=sys.stderr)
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
            # inside the lock: two concurrent calls must reach the JSONL twin and the durable queue in seq order
            self._write_jsonl({"pk": self.chain, **record})
            self._store_durable(self.chain, record)
        return dict(record)

    def since(self, seq: int) -> list[dict]:
        """Records with seq greater than the given seq, ascending, at most 200."""
        with self._lock:
            return [dict(r) for r in self._records[max(seq, 0):max(seq, 0) + PAGE_SIZE]]

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._records]

    def reset(self) -> str:
        """Start a new chain: new id, counter back to 0, memory cleared, a marker in the JSONL; returns the chain id."""
        with self._lock:
            self.chain = new_chain_id(self.chain)
            self._records = []
            self._write_jsonl({"pk": self.chain, "marker": RESET_MARKER})
            return self.chain

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until every record has reached its durable copy; the memory log has none, so it is always done."""
        return True

    def _write_jsonl(self, line: dict) -> None:
        if self._jsonl_path is None:
            return
        try:
            self._jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            with self._jsonl_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line) + "\n")
        except OSError as exc:
            print(f"events: JSONL write failed: {exc}", file=sys.stderr)

    def _store_durable(self, chain: str, record: dict) -> None:
        """Hook for the DynamoDB copy; the memory log has none."""


class DynamoEventLog(MemoryEventLog):
    """The memory log plus a PutItem of each record into mytopia_events (pk = chain id, sk = seq).
    The PutItem runs on one daemon writer thread fed by a FIFO queue, so a 79 ms write never delays a decision;
    a single consumer keeps the writes in seq order."""

    def __init__(self, table_name: str, session: Any, jsonl_path: Path | None = None) -> None:
        from boto3.dynamodb.types import TypeSerializer

        self.table_name = table_name
        self._to_dynamo = TypeSerializer().serialize
        self._queue: queue.Queue = queue.Queue()
        self._client = None
        if session is not None:
            try:
                self._client = dynamo_client(session)
            except Exception as exc:  # noqa: BLE001
                print(f"events: DynamoDB setup failed: {type(exc).__name__}", file=sys.stderr)
        super().__init__(jsonl_path)
        threading.Thread(target=self._writer, name="events-writer", daemon=True).start()

    def _store_durable(self, chain: str, record: dict) -> None:
        self._queue.put((chain, dict(record)))  # never blocks: the queue is unbounded

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait up to timeout seconds for the writer to finish everything queued; True when it did."""
        with self._queue.all_tasks_done:
            return self._queue.all_tasks_done.wait_for(lambda: self._queue.unfinished_tasks == 0, timeout)

    def _writer(self) -> None:
        """The single consumer: one record at a time, in the order they were appended."""
        while True:
            chain, record = self._queue.get()
            try:
                self._put(chain, record)
            except Exception as exc:  # noqa: BLE001 - one bad record (say, a value DynamoDB cannot hold) must not end the thread
                print(f"events: seq {record.get('seq')} not copied to DynamoDB: {type(exc).__name__}", file=sys.stderr)
            finally:
                self._queue.task_done()

    def _put(self, chain: str, record: dict) -> None:
        """PutItem with retries and backoff; a failure is printed once per record and never raised."""
        if self._client is None:
            print(f"events: no DynamoDB table, seq {record['seq']} kept in memory only", file=sys.stderr)
            return
        item = {k: self._to_dynamo(v) for k, v in {"pk": chain, **record}.items()}
        delay, error = RETRY_BACKOFF_S, ""
        for attempt in range(1 + WRITE_RETRIES):
            try:
                self._client.put_item(TableName=self.table_name, Item=item,
                                      ConditionExpression="attribute_not_exists(seq)")
                return
            except Exception as exc:  # noqa: BLE001 - a failed durable write never blocks the response
                code = getattr(exc, "response", {}).get("Error", {}).get("Code", type(exc).__name__)
                if code == "ConditionalCheckFailedException":
                    # usually our own earlier attempt that landed after its timeout; say so, never overwrite
                    print(f"events: seq {record['seq']} was already in DynamoDB; kept the stored copy", file=sys.stderr)
                    return
                error = code
            if attempt < WRITE_RETRIES:
                time.sleep(delay)
                delay *= 2
        print(f"events: DynamoDB write of seq {record['seq']} failed after {1 + WRITE_RETRIES} attempts: {error}",
              file=sys.stderr)
