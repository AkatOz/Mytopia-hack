"""The tool runners: how the gateway actually runs a tool once decide() said yes.
LocalTools calls tools_lambda.handler in-process (or a built-in stub if that file is missing); LambdaTools invokes the mytopia-tools Lambda."""

import json
import sys
from typing import Any, Callable, Protocol


def _string_schema(*names: str) -> dict:
    """A JSON schema whose properties are all required strings."""
    return {"type": "object", "properties": {n: {"type": "string"} for n in names}, "required": list(names)}


STUB_TOOLS: list[dict] = [
    {"name": "read_file", "description": "Read a file from the drive.", "inputSchema": _string_schema("path")},
    {"name": "search_files", "description": "Search the drive.", "inputSchema": _string_schema("query")},
    {"name": "create_issue", "description": "Create a GitHub issue.", "inputSchema": _string_schema("title", "body")},
    {"name": "list_issues", "description": "List GitHub issues.", "inputSchema": _string_schema()},
    {"name": "send_email", "description": "Send an email.", "inputSchema": _string_schema("to", "subject", "body")},
    {"name": "delete_file", "description": "Delete a file from the drive.", "inputSchema": _string_schema("path")},
]


def text_result(text: str, is_error: bool = False) -> dict:
    """The MCP tool result shape."""
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def stub_run_tool(name: str, arguments: dict) -> dict:
    """Stand-in for tools_lambda.handler.run_tool so the gateway works without it."""
    if name not in {t["name"] for t in STUB_TOOLS}:
        return text_result(f"unknown tool {name}", True)
    return text_result(f"stub: {name} {json.dumps(arguments, sort_keys=True)}")


def load_tools() -> tuple[list[dict], Callable[[str, dict], dict]]:
    """Return (TOOLS, run_tool) from tools_lambda.handler, or the stub if it cannot be imported."""
    try:
        from tools_lambda.handler import TOOLS, run_tool
        return list(TOOLS), run_tool
    except Exception as exc:  # noqa: BLE001 - a missing or broken file falls back to the stub
        print(f"tools: using built-in stub ({type(exc).__name__})", file=sys.stderr)
        return STUB_TOOLS, stub_run_tool


WARM_TOOL = "__warm__"   # not a tool: run_tool answers "unknown tool" and changes nothing


class ToolRunner(Protocol):
    definitions: list[dict]

    def invoke(self, name: str, arguments: dict) -> dict: ...
    def warm(self) -> None: ...


class LocalTools:
    """Runs the six tools in the gateway process."""

    def __init__(self) -> None:
        self.definitions, self._run = load_tools()

    def invoke(self, name: str, arguments: dict) -> dict:
        try:
            return self._run(name, arguments)
        except Exception as exc:  # noqa: BLE001 - a tool crash is a tool error, not a gateway crash
            return text_result(f"tool {name} failed: {type(exc).__name__}", True)

    def warm(self) -> None:
        """Nothing to warm in-process."""


class LambdaTools:
    """Runs the six tools in the Lambda function; any AWS failure becomes an isError result."""

    def __init__(self, function_name: str, session: Any) -> None:
        self.function_name = function_name
        self.definitions, _ = load_tools()
        self._client = None
        if session is not None:
            try:
                from botocore.config import Config

                # invoke is not idempotent (create_issue), so botocore must never retry it on its own;
                # read_timeout 16 s covers the Lambda's 15 s timeout plus a cold start
                config = Config(connect_timeout=2, read_timeout=16, tcp_keepalive=True,
                                retries={"mode": "standard", "total_max_attempts": 1})
                self._client = session.client("lambda", config=config)
            except Exception as exc:  # noqa: BLE001
                print(f"tools: Lambda client setup failed: {type(exc).__name__}", file=sys.stderr)

    def invoke(self, name: str, arguments: dict) -> dict:
        if self._client is None:
            return text_result("tool error: no AWS session for Lambda", True)
        try:
            response = self._client.invoke(FunctionName=self.function_name,
                                           Payload=json.dumps({"tool": name, "arguments": arguments}))
            payload = json.loads(response["Payload"].read())
        except Exception as exc:  # noqa: BLE001 - every AWS error is reported, never raised
            code = getattr(exc, "response", {}).get("Error", {}).get("Code", type(exc).__name__)
            return text_result(f"tool error: Lambda {code}", True)
        if response.get("FunctionError") or not isinstance(payload, dict) or "content" not in payload:
            return text_result(f"tool error: Lambda returned {str(payload)[:120]}", True)
        return payload

    def warm(self) -> None:
        """Invoke the Lambda with a tool name it does not know: no side effect, but the container is now warm."""
        self.invoke(WARM_TOOL, {})
