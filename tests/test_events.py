"""Tests for gateway/events.py: the hash chain, the since() cursor, reset() and the JSONL twin.
Only the in-memory log is exercised here; the DynamoDB copy is checked with a fake table that fails."""

import json
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


class FailingTable:
    def put_item(self, **kwargs: object) -> None:
        raise RuntimeError("AccessDenied")


class FailingSession:
    def resource(self, name: str) -> "FailingSession":
        return self

    def Table(self, name: str) -> FailingTable:  # noqa: N802 - mirrors boto3
        return FailingTable()


def test_dynamo_failure_never_blocks() -> None:
    log = DynamoEventLog("mytopia_events", FailingSession())
    record = log.append(decision="allow", rule="allow-list")
    assert record["seq"] == 1 and log.since(0)[0]["hash"] == record["hash"]
    assert DynamoEventLog("mytopia_events", None).append(decision="allow")["seq"] == 1


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
