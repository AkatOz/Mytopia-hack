"""Mint a short-term Bedrock API key (bearer token) from profile ws and write it into agent/.env as AWS_BEARER_TOKEN_BEDROCK.
The key works for Bedrock in us-east-1 only and lives at most 12 hours or as long as the Workshop session; it prints only the first 20 characters.

    .venv\\Scripts\\python scripts\\bedrock_key.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS_FILE = os.path.join(ROOT, "gateway", ".aws-credentials")
CONFIG_FILE = os.path.join(ROOT, "gateway", ".aws-config")
AGENT_ENV = os.path.join(ROOT, "agent", ".env")
KEY = "AWS_BEARER_TOKEN_BEDROCK"


def replace_line(text: str, key: str, value: str) -> str:
    """Return text with the KEY=... line replaced (or appended when absent)."""
    lines = text.splitlines()
    out = [f"{key}={value}" if line.split("=", 1)[0].strip() == key else line for line in lines]
    if f"{key}={value}" not in out:
        out.append(f"{key}={value}")
    return "\n".join(out) + "\n"


def main() -> int:
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(name, None)
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = CREDS_FILE
    os.environ["AWS_CONFIG_FILE"] = CONFIG_FILE
    os.environ["AWS_PROFILE"] = "ws"
    os.environ["AWS_REGION"] = "us-east-1"
    from aws_bedrock_token_generator import provide_token
    try:
        token = provide_token(region="us-east-1")
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: could not mint the Bedrock key from profile ws: {e}", file=sys.stderr)
        return 1
    source = AGENT_ENV if os.path.exists(AGENT_ENV) else AGENT_ENV + ".example"
    text = ""
    if os.path.exists(source):
        with open(source, encoding="utf-8") as f:
            text = f.read()
    with open(AGENT_ENV, "w", encoding="utf-8", newline="\n") as f:
        f.write(replace_line(text, KEY, token))
    print(f"wrote {KEY}={token[:8]}... into {AGENT_ENV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
