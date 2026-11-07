# infra: MYTOPIA's AWS resources

This folder creates, refreshes and deletes everything MYTOPIA runs on in AWS (us-east-1, the Workshop Studio account). The scripts run as profile `ws` from `gateway\.aws-credentials` (written by `scripts\aws_creds.py`) and never read `~\.aws`; no long-lived keys are created anywhere.

## Run it

```powershell
cd "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia"
.venv\Scripts\python scripts\aws_creds.py            # once per Workshop session: saves profile ws
.venv\Scripts\python infra\provision.py --dry-run    # prints the plan, calls nothing
.venv\Scripts\python infra\provision.py              # creates or finds everything; safe to run again
.venv\Scripts\python scripts\whoami.py gateway       # expect assumed-role/mytopia-gateway-role/mytopia-gateway
.venv\Scripts\python scripts\bedrock_key.py          # writes AWS_BEARER_TOKEN_BEDROCK into agent\.env
.venv\Scripts\python -m pytest tests\test_infra_dryrun.py -q   # offline tests, no AWS
```

`provision.py` is idempotent: every resource is found by name first and only created when missing, so a second run changes nothing (the Lambda code is re-uploaded from `tools_lambda\handler.py`, and the seed rows keep their status). If any call fails with `ExpiredToken`, the Workshop keys expired: fetch new ones and re-run `scripts\aws_creds.py`.

## What it creates

| Resource | Name | Notes |
|---|---|---|
| Cognito user pool | `mytopia` | ESSENTIALS tier, deletion protection off |
| Resource server | `mytopia`, scope `tools` | the token scope is `mytopia/tools` |
| App clients | `research-bot`, `ops-bot` | client secret, `ALLOW_CLIENT_TOKEN_AUTH` only, client_credentials, 5-minute access tokens |
| DynamoDB table | `mytopia_agents` | PK `agent` (S), on-demand; seed rows carry the real client ids |
| DynamoDB table | `mytopia_events` | PK `pk` (S), SK `seq` (N), on-demand |
| IAM role | `mytopia-tools-exec` | trusted by Lambda; inline policy: CloudWatch Logs only |
| Lambda | `mytopia-tools` | python3.12, `handler.handler`, the zip holds `handler.py` alone, 15 s timeout |
| IAM role | `mytopia-gateway-role` | trusted by the participant role only; 1-hour sessions; inline policy: GetItem/UpdateItem on `mytopia_agents`, PutItem/Query on `mytopia_events`, InvokeFunction on `mytopia-tools`, nothing else |

Local files it writes (all git-ignored): `infra\gateway_role.txt` (the role ARN), `[profile gateway]` in `gateway\.aws-config`, the AWS lines of `gateway\.env` (MODE=aws, TOOLS_MODE=lambda, TOKEN_MODE=cognito, COGNITO_POOL_ID, GATEWAY_ROLE_ARN, the absolute AWS_* file paths) and the Cognito lines of `agent\.env` (TOKEN_MODE=cognito and both client ids and secrets). A missing `.env` starts from its `.env.example`; other lines are kept.

## How the gateway gets credentials

Profile `gateway` has no keys. Its `credential_process` runs `infra\gateway_creds.py`, which reads profile `ws`, calls `sts:AssumeRole` on `mytopia-gateway-role` for one hour (the maximum for a chained role) and prints the standard JSON. boto3 runs it again before each expiry, so the gateway keeps working when the Workshop keys are refreshed, without a restart. From the gateway role, `dynamodb list-tables` is refused: the role can touch two tables and one function.

The agent gets no AWS credentials at all: a Bedrock bearer key (`scripts\bedrock_key.py`, Bedrock only, us-east-1 only, at most 12 hours or the Workshop session) and its own Cognito client secret.

## Refresh procedure (about 30 s; do it at 8:45 on Sunday)

1. Workshop Studio dashboard: **Get AWS CLI credentials**, save the block as `Desktop\creds.txt`.
2. `.venv\Scripts\python scripts\aws_creds.py` (saves profile ws, deletes creds.txt).
3. `.venv\Scripts\python scripts\whoami.py gateway` must show `assumed-role/mytopia-gateway-role/...`. The running gateway picks the new keys up at its next refresh; restart it only if its role session already expired.
4. `.venv\Scripts\python scripts\bedrock_key.py`, then restart the agent through the launcher (it reads `agent\.env`).

Cognito is unaffected by the refresh: the agents authenticate with client secrets, not AWS keys.

## Delete it all

```powershell
.venv\Scripts\python infra\teardown.py --dry-run     # what would go
.venv\Scripts\python infra\teardown.py --yes         # deletes the Lambda, both roles, both tables, the pool; sets the .env files back to local mode
```
