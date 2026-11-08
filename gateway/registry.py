"""The badge registry: one row per agent saying its status, its tier and which tools it may use.
MemoryRegistry keeps the rows in a dict (local mode); DynamoRegistry reads table mytopia_agents with a consistent read on every call and fails closed.
Rows are the two seed badges (made_by seed) plus any the Factory minted (made_by factory); a reset drops the Factory's rows."""

import sys
import threading
from datetime import datetime, timezone
from typing import Any, Protocol

from gateway.tiers import SEED_TIERS

KNOWN_AGENTS = ("research-bot", "ops-bot")   # the seed badges (warm-up reads these); minted agents live only in rows
SEED_TOOLS = {"research-bot": ["read_file", "search_files", "create_issue", "list_issues"],
              "ops-bot": ["read_file"]}   # the demo's badges; /demo/reset puts these back
SEED_ROLES = {"research-bot": "reads documents and files tickets", "ops-bot": "reads documents"}
LISTED_STATUSES = ("ACTIVE", "REVOKED", "KILLED")   # a row with any other status is not an agent anyone may see or use


class RegistryUnavailable(Exception):
    """The registry could not be read; callers must deny with rule registry-unavailable."""


class AgentExists(Exception):
    """A mint asked for an agent id that already has a row (PutItem's attribute_not_exists failed)."""


class Registry(Protocol):
    def get(self, agent_id: str) -> dict | None: ...
    def set_status(self, agent_id: str, status: str, by: str, expect: str | None = None) -> dict: ...
    def set_tools(self, agent_id: str, allowed_tools: list[str], by: str) -> dict: ...
    def set_tier(self, agent_id: str, tier: str, allowed_tools: list[str], by: str) -> dict: ...
    def put(self, row: dict) -> dict: ...
    def delete(self, agent_id: str) -> None: ...
    def all_rows(self) -> list[dict]: ...
    def list_agents(self) -> list[dict]: ...
    def reset(self) -> None: ...


def now_iso() -> str:
    """UTC now as ISO 8601 with milliseconds and Z."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def seed_fields(agent_id: str) -> dict:
    """What a reset writes back onto a seed row besides its status: the seed tools, tier, role and made_by.
    Writing tier here also fixes a row written before tiers existed."""
    return {"allowed_tools": list(SEED_TOOLS[agent_id]), "tier": SEED_TIERS[agent_id],
            "role": SEED_ROLES[agent_id], "made_by": "seed"}


def seed_rows(research_client_id: str = "local-research-bot", ops_client_id: str = "local-ops-bot") -> dict[str, dict]:
    """The two badge rows of the demo, both ACTIVE."""
    now = now_iso()
    common = {"status": "ACTIVE", "revoked_at": None, "revoked_by": None, "updated_at": now, "created_at": now}
    return {
        "research-bot": {"agent": "research-bot", "name": "Research Bot", "client_id": research_client_id,
                         "color": "mustard", **seed_fields("research-bot"), **common},
        "ops-bot": {"agent": "ops-bot", "name": "Ops Bot", "client_id": ops_client_id,
                    "color": "sage", **seed_fields("ops-bot"), **common},
    }


def listed(rows: list[dict]) -> list[dict]:
    """The rows GET /agents and the client map may use: only the three known statuses (anything else fails closed)."""
    return [row for row in rows if row.get("status") in LISTED_STATUSES]


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


def error_code(exc: Exception) -> str:
    """The AWS error code of a botocore ClientError, or ''."""
    return str(getattr(exc, "response", {}).get("Error", {}).get("Code", ""))


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
        return self._update(agent_id, {"allowed_tools": list(allowed_tools), "updated_at": now_iso()})

    def set_tier(self, agent_id: str, tier: str, allowed_tools: list[str], by: str) -> dict:
        """Tier and tool list in one write (a demotion trims the list in the same step)."""
        return self._update(agent_id, {"tier": tier, "allowed_tools": list(allowed_tools), "updated_at": now_iso()})

    def _update(self, agent_id: str, fields: dict) -> dict:
        with self._lock:
            if agent_id not in self._rows:
                raise KeyError(agent_id)
            self._rows[agent_id].update(fields)
            return dict(self._rows[agent_id])

    def put(self, row: dict) -> dict:
        """Create a row; an existing agent id raises AgentExists (the memory twin of attribute_not_exists)."""
        with self._lock:
            if row["agent"] in self._rows:
                raise AgentExists(row["agent"])
            self._rows[row["agent"]] = dict(row)
            return dict(row)

    def delete(self, agent_id: str) -> None:
        with self._lock:
            self._rows.pop(agent_id, None)

    def all_rows(self) -> list[dict]:
        with self._lock:
            ids = list(self._rows)
        return [row for row in (self.get(a) for a in ids) if row]  # through get(), one read per row, like before

    def list_agents(self) -> list[dict]:
        return listed(self.all_rows())

    def reset(self) -> None:
        """The two seed badges ACTIVE with their seed tools and tiers; every Factory row dropped."""
        with self._lock:
            self._rows = {k: v for k, v in self._rows.items() if v.get("made_by") != "factory"}
            for agent_id in KNOWN_AGENTS:
                self._rows.setdefault(agent_id, seed_rows()[agent_id])  # a seed row deleted by hand comes back
        for agent_id in KNOWN_AGENTS:
            self.set_status(agent_id, "ACTIVE", "reset")
            self._update(agent_id, {**seed_fields(agent_id), "updated_at": now_iso()})


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

    def set_tier(self, agent_id: str, tier: str, allowed_tools: list[str], by: str) -> dict:
        """One UpdateItem of tier and allowed_tools together, so a demotion never leaves a list above its ceiling."""
        return self._update(agent_id, {"tier": tier, "allowed_tools": list(allowed_tools), "updated_at": now_iso()})

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

    def put(self, row: dict) -> dict:
        """PutItem only if no row has this agent id yet: a failed condition raises AgentExists, anything else
        RegistryUnavailable (fail closed)."""
        if self._client is None:
            raise RegistryUnavailable("no AWS session for the registry")
        item = {k: self._to_dynamo(v) for k, v in row.items()}
        try:
            self._client.put_item(TableName=self.table_name, Item=item,
                                  ConditionExpression="attribute_not_exists(#agent)",
                                  ExpressionAttributeNames={"#agent": "agent"})
        except Exception as exc:  # noqa: BLE001 - every AWS error fails closed
            if "ConditionalCheckFailed" in (error_code(exc) or str(exc)):
                raise AgentExists(row["agent"]) from exc
            raise RegistryUnavailable(type(exc).__name__) from exc
        return dict(row)

    def delete(self, agent_id: str) -> None:
        self._call("delete_item", Key={"agent": {"S": agent_id}})

    def all_rows(self) -> list[dict]:
        """Every row: a strongly consistent Scan, page by page (the table holds a handful of badges).
        If the Scan is refused (a role without dynamodb:Scan, before infra/role_policy.py ran), the two seed rows are
        read one by one instead, so the demo badges keep working; a real outage fails those reads too and raises."""
        rows: list[dict] = []
        start: dict | None = None
        while True:
            extra = {"ExclusiveStartKey": start} if start else {}
            try:
                response = self._call("scan", ConsistentRead=True, **extra)
            except RegistryUnavailable as exc:
                print(f"registry: Scan failed ({exc}); reading the seed badges one by one", file=sys.stderr)
                return [row for row in (self.get(a) for a in KNOWN_AGENTS) if row]
            rows += [row for row in (self._row(item) for item in response.get("Items", [])) if row]
            start = response.get("LastEvaluatedKey")
            if not start:
                return rows

    def list_agents(self) -> list[dict]:
        return listed(self.all_rows())

    def reset(self) -> None:
        """The two seed badges ACTIVE with their seed tools, tier and role (written onto rows from before tonight
        too); any Factory row still there is deleted (factory.py deletes their identities first)."""
        for row in self.all_rows():
            if row.get("made_by") == "factory":
                self.delete(row["agent"])
        for agent_id in KNOWN_AGENTS:
            self.set_status(agent_id, "ACTIVE", "reset")
            self._update(agent_id, {**seed_fields(agent_id), "updated_at": now_iso()})
