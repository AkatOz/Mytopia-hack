"""The badge registry: one row per agent saying its status and which tools it may use.
MemoryRegistry keeps the rows in a dict (local mode); DynamoRegistry reads table mytopia_agents with a consistent read on every call and fails closed."""

import sys
import threading
from datetime import datetime, timezone
from typing import Any, Protocol

KNOWN_AGENTS = ("research-bot", "ops-bot")


class RegistryUnavailable(Exception):
    """The registry could not be read; callers must deny with rule registry-unavailable."""


class Registry(Protocol):
    def get(self, agent_id: str) -> dict | None: ...
    def by_client_id(self, client_id: str) -> dict | None: ...
    def set_status(self, agent_id: str, status: str, by: str) -> dict: ...
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
                         "allowed_tools": ["read_file", "search_files", "create_issue", "list_issues"],
                         "color": "mustard", **common},
        "ops-bot": {"agent": "ops-bot", "name": "Ops Bot", "client_id": ops_client_id,
                    "allowed_tools": ["read_file"], "color": "sage", **common},
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


class MemoryRegistry:
    """Badge rows in a dict, seeded with the local client ids."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows = seed_rows()

    def get(self, agent_id: str) -> dict | None:
        with self._lock:
            row = self._rows.get(agent_id)
            return dict(row) if row else None

    def by_client_id(self, client_id: str) -> dict | None:
        for agent_id in KNOWN_AGENTS:
            row = self.get(agent_id)
            if row and row["client_id"] == client_id:
                return row
        return None

    def set_status(self, agent_id: str, status: str, by: str) -> dict:
        with self._lock:
            if agent_id not in self._rows:
                raise KeyError(agent_id)
            self._rows[agent_id].update(status_fields(status, by))
            return dict(self._rows[agent_id])

    def list_agents(self) -> list[dict]:
        return [row for row in (self.get(a) for a in KNOWN_AGENTS) if row]

    def reset(self) -> None:
        for agent_id in KNOWN_AGENTS:
            self.set_status(agent_id, "ACTIVE", "reset")


class DynamoRegistry:
    """Badge rows in DynamoDB table mytopia_agents (partition key agent); never caches a row."""

    def __init__(self, table_name: str, session: Any) -> None:
        self.table_name = table_name
        self._client = None
        if session is not None:
            try:
                self._client = session.resource("dynamodb").Table(table_name)
            except Exception as exc:  # noqa: BLE001 - any setup failure means fail closed later
                print(f"registry setup failed: {type(exc).__name__}", file=sys.stderr)

    def _table(self) -> Any:
        if self._client is None:
            raise RegistryUnavailable("no AWS session for the registry")
        return self._client

    def get(self, agent_id: str) -> dict | None:
        try:
            item = self._table().get_item(Key={"agent": agent_id}, ConsistentRead=True).get("Item")
        except RegistryUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - every AWS error fails closed
            raise RegistryUnavailable(type(exc).__name__) from exc
        return dict(item) if item else None

    def by_client_id(self, client_id: str) -> dict | None:
        for agent_id in KNOWN_AGENTS:
            row = self.get(agent_id)
            if row and row.get("client_id") == client_id:
                return row
        return None

    def set_status(self, agent_id: str, status: str, by: str) -> dict:
        fields = status_fields(status, by)
        names = {f"#{k}": k for k in fields}
        values = {f":{k}": v for k, v in fields.items()}
        update = "SET " + ", ".join(f"#{k} = :{k}" for k in fields)
        try:
            result = self._table().update_item(
                Key={"agent": agent_id}, UpdateExpression=update, ExpressionAttributeNames=names,
                ExpressionAttributeValues=values, ConditionExpression="attribute_exists(agent)",
                ReturnValues="ALL_NEW")
        except RegistryUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RegistryUnavailable(type(exc).__name__) from exc
        return dict(result["Attributes"])

    def list_agents(self) -> list[dict]:
        return [row for row in (self.get(a) for a in KNOWN_AGENTS) if row]

    def reset(self) -> None:
        for agent_id in KNOWN_AGENTS:
            self.set_status(agent_id, "ACTIVE", "reset")
