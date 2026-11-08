"""Put the gateway role's inline policy (mytopia-gateway-narrow) and nothing else: the Factory needs PutItem, DeleteItem
and Scan on the agents table and Create/DeleteUserPoolClient on the pool. The policy text is provision.py's
gateway_policy, so a later provision.py run agrees with it. Runs as profile ws from gateway/.aws-credentials.

    .venv\\Scripts\\python infra\\role_policy.py --dry-run --account 123456789012
    .venv\\Scripts\\python infra\\role_policy.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import provision  # noqa: E402  (infra/provision.py: the same policy text, profile and paths)

POLICY_NAME = "mytopia-gateway-narrow"
DRY_RUN_ACCOUNT = "<account>"


def pool_from_env(path: str = provision.GATEWAY_ENV) -> str:
    """COGNITO_POOL_ID from gateway/.env, or '' (only that one line is read; nothing else is printed)."""
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8") as f:
        for line in f.read().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "COGNITO_POOL_ID":
                return value.strip()
    return ""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Put the MYTOPIA gateway role's inline policy (only that).")
    ap.add_argument("--dry-run", action="store_true", help="print the policy JSON and exit without calling AWS")
    ap.add_argument("--pool", default=None, help="Cognito pool id (default: COGNITO_POOL_ID in gateway/.env)")
    ap.add_argument("--account", default=None, help="account id for --dry-run (a real run asks STS)")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    pool_id = args.pool or pool_from_env()
    if not pool_id:
        print("FAILED: no pool id: pass --pool or set COGNITO_POOL_ID in gateway/.env", file=sys.stderr)
        return 2
    if args.dry_run:
        policy = provision.gateway_policy(args.account or DRY_RUN_ACCOUNT, pool_id)
        print(f"DRY RUN: would put inline policy {POLICY_NAME} on role {provision.GATEWAY_ROLE}:")
        print(json.dumps(policy, indent=2))
        return 0
    provision.use_ws_profile()
    import boto3

    session = boto3.Session(profile_name="ws", region_name=provision.REGION)
    try:
        account = session.client("sts").get_caller_identity()["Account"]
        policy = provision.gateway_policy(account, pool_id)
        session.client("iam").put_role_policy(RoleName=provision.GATEWAY_ROLE, PolicyName=POLICY_NAME,
                                              PolicyDocument=json.dumps(policy))
    except Exception as e:  # noqa: BLE001
        if provision.error_code(e) in ("ExpiredToken", "ExpiredTokenException"):
            print("FAILED: ExpiredToken. The Workshop Studio keys expired: get new ones and re-run scripts\\aws_creds.py.",
                  file=sys.stderr)
            return 2
        raise
    print(f"put inline policy {POLICY_NAME} on role {provision.GATEWAY_ROLE} (account {account}):")
    print(json.dumps(policy, indent=2))
    print("IAM changes can take a few seconds to reach the gateway's role session.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
