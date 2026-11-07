"""The credential_process for profile gateway: assumes mytopia-gateway-role from profile ws and prints the AWS process-credentials JSON.
It prints nothing else on stdout; on any failure it writes the reason to stderr and exits non-zero, and botocore re-runs it before each expiry."""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS_FILE = os.path.join(ROOT, "gateway", ".aws-credentials")
CONFIG_FILE = os.path.join(ROOT, "gateway", ".aws-config")
GATEWAY_ENV = os.path.join(ROOT, "gateway", ".env")
ROLE_FILE = os.path.join(ROOT, "infra", "gateway_role.txt")


def role_arn() -> str:
    """GATEWAY_ROLE_ARN from gateway/.env, else the first line of infra/gateway_role.txt, else ''."""
    if os.path.exists(GATEWAY_ENV):
        with open(GATEWAY_ENV, encoding="utf-8") as f:
            for line in f:
                if line.startswith("GATEWAY_ROLE_ARN="):
                    value = line.split("=", 1)[1].strip().strip('"')
                    if value:
                        return value
    if os.path.exists(ROLE_FILE):
        with open(ROLE_FILE, encoding="utf-8") as f:
            return f.readline().strip()
    return ""


def to_process_json(creds: dict) -> str:
    """Format STS AssumeRole credentials as credential_process output (Version 1)."""
    return json.dumps({"Version": 1, "AccessKeyId": creds["AccessKeyId"], "SecretAccessKey": creds["SecretAccessKey"],
                       "SessionToken": creds["SessionToken"], "Expiration": creds["Expiration"].isoformat()})


def main() -> int:
    arn = role_arn()
    if not arn:
        print("gateway_creds: no GATEWAY_ROLE_ARN in gateway/.env and no infra/gateway_role.txt; run infra/provision.py",
              file=sys.stderr)
        return 1
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(name, None)
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = CREDS_FILE
    os.environ["AWS_CONFIG_FILE"] = CONFIG_FILE
    os.environ["AWS_PROFILE"] = "ws"  # never "gateway" here, or this script would call itself
    try:
        import boto3
        sts = boto3.Session(profile_name="ws", region_name="us-east-1").client("sts")
        r = sts.assume_role(RoleArn=arn, RoleSessionName="mytopia-gateway", DurationSeconds=3600)
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "response", {}).get("Error", {}).get("Code", type(e).__name__)
        print(f"gateway_creds: assume_role {arn} failed: {code}: {e}", file=sys.stderr)
        return 1
    print(to_process_json(r["Credentials"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
