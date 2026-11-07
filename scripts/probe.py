#!/usr/bin/env python
"""MYTOPIA AWS probe: settles every AWS doubt in one run against the team's Workshop Studio account.

Run from the repo root after scripts\\aws_creds.py saved the credentials:

    .venv\\Scripts\\python scripts\\probe.py               # read checks, Bedrock calls, create+delete probes
    .venv\\Scripts\\python scripts\\probe.py --read-only   # no writes at all
    .venv\\Scripts\\python scripts\\probe.py --models us.amazon.nova-2-lite-v1:0 us.amazon.nova-lite-v1:0

What it tests, in order: identity and the participant role's exact ARN; read access to Cognito,
DynamoDB, Lambda, IAM, CloudWatch Logs; whether another region is refused; the Bedrock inference
profiles; a Converse call and a tool-use call on the first model that answers; a short-term Bedrock
API key (bearer token) generated from the session credentials and the proof that it cannot call
DynamoDB; an IAM policy simulation for every action MYTOPIA needs; then, unless --read-only: create
and delete a DynamoDB table, create an IAM role and assume it (role chaining, 1-hour cap), create a
Lambda function with that role and invoke it, create a Cognito user pool with a machine-to-machine app
client, mint a token with the unsigned GetClientToken call (no domain), verify it against the pool's
JWKS, and delete the pool. Everything it creates is named mytopia-probe-* and deleted before it exits.

Output: a PASS/FAIL table and scripts/probe_result.json (git-ignored).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import uuid
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS = os.path.join(ROOT, "gateway", ".aws-credentials")
CONFIG = os.path.join(ROOT, "gateway", ".aws-config")
RESULT = os.path.join(ROOT, "scripts", "probe_result.json")

DEFAULT_MODELS = [
    "us.amazon.nova-2-lite-v1:0",
    "us.amazon.nova-lite-v1:0",
    "us.meta.llama4-scout-17b-instruct-v1:0",
]

NEEDED_ACTIONS = [
    "cognito-idp:CreateUserPool", "cognito-idp:CreateResourceServer", "cognito-idp:CreateUserPoolClient",
    "cognito-idp:CreateUserPoolDomain", "cognito-idp:DescribeUserPoolClient", "cognito-idp:DeleteUserPool",
    "dynamodb:CreateTable", "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query",
    "lambda:CreateFunction", "lambda:InvokeFunction", "lambda:AddPermission", "lambda:DeleteFunction",
    "iam:CreateRole", "iam:PutRolePolicy", "iam:PassRole", "iam:DeleteRole", "sts:AssumeRole",
    "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ListInferenceProfiles",
    "bedrock:CallWithBearerToken",
    "logs:CreateLogGroup", "logs:PutLogEvents",
    "verifiedpermissions:IsAuthorized", "apigateway:POST",
]


class Probe:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def check(self, name: str, fn, skip_reason: str | None = None):
        if skip_reason:
            self.rows.append({"check": name, "status": "SKIP", "detail": skip_reason, "ms": 0})
            print(f"  SKIP  {name}: {skip_reason}")
            return None
        t0 = time.perf_counter()
        try:
            out = fn()
            ms = int((time.perf_counter() - t0) * 1000)
            detail = "" if out is None else str(out)
            self.rows.append({"check": name, "status": "PASS", "detail": detail[:400], "ms": ms})
            print(f"  PASS  {name} ({ms} ms)  {detail[:140]}")
            return out
        except Exception as e:  # noqa: BLE001 - a probe reports, it never raises
            ms = int((time.perf_counter() - t0) * 1000)
            detail = f"{type(e).__name__}: {e}"
            self.rows.append({"check": name, "status": "FAIL", "detail": detail[:600], "ms": ms})
            print(f"  FAIL  {name} ({ms} ms)  {detail[:220]}")
            return None


def retry(fn, seconds: float = 45, wait: float = 3, retry_on=(Exception,)):
    """Retry fn until it returns or `seconds` pass; IAM changes take 5 to 20 s to propagate."""
    deadline = time.time() + seconds
    while True:
        try:
            return fn()
        except retry_on:
            if time.time() > deadline:
                raise
            time.sleep(wait)


def derive_role_arn(caller_arn: str) -> str | None:
    """arn:aws:sts::123:assumed-role/Role/Session -> arn:aws:iam::123:role/Role (None for a user)."""
    parts = caller_arn.split(":")
    if len(parts) >= 6 and parts[5].startswith("assumed-role/"):
        role = parts[5].split("/")[1]
        return f"arn:aws:iam::{parts[4]}:role/{role}"
    if len(parts) >= 6 and parts[5].startswith("user/"):
        return caller_arn
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", default=os.environ.get("AWS_PROFILE", "ws"))
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    ap.add_argument("--read-only", action="store_true", help="skip every create/delete probe")
    args = ap.parse_args()

    if os.path.exists(CREDS):
        os.environ.setdefault("AWS_SHARED_CREDENTIALS_FILE", CREDS)
    if os.path.exists(CONFIG):
        os.environ.setdefault("AWS_CONFIG_FILE", CONFIG)
    for v in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
              "AWS_BEARER_TOKEN_BEDROCK"):
        os.environ.pop(v, None)

    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError

    try:
        age_min = int((time.time() - os.path.getmtime(CREDS)) / 60)
        print(f"Credentials file {CREDS} saved {age_min} minutes ago; profile [{args.profile}]; region {args.region}")
    except OSError:
        print(f"No {CREDS}; using profile [{args.profile}] from the default locations")

    p = Probe()
    try:
        session = boto3.Session(profile_name=args.profile, region_name=args.region)
    except Exception as e:  # noqa: BLE001 - ProfileNotFound and friends
        print(f"\nNo credentials saved yet ({type(e).__name__}: {e}).")
        print("Copy the block from Workshop Studio ('Get AWS CLI credentials'), then run:")
        print("    .venv\\Scripts\\python scripts\\aws_creds.py")
        return 2
    tag = uuid.uuid4().hex[:8]

    print("\n== Identity and read access ==")
    ident = p.check("sts get-caller-identity", lambda: session.client("sts").get_caller_identity())
    if not ident:
        print("\nNo usable credentials. Copy a fresh block from Workshop Studio and run scripts\\aws_creds.py again.")
        return 2
    account = ident["Account"]
    caller_arn = ident["Arn"]
    participant_role_arn = derive_role_arn(caller_arn)
    print(f"        account {account}; caller {caller_arn}; principal for trust policies: {participant_role_arn}")

    iam = session.client("iam")
    trust_principal = participant_role_arn
    if participant_role_arn and ":role/" in participant_role_arn:
        def get_role():
            nonlocal trust_principal
            r = iam.get_role(RoleName=participant_role_arn.split("/")[-1])["Role"]
            trust_principal = r["Arn"]
            pb = (r.get("PermissionsBoundary") or {}).get("PermissionsBoundaryArn")
            return f"exact ARN {r['Arn']}; MaxSessionDuration {r['MaxSessionDuration']} s; permissions boundary {pb or 'none'}"
        p.check("iam get-role on the participant role (exact ARN incl. path, boundary)", get_role)

    p.check("cognito-idp list-user-pools", lambda: f"{len(session.client('cognito-idp').list_user_pools(MaxResults=5)['UserPools'])} pools")
    p.check("dynamodb list-tables", lambda: session.client("dynamodb").list_tables(Limit=10)["TableNames"])
    p.check("lambda list-functions", lambda: [f["FunctionName"] for f in session.client("lambda").list_functions(MaxItems=10)["Functions"]])
    p.check("iam list-roles", lambda: f"{len(session.client('iam').list_roles(MaxItems=5)['Roles'])} roles visible")
    p.check("logs describe-log-groups", lambda: f"{len(session.client('logs').describe_log_groups(limit=5)['logGroups'])} groups")

    def region_guard():
        try:
            session.client("dynamodb", region_name="us-west-2").list_tables(Limit=1)
        except ClientError as e:
            return f"refused in us-west-2 as expected: {e.response['Error']['Code']}"
        return "ALLOWED in us-west-2 (no region restriction); we still stay in us-east-1"
    p.check("region guard: dynamodb list-tables in us-west-2", region_guard)

    print("\n== Bedrock ==")
    bedrock = session.client("bedrock")
    profiles = p.check(
        "bedrock list-inference-profiles (nova)",
        lambda: [s["inferenceProfileId"] for s in bedrock.list_inference_profiles(maxResults=1000)["inferenceProfileSummaries"]
                 if "nova" in s["inferenceProfileId"]],
    )
    p.check(f"bedrock get-inference-profile {args.models[0]}",
            lambda: bedrock.get_inference_profile(inferenceProfileIdentifier=args.models[0])["status"])
    rt = session.client("bedrock-runtime")
    working_model = None
    for m in args.models:
        def converse(m=m):
            r = rt.converse(
                modelId=m,
                messages=[{"role": "user", "content": [{"text": "Reply with the single word OK."}]}],
                inferenceConfig={"maxTokens": 16, "temperature": 0},
            )
            return r["output"]["message"]["content"][0].get("text", "")[:40]
        if p.check(f"bedrock converse {m}", converse) is not None:
            working_model = m
            break
    if working_model:
        def tool_use():
            tool_config = {"tools": [{"toolSpec": {
                "name": "read_file", "description": "Read a file from the drive.",
                "inputSchema": {"json": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}}]}
            r = rt.converse(
                modelId=working_model,
                messages=[{"role": "user", "content": [{"text": "Use the read_file tool to read /drive/q3-planning.md. Do not answer without calling the tool."}]}],
                toolConfig=tool_config,
                inferenceConfig={"maxTokens": 200, "temperature": 0},
            )
            if r["stopReason"] != "tool_use":
                raise RuntimeError(f"stopReason={r['stopReason']}; content={r['output']['message']['content']}")
            return "stopReason=tool_use"
        p.check(f"bedrock tool use via Converse on {working_model}", tool_use)
    else:
        p.check("bedrock tool use via Converse", None, skip_reason="no model answered; enable Amazon Nova in the Bedrock console (Model catalog)")

    print("\n== Short-term Bedrock API key (the agent's only credential) ==")
    token = None

    def make_token():
        nonlocal token
        creds = session.get_credentials().get_frozen_credentials()
        os.environ["AWS_PROFILE"] = args.profile
        os.environ["AWS_DEFAULT_REGION"] = args.region
        os.environ["AWS_REGION"] = args.region  # the token generator reads AWS_REGION, not AWS_DEFAULT_REGION
        try:
            import aws_bedrock_token_generator as g
            how = None
            if hasattr(g, "provide_token"):
                try:
                    token = g.provide_token(region=args.region)
                    how = "provide_token(region=...)"
                except TypeError:
                    token = g.provide_token()
                    how = "provide_token()"
            elif hasattr(g, "BedrockTokenGenerator"):
                token = g.BedrockTokenGenerator().get_token(session.get_credentials(), args.region)
                how = "BedrockTokenGenerator().get_token(credentials, region)"
            else:
                raise RuntimeError(f"unknown package API: {dir(g)}")
            ver = getattr(g, "__version__", "?")
            return f"{how}; package version {ver}; token prefix {str(token)[:20]}...; length {len(str(token))}; creds have session token: {bool(creds.token)}"
        finally:
            os.environ.pop("AWS_PROFILE", None)

    p.check("generate short-term Bedrock token (aws-bedrock-token-generator)", make_token)

    if token:
        def bearer_converse():
            os.environ["AWS_BEARER_TOKEN_BEDROCK"] = str(token)
            s2 = boto3.Session(region_name=args.region)  # no profile, no keys: only the bearer token
            r = s2.client("bedrock-runtime").converse(
                modelId=working_model or args.models[0],
                messages=[{"role": "user", "content": [{"text": "Reply with the single word OK."}]}],
                inferenceConfig={"maxTokens": 16, "temperature": 0},
            )
            return r["output"]["message"]["content"][0].get("text", "")[:40]
        p.check("converse with ONLY the bearer token", bearer_converse)

        def bearer_cannot_dynamodb():
            s2 = boto3.Session(region_name=args.region)
            try:
                s2.client("dynamodb").list_tables(Limit=1)
            except NoCredentialsError:
                return "NoCredentialsError, as it should be: the token is Bedrock-only"
            except ClientError as e:
                return f"refused: {e.response['Error']['Code']}"
            raise RuntimeError("DynamoDB call SUCCEEDED with only the bearer token in the environment")
        p.check("bearer token cannot call DynamoDB", bearer_cannot_dynamodb)
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)

    print("\n== Policy simulation (best effort) ==")
    if participant_role_arn:
        def simulate():
            iam = session.client("iam")
            res = iam.simulate_principal_policy(PolicySourceArn=participant_role_arn, ActionNames=NEEDED_ACTIONS)
            denied = [r["EvalActionName"] for r in res["EvaluationResults"] if r["EvalDecision"] != "allowed"]
            return "all allowed" if not denied else f"NOT allowed: {denied}"
        p.check("iam simulate-principal-policy for every action MYTOPIA needs", simulate)
    else:
        p.check("iam simulate-principal-policy", None, skip_reason=f"caller is not a role or user: {caller_arn}")

    if args.read_only:
        finish(p)
        return 0

    print("\n== Write probes (created, then deleted) ==")
    ddb = session.client("dynamodb")
    table = f"mytopia-probe-{tag}"

    def ddb_roundtrip():
        ddb.create_table(TableName=table, BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}])
        ddb.get_waiter("table_exists").wait(TableName=table, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
        ddb.put_item(TableName=table, Item={"id": {"S": "a"}, "status": {"S": "ACTIVE"}},
                     ConditionExpression="attribute_not_exists(id)")
        got = ddb.get_item(TableName=table, Key={"id": {"S": "a"}}, ConsistentRead=True)["Item"]
        return f"put+consistent get ok: {got['status']['S']}"
    p.check("dynamodb create table, conditional put, consistent get", ddb_roundtrip)
    p.check("dynamodb delete table", lambda: ddb.delete_table(TableName=table)["TableDescription"]["TableStatus"])

    sts = session.client("sts")
    role_name = f"mytopia-probe-role-{tag}"
    role_arn = None

    def create_role():
        nonlocal role_arn
        statements = [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
        if trust_principal:
            statements.insert(0, {"Effect": "Allow", "Principal": {"AWS": trust_principal}, "Action": "sts:AssumeRole"})
        trust = {"Version": "2012-10-17", "Statement": statements}
        role_arn = iam.create_role(RoleName=role_name, AssumeRolePolicyDocument=json.dumps(trust),
                                   Description="MYTOPIA probe; safe to delete")["Role"]["Arn"]
        iam.put_role_policy(RoleName=role_name, PolicyName="probe", PolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [
                {"Effect": "Allow", "Action": ["dynamodb:ListTables", "sts:GetCallerIdentity"], "Resource": "*"},
                {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*"},
            ]}))
        return role_arn
    p.check("iam create role (trusts the participant role and Lambda) + inline policy", create_role)

    if role_arn and participant_role_arn:
        def assume():
            r = retry(lambda: sts.assume_role(RoleArn=role_arn, RoleSessionName="mytopia-gateway-probe", DurationSeconds=900),
                      seconds=60, wait=4, retry_on=(ClientError,))
            c = r["Credentials"]
            narrow = boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
                                   aws_session_token=c["SessionToken"], region_name=args.region)
            who = narrow.client("sts").get_caller_identity()["Arn"]
            try:
                narrow.client("iam").list_roles(MaxItems=1)
                extra = "but the narrow session could list IAM roles (unexpected)"
            except ClientError as e:
                extra = f"and the narrow session is refused iam:ListRoles ({e.response['Error']['Code']}), as it should be"
            return f"assumed as {who} for 900 s (chained from the session credentials) {extra}"
        p.check("sts assume-role into the new role (role chaining)", assume)

        def assume_too_long():
            try:
                sts.assume_role(RoleArn=role_arn, RoleSessionName="mytopia-probe-long", DurationSeconds=7200)
            except ClientError as e:
                return f"refused as expected: {e.response['Error']['Code']}: {e.response['Error']['Message'][:120]}"
            return "2-hour chained session was GRANTED (source credentials are not from an assumed role)"
        p.check("sts assume-role with DurationSeconds=7200 (expect refusal: chaining caps at 1 h)", assume_too_long)

    lam = session.client("lambda")
    fn_name = f"mytopia-probe-fn-{tag}"
    if role_arn:
        def create_fn():
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("index.py", "def handler(event, context):\n    return {'ok': True, 'echo': event}\n")
            retry(lambda: lam.create_function(FunctionName=fn_name, Runtime="python3.12", Role=role_arn,
                                              Handler="index.handler", Code={"ZipFile": buf.getvalue()},
                                              Timeout=10, MemorySize=128, Description="MYTOPIA probe; safe to delete"),
                  seconds=60, wait=4, retry_on=(ClientError,))
            lam.get_waiter("function_active_v2").wait(FunctionName=fn_name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
            out = lam.invoke(FunctionName=fn_name, Payload=json.dumps({"probe": tag}))
            body = json.loads(out["Payload"].read())
            if not body.get("ok"):
                raise RuntimeError(f"unexpected payload {body}")
            return f"created with the probe role, invoked: {body}"
        p.check("lambda create function (python3.12) + invoke", create_fn)
        p.check("lambda delete function", lambda: lam.delete_function(FunctionName=fn_name) and "deleted")

        def delete_role():
            iam.delete_role_policy(RoleName=role_name, PolicyName="probe")
            iam.delete_role(RoleName=role_name)
            return "deleted"
        p.check("iam delete role", delete_role)

    print("\n== Cognito machine-to-machine (created, then deleted) ==")
    cog = session.client("cognito-idp")
    pool_id = None

    def create_pool():
        nonlocal pool_id
        try:
            pool_id = cog.create_user_pool(PoolName=f"mytopia-probe-{tag}", UserPoolTier="ESSENTIALS",
                                           DeletionProtection="INACTIVE")["UserPool"]["Id"]
            return f"{pool_id} (ESSENTIALS tier)"
        except ClientError as e:
            if e.response["Error"]["Code"] not in ("InvalidParameterException", "TierUnavailableException", "ValidationException"):
                raise
            pool_id = cog.create_user_pool(PoolName=f"mytopia-probe-{tag}", DeletionProtection="INACTIVE")["UserPool"]["Id"]
            return f"{pool_id} (default tier; ESSENTIALS refused: {e.response['Error']['Message'][:80]})"
    p.check("cognito create user pool", create_pool)

    client_id = secret = None
    if pool_id:
        def create_client():
            nonlocal client_id, secret
            cog.create_resource_server(UserPoolId=pool_id, Identifier="mytopia", Name="MYTOPIA gateway",
                                       Scopes=[{"ScopeName": "tools", "ScopeDescription": "call gateway tools"}])
            base = dict(UserPoolId=pool_id, ClientName="probe-agent", GenerateSecret=True,
                        AllowedOAuthFlowsUserPoolClient=True, AllowedOAuthFlows=["client_credentials"],
                        AllowedOAuthScopes=["mytopia/tools"],
                        AccessTokenValidity=5, TokenValidityUnits={"AccessToken": "minutes"})
            try:
                c = cog.create_user_pool_client(ExplicitAuthFlows=["ALLOW_CLIENT_TOKEN_AUTH"], **base)["UserPoolClient"]
                how = "with ExplicitAuthFlows=[ALLOW_CLIENT_TOKEN_AUTH]"
            except ClientError as e:
                if e.response["Error"]["Code"] != "InvalidParameterException":
                    raise
                c = cog.create_user_pool_client(**base)["UserPoolClient"]
                how = f"WITHOUT ALLOW_CLIENT_TOKEN_AUTH (refused: {e.response['Error']['Message'][:70]})"
            client_id, secret = c["ClientId"], c["ClientSecret"]
            return f"client {client_id[:8]}..., scope mytopia/tools, 5-minute tokens, {how}"
        p.check("cognito create resource server + M2M app client", create_client)

    token_info: dict = {}
    if client_id:
        def get_client_token():
            from botocore import UNSIGNED
            from botocore.config import Config
            import jwt
            anon = boto3.Session(region_name=args.region).client("cognito-idp", config=Config(signature_version=UNSIGNED))
            r = retry(lambda: anon.get_client_token(ClientId=client_id, Secret=secret, Scopes=["mytopia/tools"]),
                      seconds=30, wait=3, retry_on=(ClientError,))["ClientAuthenticationResult"]
            claims = jwt.decode(r["AccessToken"], options={"verify_signature": False})
            token_info.update(token=r["AccessToken"], claims=claims)
            return (f"ExpiresIn={r['ExpiresIn']} s; exp-iat={claims.get('exp', 0) - claims.get('iat', 0)} s; "
                    f"token_use={claims.get('token_use')}; scope={claims.get('scope')}; "
                    f"sub==client_id: {claims.get('sub') == client_id}; iss={claims.get('iss')}")
        p.check("cognito GetClientToken, unsigned, no domain (how the launcher mints tokens)", get_client_token)

        if token_info:
            def verify_jwt():
                import jwt
                iss = token_info["claims"]["iss"]
                key = jwt.PyJWKClient(iss + "/.well-known/jwks.json").get_signing_key_from_jwt(token_info["token"])
                claims = jwt.decode(token_info["token"], key.key, algorithms=["RS256"], issuer=iss,
                                    options={"verify_aud": False})
                return f"RS256 signature verified against the pool's JWKS; client_id claim {str(claims.get('client_id', '?'))[:8]}..."
            p.check("verify the token offline against the pool's JWKS (the gateway's own check)", verify_jwt)

    if pool_id:
        p.check("cognito delete user pool", lambda: (cog.delete_user_pool(UserPoolId=pool_id), "deleted")[1])

    finish(p)
    return 0


def finish(p: Probe) -> None:
    print("\n== Summary ==")
    width = max(len(r["check"]) for r in p.rows) + 2
    for r in p.rows:
        print(f"{r['status']:<5} {r['check']:<{width}} {r['detail'][:100]}")
    fails = [r for r in p.rows if r["status"] == "FAIL"]
    print(f"\n{len(p.rows) - len(fails)} passed, {len(fails)} failed")
    with open(RESULT, "w", encoding="utf-8") as f:
        json.dump({"rows": p.rows, "written_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, f, indent=1)
    print(f"Saved {RESULT}")


if __name__ == "__main__":
    sys.exit(main())
