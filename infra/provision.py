"""Create every AWS resource MYTOPIA needs (Cognito, two DynamoDB tables, the tools Lambda, the narrow gateway role) and write the local config files.
It is idempotent (find-or-create by name, safe to run twice), runs as profile ws from gateway/.aws-credentials, and --dry-run prints the plan without calling AWS.

    .venv\\Scripts\\python infra\\provision.py --dry-run
    .venv\\Scripts\\python infra\\provision.py
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGION = "us-east-1"
CREDS_FILE = os.path.join(ROOT, "gateway", ".aws-credentials")
CONFIG_FILE = os.path.join(ROOT, "gateway", ".aws-config")
GATEWAY_ENV = os.path.join(ROOT, "gateway", ".env")
AGENT_ENV = os.path.join(ROOT, "agent", ".env")
ROLE_FILE = os.path.join(ROOT, "infra", "gateway_role.txt")
HANDLER_FILE = os.path.join(ROOT, "tools_lambda", "handler.py")
VENV_PYTHON = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
CREDS_SCRIPT = os.path.join(ROOT, "infra", "gateway_creds.py")

POOL_NAME = "mytopia"
RESOURCE_SERVER = "mytopia"
SCOPE = "mytopia/tools"
AGENTS_TABLE = "mytopia_agents"
EVENTS_TABLE = "mytopia_events"
EXEC_ROLE = "mytopia-tools-exec"
FUNCTION = "mytopia-tools"
GATEWAY_ROLE = "mytopia-gateway-role"
HOST_ROLE = "mytopia-host-role"  # the EC2 server's role (infra/host_ec2.py); kept in the gateway role's trust when it exists
TAGS = [{"Key": "project", "Value": "mytopia"}]

SEED_ROWS = [
    {"agent": "research-bot", "name": "Research Bot", "color": "mustard", "tier": "silver",
     "role": "reads documents and files tickets", "made_by": "seed",
     "allowed_tools": ["read_file", "search_files", "create_issue", "list_issues"]},
    {"agent": "ops-bot", "name": "Ops Bot", "color": "sage", "tier": "bronze", "role": "reads documents",
     "made_by": "seed", "allowed_tools": ["read_file"]},
]
PLACEHOLDER_HANDLER = (
    '"""Placeholder MYTOPIA tools handler, deployed because tools_lambda/handler.py was missing."""\n'
    "def handler(event, context):\n"
    '    return {"content": [{"type": "text", "text": "placeholder"}], "isError": True}\n'
)


class Expired(Exception):
    """The Workshop Studio session credentials in gateway/.aws-credentials have expired."""


def use_ws_profile() -> None:
    """Point boto3 at profile ws in the gateway folder (never ~/.aws); call before importing boto3."""
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(name, None)
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = CREDS_FILE
    os.environ["AWS_CONFIG_FILE"] = CONFIG_FILE
    os.environ["AWS_PROFILE"] = "ws"
    os.environ["AWS_REGION"] = REGION


def short(secret: str) -> str:
    """Print-safe form of a secret: the first 4 characters plus '...' (enough to tell two secrets apart)."""
    return secret[:4] + "..."


def now_iso() -> str:
    """UTC ISO 8601 with milliseconds and Z."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def plan_lines() -> list[str]:
    """The resources and files provisioning creates or updates, as printable lines (no AWS calls)."""
    return [
        f"region {REGION}, profile ws from {CREDS_FILE}",
        f"cognito user pool '{POOL_NAME}' (ESSENTIALS, DeletionProtection INACTIVE)",
        f"cognito resource server '{RESOURCE_SERVER}' with scope 'tools' ({SCOPE})",
        "cognito app clients 'research-bot' and 'ops-bot' (secret, ALLOW_CLIENT_TOKEN_AUTH, client_credentials, 5-minute tokens)",
        f"dynamodb table '{AGENTS_TABLE}' (PK agent S, on-demand) with seed rows research-bot, ops-bot",
        f"dynamodb table '{EVENTS_TABLE}' (PK pk S, SK seq N, on-demand)",
        f"iam role '{EXEC_ROLE}' (trust lambda.amazonaws.com, inline logs policy)",
        f"lambda '{FUNCTION}' (python3.12, handler.handler, zip of {HANDLER_FILE}, timeout 15 s)",
        f"iam role '{GATEWAY_ROLE}' (trust: participant role, plus '{HOST_ROLE}' if it exists; 1 h, "
        "GetItem/UpdateItem/PutItem/DeleteItem/Scan agents, "
        "PutItem/Query events, InvokeFunction, Create/DeleteUserPoolClient on the pool)",
        f"write {ROLE_FILE}",
        f"write [profile gateway] into {CONFIG_FILE} (credential_process {CREDS_SCRIPT})",
        f"write MODE=aws TOOLS_MODE=lambda TOKEN_MODE=cognito COGNITO_POOL_ID GATEWAY_ROLE_ARN AWS_* into {GATEWAY_ENV}",
        f"write TOKEN_MODE=cognito and the four client id/secret lines into {AGENT_ENV}",
    ]


def lambda_zip(handler_path: str = HANDLER_FILE) -> tuple[bytes, bool]:
    """Zip handler.py alone at the zip root; returns (bytes, used_placeholder)."""
    placeholder = not os.path.isfile(handler_path)
    if placeholder:
        source = PLACEHOLDER_HANDLER
    else:
        with open(handler_path, encoding="utf-8") as f:
            source = f.read()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("handler.py", date_time=(2026, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        z.writestr(info, source)
    return buf.getvalue(), placeholder


def update_env_file(path: str, updates: dict[str, str], template: str | None = None) -> None:
    """Set KEY=value lines in a .env file (replace in place, append if absent); start from the template if the file is missing."""
    lines: list[str] = []
    source = path if os.path.exists(path) else template
    if source and os.path.exists(source):
        with open(source, encoding="utf-8") as f:
            lines = f.read().splitlines()
    done: set[str] = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if "=" in line and not line.lstrip().startswith("#") and key in updates:
            lines[i] = f"{key}={updates[key]}"
            done.add(key)
    lines += [f"{k}={v}" for k, v in updates.items() if k not in done]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def set_config_section(path: str, section: str, body: list[str]) -> None:
    """Replace (or append) one [section] in an INI file as plain text, keeping every other line and comment."""
    lines: list[str] = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    kept: list[str] = []
    skipping = False
    for line in lines:
        if line.strip().startswith("["):
            skipping = line.strip() == f"[{section}]"
        if not skipping:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    kept += ["", f"[{section}]", *body]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(kept) + "\n")


def gateway_profile_lines() -> list[str]:
    """The [profile gateway] body: credential_process with quoted absolute Windows paths, and the region."""
    py, script = os.path.normpath(VENV_PYTHON), os.path.normpath(CREDS_SCRIPT)
    return [f'credential_process = "{py}" -I "{script}"', f"region = {REGION}"]


def gateway_policy(account: str, pool_id: str) -> dict:
    """The gateway role's only permissions: two tables, one function, and the Factory's app clients in one pool.
    The Factory (build 3) mints and retires agents: PutItem/DeleteItem/Scan on the agents table and
    Create/DeleteUserPoolClient on the pool. infra/role_policy.py puts this same text."""
    table = f"arn:aws:dynamodb:{REGION}:{account}:table/"
    return {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem",
                                       "dynamodb:DeleteItem", "dynamodb:Scan"], "Resource": table + AGENTS_TABLE},
        {"Effect": "Allow", "Action": ["dynamodb:PutItem", "dynamodb:Query"], "Resource": table + EVENTS_TABLE},
        {"Effect": "Allow", "Action": "lambda:InvokeFunction",
         "Resource": f"arn:aws:lambda:{REGION}:{account}:function:{FUNCTION}"},
        {"Effect": "Allow", "Action": ["cognito-idp:CreateUserPoolClient", "cognito-idp:DeleteUserPoolClient"],
         "Resource": f"arn:aws:cognito-idp:{REGION}:{account}:userpool/{pool_id}"},
    ]}


def trust(principal: dict) -> str:
    """An assume-role trust policy for one principal, as JSON."""
    return json.dumps({"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Principal": principal, "Action": "sts:AssumeRole"}]})


def gateway_principals(iam, participant_arn: str) -> dict:
    """Who may assume the gateway role: the participant role, plus the hosted server's role when infra/host_ec2.py
    made one. ensure_role rewrites the whole trust policy, so without this a re-run here would cut the hosted gateway
    off from AWS within the hour."""
    try:
        host_arn = iam.get_role(RoleName=HOST_ROLE)["Role"]["Arn"]
    except iam.exceptions.NoSuchEntityException:
        return {"AWS": participant_arn}
    return {"AWS": [participant_arn, host_arn]}


def error_code(e: Exception) -> str:
    """The AWS error code of a botocore ClientError, or ''."""
    return getattr(e, "response", {}).get("Error", {}).get("Code", "")


def ensure_pool(cog) -> str:
    """Find the user pool by name or create it; returns the pool id."""
    for page in cog.get_paginator("list_user_pools").paginate(MaxResults=60):
        for pool in page["UserPools"]:
            if pool["Name"] == POOL_NAME:
                return pool["Id"]
    return cog.create_user_pool(PoolName=POOL_NAME, UserPoolTier="ESSENTIALS", DeletionProtection="INACTIVE",
                                UserPoolTags={"project": "mytopia"})["UserPool"]["Id"]


def ensure_resource_server(cog, pool_id: str) -> None:
    """Create the resource server with scope 'tools' unless it exists."""
    try:
        cog.describe_resource_server(UserPoolId=pool_id, Identifier=RESOURCE_SERVER)
    except cog.exceptions.ResourceNotFoundException:
        cog.create_resource_server(UserPoolId=pool_id, Identifier=RESOURCE_SERVER, Name="MYTOPIA gateway",
                                   Scopes=[{"ScopeName": "tools", "ScopeDescription": "call gateway tools"}])


def ensure_client(cog, pool_id: str, name: str) -> tuple[str, str]:
    """Find the M2M app client by name or create it; returns (client id, secret)."""
    for page in cog.get_paginator("list_user_pool_clients").paginate(UserPoolId=pool_id, MaxResults=60):
        for c in page["UserPoolClients"]:
            if c["ClientName"] == name:
                full = cog.describe_user_pool_client(UserPoolId=pool_id, ClientId=c["ClientId"])["UserPoolClient"]
                return full["ClientId"], full["ClientSecret"]
    c = cog.create_user_pool_client(
        UserPoolId=pool_id, ClientName=name, GenerateSecret=True, ExplicitAuthFlows=["ALLOW_CLIENT_TOKEN_AUTH"],
        AllowedOAuthFlowsUserPoolClient=True, AllowedOAuthFlows=["client_credentials"], AllowedOAuthScopes=[SCOPE],
        AccessTokenValidity=5, TokenValidityUnits={"AccessToken": "minutes"})["UserPoolClient"]
    return c["ClientId"], c["ClientSecret"]


def ensure_table(ddb, name: str, keys: list[tuple[str, str, str]]) -> str:
    """Find or create an on-demand table; keys are (attribute, type, HASH|RANGE). Returns the table ARN."""
    try:
        return ddb.describe_table(TableName=name)["Table"]["TableArn"]
    except ddb.exceptions.ResourceNotFoundException:
        pass
    ddb.create_table(TableName=name, BillingMode="PAY_PER_REQUEST", Tags=TAGS,
                     AttributeDefinitions=[{"AttributeName": a, "AttributeType": t} for a, t, _ in keys],
                     KeySchema=[{"AttributeName": a, "KeyType": k} for a, _, k in keys])
    ddb.get_waiter("table_exists").wait(TableName=name)
    return ddb.describe_table(TableName=name)["Table"]["TableArn"]


def seed_rows(table, client_ids: dict[str, str]) -> list[str]:
    """Put each seed row if missing; if present, only fix its client_id. Returns what was done per row."""
    done = []
    for seed in SEED_ROWS:
        cid = client_ids[seed["agent"]]
        row = table.get_item(Key={"agent": seed["agent"]}, ConsistentRead=True).get("Item")
        if row is None:
            table.put_item(Item={**seed, "client_id": cid, "status": "ACTIVE", "revoked_at": None,
                                 "revoked_by": None, "updated_at": now_iso()})
            done.append(f"{seed['agent']} created")
        elif row.get("client_id") != cid:
            table.update_item(Key={"agent": seed["agent"]}, UpdateExpression="SET client_id = :c, updated_at = :u",
                              ExpressionAttributeValues={":c": cid, ":u": now_iso()})
            done.append(f"{seed['agent']} client_id updated")
        else:
            done.append(f"{seed['agent']} unchanged (status {row.get('status')})")
    return done


def ensure_role(iam, name: str, trust_json: str, policy_name: str, policy: dict) -> str:
    """Find or create a role, set its trust policy and its one inline policy; returns the role ARN."""
    try:
        arn = iam.get_role(RoleName=name)["Role"]["Arn"]
        iam.update_assume_role_policy(RoleName=name, PolicyDocument=trust_json)
    except iam.exceptions.NoSuchEntityException:
        arn = iam.create_role(RoleName=name, AssumeRolePolicyDocument=trust_json, MaxSessionDuration=3600,
                              Tags=TAGS)["Role"]["Arn"]
        iam.get_waiter("role_exists").wait(RoleName=name)
    iam.put_role_policy(RoleName=name, PolicyName=policy_name, PolicyDocument=json.dumps(policy))
    return arn


def ensure_function(lam, exec_arn: str, code: bytes) -> str:
    """Create the tools Lambda (retrying while IAM propagates) or update its code; returns the function ARN."""
    try:
        lam.get_function(FunctionName=FUNCTION)
        lam.update_function_code(FunctionName=FUNCTION, ZipFile=code)
        lam.get_waiter("function_updated_v2").wait(FunctionName=FUNCTION)
    except lam.exceptions.ResourceNotFoundException:
        deadline = time.time() + 60
        while True:
            try:
                lam.create_function(FunctionName=FUNCTION, Runtime="python3.12", Role=exec_arn,
                                    Handler="handler.handler", Code={"ZipFile": code}, Timeout=15,
                                    Tags={"project": "mytopia"})
                break
            except lam.exceptions.InvalidParameterValueException as e:
                if "cannot be assumed" not in str(e) or time.time() > deadline:
                    raise
                time.sleep(5)
        lam.get_waiter("function_active_v2").wait(FunctionName=FUNCTION)
    return lam.get_function(FunctionName=FUNCTION)["Configuration"]["FunctionArn"]


def test_assume(sts, role_arn: str) -> str:
    """Assume the gateway role once (retrying up to 90 s while IAM propagates); returns the assumed ARN."""
    deadline = time.time() + 90
    while True:
        try:
            r = sts.assume_role(RoleArn=role_arn, RoleSessionName="mytopia-provision-test", DurationSeconds=3600)
            return r["AssumedRoleUser"]["Arn"]
        except Exception as e:  # noqa: BLE001
            if error_code(e) != "AccessDenied" or time.time() > deadline:
                raise
            time.sleep(5)


def write_local_files(pool_id: str, role_arn: str, clients: dict[str, tuple[str, str]]) -> None:
    """Write the role ARN file, the gateway profile, gateway/.env and agent/.env."""
    with open(ROLE_FILE, "w", encoding="utf-8", newline="\n") as f:
        f.write(role_arn + "\n")
    set_config_section(CONFIG_FILE, "profile gateway", gateway_profile_lines())
    update_env_file(GATEWAY_ENV, {
        "MODE": "aws", "TOOLS_MODE": "lambda", "TOKEN_MODE": "cognito", "COGNITO_POOL_ID": pool_id,
        "COGNITO_SCOPE": SCOPE, "AWS_REGION": REGION, "AWS_PROFILE": "gateway",
        "AWS_CONFIG_FILE": os.path.normpath(CONFIG_FILE), "AWS_SHARED_CREDENTIALS_FILE": os.path.normpath(CREDS_FILE),
        "GATEWAY_ROLE_ARN": role_arn, "TABLE_AGENTS": AGENTS_TABLE, "TABLE_EVENTS": EVENTS_TABLE,
        "TOOLS_FUNCTION": FUNCTION}, template=GATEWAY_ENV + ".example")
    update_env_file(AGENT_ENV, {
        "TOKEN_MODE": "cognito", "COGNITO_SCOPE": SCOPE, "AWS_REGION": REGION,
        "RESEARCH_BOT_CLIENT_ID": clients["research-bot"][0], "RESEARCH_BOT_CLIENT_SECRET": clients["research-bot"][1],
        "OPS_BOT_CLIENT_ID": clients["ops-bot"][0], "OPS_BOT_CLIENT_SECRET": clients["ops-bot"][1]},
        template=AGENT_ENV + ".example")


def provision() -> None:
    """Run every step in order, printing each id."""
    use_ws_profile()
    import boto3
    session = boto3.Session(profile_name="ws", region_name=REGION)
    sts, iam = session.client("sts"), session.client("iam")
    cog, ddb, lam = session.client("cognito-idp"), session.client("dynamodb"), session.client("lambda")

    me = sts.get_caller_identity()
    account = me["Account"]
    participant_arn = iam.get_role(RoleName=me["Arn"].split("/")[1])["Role"]["Arn"]
    print(f"account {account}, caller {me['Arn']}, trusting {participant_arn}", flush=True)

    pool_id = ensure_pool(cog)
    print(f"cognito pool {POOL_NAME}: {pool_id}", flush=True)
    ensure_resource_server(cog, pool_id)
    print(f"cognito resource server {RESOURCE_SERVER}: scope {SCOPE}", flush=True)
    clients = {name: ensure_client(cog, pool_id, name) for name in ("research-bot", "ops-bot")}
    for name, (cid, secret) in clients.items():
        print(f"cognito client {name}: {cid} (secret {short(secret)})", flush=True)

    agents_arn = ensure_table(ddb, AGENTS_TABLE, [("agent", "S", "HASH")])
    events_arn = ensure_table(ddb, EVENTS_TABLE, [("pk", "S", "HASH"), ("seq", "N", "RANGE")])
    print(f"table {agents_arn}\ntable {events_arn}", flush=True)
    rows = seed_rows(session.resource("dynamodb").Table(AGENTS_TABLE), {n: c[0] for n, c in clients.items()})
    print("seed rows: " + "; ".join(rows), flush=True)

    logs = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Resource": f"arn:aws:logs:{REGION}:{account}:*",
            "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]}]}
    exec_arn = ensure_role(iam, EXEC_ROLE, trust({"Service": "lambda.amazonaws.com"}), "mytopia-logs", logs)
    print(f"role {exec_arn}", flush=True)
    code, placeholder = lambda_zip()
    if placeholder:
        print(f"WARNING: {HANDLER_FILE} is missing; deploying a placeholder handler", flush=True)
    function_arn = ensure_function(lam, exec_arn, code)
    print(f"lambda {function_arn} ({len(code)} bytes)", flush=True)

    role_arn = ensure_role(iam, GATEWAY_ROLE, trust(gateway_principals(iam, participant_arn)), "mytopia-gateway-narrow",
                           gateway_policy(account, pool_id))
    print(f"role {role_arn}", flush=True)
    print(f"test assume_role OK: {test_assume(sts, role_arn)}", flush=True)

    write_local_files(pool_id, role_arn, clients)
    print(f"wrote {ROLE_FILE}, [profile gateway] in {CONFIG_FILE}, {GATEWAY_ENV}, {AGENT_ENV}")
    print(f"provisioning finished at {datetime.now().astimezone().isoformat(timespec='seconds')}")
    print("Next:\n  .venv\\Scripts\\python scripts\\whoami.py gateway\n  .venv\\Scripts\\python scripts\\bedrock_key.py\n"
          "  then start the gateway (it reads gateway/.env: MODE=aws, TOOLS_MODE=lambda, TOKEN_MODE=cognito)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Provision MYTOPIA's AWS resources (idempotent).")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and exit without calling AWS")
    args = ap.parse_args()
    if args.dry_run:
        print("DRY RUN: would find-or-create:")
        for line in plan_lines():
            print("  " + line)
        return 0
    try:
        provision()
    except Exception as e:  # noqa: BLE001
        if error_code(e) in ("ExpiredToken", "ExpiredTokenException"):
            print("FAILED: ExpiredToken. The Workshop Studio keys expired: get new ones and re-run scripts\\aws_creds.py.",
                  file=sys.stderr)
            return 2
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
