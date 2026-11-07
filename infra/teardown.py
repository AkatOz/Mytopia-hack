"""Delete every AWS resource infra/provision.py created (Lambda, both roles, both tables, the Cognito pool) and the local role pointers.
Without --yes it only prints what it would delete; it never touches resources whose names are not MYTOPIA's.

    .venv\\Scripts\\python infra\\teardown.py --dry-run
    .venv\\Scripts\\python infra\\teardown.py --yes
"""
from __future__ import annotations

import argparse
import os
import sys

import provision as p


def plan_lines() -> list[str]:
    """What teardown deletes or resets, as printable lines (no AWS calls)."""
    return [
        f"lambda {p.FUNCTION}",
        f"iam role {p.EXEC_ROLE} and its inline policies",
        f"iam role {p.GATEWAY_ROLE} and its inline policies",
        f"dynamodb tables {p.AGENTS_TABLE}, {p.EVENTS_TABLE}",
        f"cognito user pool {p.POOL_NAME} (with its resource server and clients)",
        f"local: {p.ROLE_FILE}, [profile gateway] in {p.CONFIG_FILE}",
        f"local: MODE/TOOLS_MODE/TOKEN_MODE=local in {p.GATEWAY_ENV}, TOKEN_MODE=local in {p.AGENT_ENV}",
    ]


def delete_role(iam, name: str) -> str:
    """Delete a role's inline policies, then the role."""
    try:
        for policy in iam.list_role_policies(RoleName=name)["PolicyNames"]:
            iam.delete_role_policy(RoleName=name, PolicyName=policy)
        iam.delete_role(RoleName=name)
        return f"deleted role {name}"
    except iam.exceptions.NoSuchEntityException:
        return f"role {name} not found"


def remove_config_section(path: str, section: str) -> None:
    """Drop one [section] from an INI file as plain text."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    kept, skipping = [], False
    for line in lines:
        if line.strip().startswith("["):
            skipping = line.strip() == f"[{section}]"
        if not skipping:
            kept.append(line)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(kept).rstrip() + "\n")


def teardown() -> None:
    """Delete everything, printing one line per resource."""
    p.use_ws_profile()
    import boto3
    session = boto3.Session(profile_name="ws", region_name=p.REGION)
    iam, ddb, lam, cog = (session.client(n) for n in ("iam", "dynamodb", "lambda", "cognito-idp"))
    try:
        lam.delete_function(FunctionName=p.FUNCTION)
        print(f"deleted lambda {p.FUNCTION}")
    except lam.exceptions.ResourceNotFoundException:
        print(f"lambda {p.FUNCTION} not found")
    print(delete_role(iam, p.EXEC_ROLE))
    print(delete_role(iam, p.GATEWAY_ROLE))
    for table in (p.AGENTS_TABLE, p.EVENTS_TABLE):
        try:
            ddb.delete_table(TableName=table)
            print(f"deleted table {table}")
        except ddb.exceptions.ResourceNotFoundException:
            print(f"table {table} not found")
    for page in cog.get_paginator("list_user_pools").paginate(MaxResults=60):
        for pool in page["UserPools"]:
            if pool["Name"] == p.POOL_NAME:
                cog.delete_user_pool(UserPoolId=pool["Id"])
                print(f"deleted cognito pool {pool['Id']}")
    if os.path.exists(p.ROLE_FILE):
        os.remove(p.ROLE_FILE)
    remove_config_section(p.CONFIG_FILE, "profile gateway")
    if os.path.exists(p.GATEWAY_ENV):
        p.update_env_file(p.GATEWAY_ENV, {"MODE": "local", "TOOLS_MODE": "local", "TOKEN_MODE": "local"})
    if os.path.exists(p.AGENT_ENV):
        p.update_env_file(p.AGENT_ENV, {"TOKEN_MODE": "local"})
    print("local files reset to local mode")


def main() -> int:
    ap = argparse.ArgumentParser(description="Delete MYTOPIA's AWS resources.")
    ap.add_argument("--yes", action="store_true", help="really delete")
    ap.add_argument("--dry-run", action="store_true", help="print what would be deleted (the default without --yes)")
    args = ap.parse_args()
    if args.dry_run or not args.yes:
        print("DRY RUN: would delete:")
        for line in plan_lines():
            print("  " + line)
        if not args.dry_run:
            print("Pass --yes to delete.")
        return 0
    try:
        teardown()
    except Exception as e:  # noqa: BLE001
        if p.error_code(e) in ("ExpiredToken", "ExpiredTokenException"):
            print("FAILED: ExpiredToken. Get new Workshop Studio keys and re-run scripts\\aws_creds.py.", file=sys.stderr)
            return 2
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
