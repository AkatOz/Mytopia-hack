"""The badge registry: one row per agent saying its status and which tools it may use.
MemoryRegistry keeps the rows in a dict (local mode); DynamoRegistry reads table mytopia_agents with a consistent read on every call and fails closed."""

import sys
import threading
from datetime import datetime, timezone
from typing import Any, Protocol

KNOWN_AGENTS = ("research-bot", "ops-bot")
SEED_TOOLS = {"research-bot": ["read_file", "search_files", "create_issue", "list_issues"],
              "ops-bot": ["read_file"]}   # the demo's badges; /demo/reset puts these back


class RegistryUnavailable(Exception):
    """The registry could not be read; callers must deny with rule registry-unavailable."""


class Registry(Protocol):
    def get(self, agent_id: str) -> dict | None: ...
    def set_status(self, agent_id: str, status: str, by: str, expect: str | None = None) -> dict: ...
    def set_tools(self, agent_id: str, allowed_tools: list[str], by: str) -> dict: ...
    def list_agents(self) -> list[dict]: ...
    def reset(self) -> None: ...


def now_iso() -> str:
    """UTC now as ISO 8601 with milliseconds and Z."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def seed_rows(research_client_id: str = "local-research-bot", ops_client_id: str = "local-ops-bot") -> dict[str, dict]:
    """The two badge rows of the demo, both ACTIVE."""
    common = {"status": "ACTIVE", "revoked_at": None, "revoked_by": None, "updated_at": now_iso()}
    return {
        "research-bot": {"agent": "research-bot", "name": "Research Bot", "client_id": research_client_id,
                         "allowed_tools": list(SEED_TOOLS["research-bot"]), "color": "mustard", **common},
        "ops-bot": {"agent": "ops-bot", "name": "Ops Bot", "client_id": ops_client_id,
                    "allowed_tools": list(SEED_TOOLS["ops-bot"]), "color": "sage", **common},
    }


def status_fields(status: str, by: str) -> dict:
    """The attributes set_status writes: revoked_at/by set on REVOKED, cleared on ACTIVE, kept on KILLED."""
    fields: dict[str, Any] = {"status": status, "updated_at": now_iso()}
    if status == "REVOKED":
        fields["revoked_at"] = fields["updated_at"]
        fields["revoked_by"] = by
    elif status == "ACTIVE":
        fields["revoked_at"] = None
        fields["revoked_by"] = None
    return fields


def dynamo_client(session: Any) -> Any:
    """A low-level DynamoDB client with short timeouts: a slow network must fail closed fast, not hang a call.
    The low-level client is documented thread-safe (the resource Table is not), and the requests run in a thread pool.
    total_max_attempts 2: one retry after a timeout, throttle or dropped keep-alive connection, so a single network blip
    does not deny a demo call. Still at most one successful read per call; the worst case before failing closed is
    about 6 s (connect 1 s + read 2 s, twice)."""
    from botocore.config import Config  # imported here so local mode never touches botocore

    config = Config(connect_timeout=1, read_timeout=2, tcp_keepalive=True,
                    retries={"mode": "standard", "total_max_attempts": 2})
    return session.client("dynamodb", config=config)


class MemoryRegistry:
    """Badge rows in a dict, seeded with the local client ids."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows = seed_rows()

    def get(self, agent_id: str) -> dict | None:
        with self._lock:
            row = self._rows.get(agent_id)
            return dict(row) if row else None

    def set_status(self, agent_id: str, status: str, by: str, expect: str | None = None) -> dict:
        """expect: only write if the status is still this (the quarantine never overwrites a KILL); else raises
        RegistryUnavailable, as DynamoDB's failed ConditionExpression does."""
        with self._lock:
            if agent_id not in self._rows:
                raise KeyError(agent_id)
            if expect is not None and self._rows[agent_id]["status"] != expect:
                raise RegistryUnavailable(f"ConditionalCheckFailed: status is {self._rows[agent_id]['status']}")
            self._rows[agent_id].update(status_fields(status, by))
            return dict(self._rows[agent_id])

    def set_tools(self, agent_id: str, allowed_tools: list[str], by: str) -> dict:
        """Replace the badge's tool list (who did it is in the event, not the row)."""
        with self._lock:
            if agent_id not in self._rows:
                raise KeyError(agent_id)
            self._rows[agent_id].update({"allowed_tools": list(allowed_tools), "updated_at": now_iso()})
            return dict(self._rows[agent_id])

    def list_agents(self) -> list[dict]:
        return [row for row in (self.get(a) for a in KNOWN_AGENTS) if row]

    def reset(self) -> None:
        for agent_id in KNOWN_AGENTS:
            self.set_status(agent_id, "ACTIVE", "reset")
            self.set_tools(agent_id, SEED_TOOLS[agent_id], "reset")


class DynamoRegistry:
    """Badge rows in DynamoDB table mytopia_agents (partition key agent); never caches a row."""

    def __init__(self, table_name: str, session: Any) -> None:
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self.table_name = table_name
        self._to_python = TypeDeserializer().deserialize
        self._to_dynamo = TypeSerializer().serialize
        self._client = None
        if session is not None:
            try:
                self._client = dynamo_client(session)
            except Exception as exc:  # noqa: BLE001 - any setup failure means fail closed later
                print(f"registry setup failed: {type(exc).__name__}", file=sys.stderr)

    def _call(self, operation: str, **kwargs: Any) -> dict:
        """Run one DynamoDB operation; every failure becomes RegistryUnavailable (fail closed)."""
        if self._client is None:
            raise RegistryUnavailable("no AWS session for the registry")
        try:
            return getattr(self._client, operation)(TableName=self.table_name, **kwargs)
        except Exception as exc:  # noqa: BLE001 - every AWS error fails closed
            raise RegistryUnavailable(type(exc).__name__) from exc

    def _row(self, item: dict | None) -> dict | None:
        return {k: self._to_python(v) for k, v in item.items()} if item else None

    def get(self, agent_id: str) -> dict | None:
        """The badge as DynamoDB has it right now: a strongly consistent GetItem, every time."""
        response = self._call("get_item", Key={"agent": {"S": agent_id}}, ConsistentRead=True)
        return self._row(response.get("Item"))

    def set_status(self, agent_id: str, status: str, by: str, expect: str | None = None) -> dict:
        """expect: only write if the status is still this; a failed condition becomes RegistryUnavailable."""
        return self._update(agent_id, status_fields(status, by), expect)

    def set_tools(self, agent_id: str, allowed_tools: list[str], by: str) -> dict:
        """UpdateItem of allowed_tools (and updated_at, which every row has); who did it is in the event."""
        return self._update(agent_id, {"allowed_tools": list(allowed_tools), "updated_at": now_iso()})

    def _update(self, agent_id: str, fields: dict, expect: str | None = None) -> dict:
        """One UpdateItem of these attributes on an existing row (never creates one); returns the new row.
        With expect, the row's status must also still be that value (#status = :expect)."""
        names = {f"#{k}": k for k in fields}
        names["#agent"] = "agent"  # "agent" and "status" are DynamoDB reserved words: always alias them
        values = {f":{k}": self._to_dynamo(v) for k, v in fields.items()}
        condition = "attribute_exists(#agent)"
        if expect is not None:
            names["#status"] = "status"
            values[":expect"] = self._to_dynamo(expect)
            condition += " AND #status = :expect"
        update = "SET " + ", ".join(f"#{k} = :{k}" for k in fields)
        response = self._call("update_item", Key={"agent": {"S": agent_id}}, UpdateExpression=update,
                              ExpressionAttributeNames=names, ExpressionAttributeValues=values,
                              ConditionExpression=condition, ReturnValues="ALL_NEW")
        return self._row(response["Attributes"]) or {}

    def list_agents(self) -> list[dict]:
        # the gateway role has no Scan permission, so read the known ids one by one
        return [row for row in (self.get(a) for a in KNOWN_AGENTS) if row]

    def reset(self) -> None:
        for agent_id in KNOWN_AGENTS:
            self.set_status(agent_id, "ACTIVE", "reset")
            self.set_tools(agent_id, SEED_TOOLS[agent_id], "reset")
