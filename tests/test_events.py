"""Tests for gateway/events.py: the hash chain, the since() cursor, reset() and the JSONL twin.
The DynamoDB copy is checked with a fake low-level client: written off the request path, in seq order, retried, never blocking."""

import json
import time
from pathlib import Path

from gateway.events import DynamoEventLog, MemoryEventLog, record_hash, verify_chain


def fill(log: MemoryEventLog, n: int) -> None:
    for i in range(n):
        log.append(agent="research-bot", tool="read_file", decision="allow", rule="allow-list",
                   reason=f"call {i}", args_summary="path=/drive/q3-planning.md")


def test_chain_links_and_verifies() -> None:
    log = MemoryEventLog()
    fill(log, 5)
    records = log.all()
    assert [r["seq"] for r in records] == [1, 2, 3, 4, 5]
    assert records[0]["prev_hash"] == "genesis"
    assert records[1]["prev_hash"] == records[0]["hash"]
    assert all(r["ts"].endswith("Z") and len(r["ts"]) == 24 for r in records)
    assert verify_chain(records)


def test_hash_is_canonical_json_without_hash() -> None:
    log = MemoryEventLog()
    record = log.append(agent="ops-bot", tool="read_file", decision="allow", rule="allow-list")
    import hashlib
    body = {k: v for k, v in record.items() if k != "hash"}
    expected = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert record["hash"] == expected == record_hash(record)


def test_tampering_breaks_the_chain() -> None:
    log = MemoryEventLog()
    fill(log, 3)
    records = log.all()
    records[1]["decision"] = "deny"
    assert not verify_chain(records)


def test_record_has_every_contract_field() -> None:
    record = MemoryEventLog().append(decision="deny", rule="token")
    for key in ("seq", "ts", "run_id", "agent", "agent_mode", "tool", "args_summary", "decision", "rule",
                "reason", "latency_ms", "ms_since_revoke", "prev_hash", "hash"):
        assert key in record
    assert record["ms_since_revoke"] is None


def test_since_is_a_cursor_capped_at_200() -> None:
    log = MemoryEventLog()
    fill(log, 250)
    assert [r["seq"] for r in log.since(247)] == [248, 249, 250]
    page = log.since(0)
    assert len(page) == 200 and page[0]["seq"] == 1 and page[-1]["seq"] == 200
    assert log.since(250) == []


def test_reset_starts_a_new_chain() -> None:
    log = MemoryEventLog()
    fill(log, 3)
    old_chain = log.chain
    new_chain = log.reset()
    assert new_chain != old_chain and new_chain.startswith("chain-")
    assert log.all() == []
    first = log.append(decision="allow", rule="allow-list")
    assert first["seq"] == 1 and first["prev_hash"] == "genesis"
    assert log.reset() != new_chain


def test_jsonl_twin(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    log = MemoryEventLog(path)
    fill(log, 2)
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [line["seq"] for line in lines] == [1, 2]
    assert lines[0]["pk"] == log.chain


class FakeDynamo:
    """Stands in for session.client('dynamodb'): records put_item calls, optionally failing the first few."""

    def __init__(self, fail_first: int = 0, delay_s: float = 0.0) -> None:
        self.items: list[dict] = []
        self.calls = 0
        self.fail_first = fail_first
        self.delay_s = delay_s

    def put_item(self, **kwargs: object) -> None:
        self.calls += 1
        time.sleep(self.delay_s)
        if self.calls <= self.fail_first:
            raise RuntimeError("ProvisionedThroughputExceeded")
        assert kwargs["ConditionExpression"] == "attribute_not_exists(seq)"
        self.items.append(kwargs["Item"])  # type: ignore[arg-type]


class FakeSession:
    def __init__(self, dynamo: FakeDynamo) -> None:
        self.dynamo = dynamo

    def client(self, name: str, config: object = None) -> FakeDynamo:
        assert name == "dynamodb" and config is not None  # always the short-timeout config
        return self.dynamo


def test_dynamo_failure_never_blocks(monkeypatch: object) -> None:
    import gateway.events as events_module
    monkeypatch.setattr(events_module, "RETRY_BACKOFF_S", 0.001)  # type: ignore[attr-defined]
    dynamo = FakeDynamo(fail_first=99)
    log = DynamoEventLog("mytopia_events", FakeSession(dynamo))
    record = log.append(decision="allow", rule="allow-list")
    assert record["seq"] == 1 and log.since(0)[0]["hash"] == record["hash"]
    assert log.flush(5) and dynamo.calls == 4  # one try plus three retries, then given up (printed once)
    assert DynamoEventLog("mytopia_events", None).append(decision="allow")["seq"] == 1


def test_durable_copy_is_written_off_the_request_path_in_seq_order() -> None:
    dynamo = FakeDynamo(fail_first=1, delay_s=0.05)  # 50 ms per PutItem, the first one fails once
    log = DynamoEventLog("mytopia_events", FakeSession(dynamo))
    t0 = time.perf_counter()
    fill(log, 5)
    assert time.perf_counter() - t0 < 0.05  # five appends returned before even one PutItem finished
    assert log.flush(10)
    assert [int(item["seq"]["N"]) for item in dynamo.items] == [1, 2, 3, 4, 5]
    first = dynamo.items[0]
    assert first["pk"] == {"S": log.chain} and first["ms_since_revoke"] == {"NULL": True}
    assert first["hash"] == {"S": log.all()[0]["hash"]}


def test_one_unstorable_record_does_not_stop_the_writer() -> None:
    dynamo = FakeDynamo()
    log = DynamoEventLog("mytopia_events", FakeSession(dynamo))
    log.append(decision="run_started", agent_mode=1.5)  # TypeSerializer refuses a float: this record cannot be copied
    log.append(decision="allow", rule="allow-list")
    assert log.flush(5)
    assert [int(item["seq"]["N"]) for item in dynamo.items] == [2]  # the writer lived on and copied the next record


def test_restart_after_reset_does_not_resume_the_old_chain(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    log = MemoryEventLog(path)
    fill(log, 3)
    new_chain = log.reset()
    again = MemoryEventLog(path)  # restart with no event since the reset
    assert again.chain == new_chain and again.all() == []
    assert again.append(decision="allow")["prev_hash"] == "genesis"


def test_restart_resumes_the_last_chain(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    first = MemoryEventLog(path)
    fill(first, 2)
    first.reset()
    fill(first, 3)
    again = MemoryEventLog(path)  # a gateway restart
    assert again.chain == first.chain
    assert [r["seq"] for r in again.all()] == [1, 2, 3]
    assert again.append(decision="allow", rule="allow-list")["seq"] == 4
    assert verify_chain(again.all())
