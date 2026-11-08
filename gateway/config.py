"""Settings for the gateway, read from gateway/.env and the process environment (environment wins).
Tests build Settings directly; only Settings.from_env() touches the .env file, and it copies the AWS_* file paths into os.environ for boto3."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

REPO_ROOT = Path(__file__).resolve().parent.parent
GATEWAY_DIR = REPO_ROOT / "gateway"
AWS_ENV_KEYS = ("AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE")


@dataclass
class Settings:
    """Every knob of the gateway; the defaults are the local, no-AWS mode."""

    mode: str = "local"                 # local | aws  (registry and event log)
    tools_mode: str = "local"           # local | lambda
    token_mode: str = "local"           # local | cognito
    port: int = 8787
    admin_token: str = "change-me"
    demo_pace: float = 2.0
    local_issuer_secret: str = "change-me-too"
    cognito_pool_id: str = ""
    cognito_scope: str = "mytopia/tools"
    aws_region: str = "us-east-1"
    table_agents: str = "mytopia_agents"
    table_events: str = "mytopia_events"
    tools_function: str = "mytopia-tools"
    events_jsonl: Path | None = None    # local twin of the events table; None means no file
    island_dir: Path | None = None      # override of the static folder served at /
    quarantine_after: int = 3           # allow-list refusals in the window that make the gateway pull the badge; 0 = off
    quarantine_window_s: float = 60.0   # the window those refusals are counted in
    # the launcher's env file the Factory appends a minted agent's client id and secret to; None writes no file
    # (Settings built in code, e.g. tests); from_env defaults it to agent/.env
    agent_env: Path | None = None

    @classmethod
    def from_env(cls, env_file: Path = GATEWAY_DIR / ".env") -> "Settings":
        """Read gateway/.env (if present) overlaid by os.environ and return Settings."""
        values: dict[str, str] = {k: v for k, v in dotenv_values(env_file).items() if v is not None}
        values.update(os.environ)
        for key in AWS_ENV_KEYS:  # boto3 reads these from os.environ, so put them there
            if values.get(key):
                os.environ[key] = values[key]

        def get(key: str, default: str) -> str:
            return values.get(key) or default

        jsonl = get("EVENTS_JSONL", "gateway/events.local.jsonl")
        island = values.get("ISLAND_DIR", "")
        return cls(
            mode=get("MODE", "local"),
            tools_mode=get("TOOLS_MODE", "local"),
            token_mode=get("TOKEN_MODE", "local"),
            port=int(get("PORT", "8787")),
            admin_token=get("ADMIN_TOKEN", "change-me"),
            demo_pace=float(get("DEMO_PACE", "2.0")),
            local_issuer_secret=get("LOCAL_ISSUER_SECRET", "change-me-too"),
            cognito_pool_id=get("COGNITO_POOL_ID", ""),
            cognito_scope=get("COGNITO_SCOPE", "mytopia/tools"),
            aws_region=get("AWS_REGION", "us-east-1"),
            table_agents=get("TABLE_AGENTS", "mytopia_agents"),
            table_events=get("TABLE_EVENTS", "mytopia_events"),
            tools_function=get("TOOLS_FUNCTION", "mytopia-tools"),
            events_jsonl=resolve(jsonl),
            island_dir=resolve(island) if island else None,
            quarantine_after=int(get("QUARANTINE_AFTER", "3")),
            quarantine_window_s=float(get("QUARANTINE_WINDOW_S", "60")),
            agent_env=resolve(get("AGENT_ENV", "agent/.env")),
        )


def resolve(path_text: str) -> Path:
    """Turn a path from .env (relative to the repo root, either slash) into an absolute Path."""
    path = Path(path_text.replace("\\", "/"))
    return path if path.is_absolute() else REPO_ROOT / path
