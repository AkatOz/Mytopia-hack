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
| IAM role | `mytopia-gateway-role` | trusted by the participant role, plus `mytopia-host-role` once `host_ec2.py` made it; 1-hour sessions; inline policy: GetItem/UpdateItem/PutItem/DeleteItem/Scan on `mytopia_agents`, PutItem/Query on `mytopia_events`, InvokeFunction on `mytopia-tools`, Create/DeleteUserPoolClient on the pool, nothing else |

Local files it writes (all git-ignored): `infra\gateway_role.txt` (the role ARN), `[profile gateway]` in `gateway\.aws-config`, the AWS lines of `gateway\.env` (MODE=aws, TOOLS_MODE=lambda, TOKEN_MODE=cognito, COGNITO_POOL_ID, GATEWAY_ROLE_ARN, the absolute AWS_* file paths) and the Cognito lines of `agent\.env` (TOKEN_MODE=cognito and both client ids and secrets). A missing `.env` starts from its `.env.example`; other lines are kept.

## How the gateway gets credentials

Profile `gateway` has no keys. Its `credential_process` runs `infra\gateway_creds.py`, which reads profile `ws`, calls `sts:AssumeRole` on `mytopia-gateway-role` for one hour (the maximum for a chained role) and prints the standard JSON. boto3 runs it again before each expiry, so the gateway keeps working when the Workshop keys are refreshed, without a restart. From the gateway role, `dynamodb list-tables` is refused: the role can touch two tables, one function and the app clients of one pool.

The agent gets no AWS credentials at all: a Bedrock bearer key (`scripts\bedrock_key.py`, Bedrock only, us-east-1 only, at most 12 hours or the Workshop session) and a 5-minute Cognito access token, which the launcher mints with the agent's client secret from `agent\.env` (the agent never holds the secret).

## Refresh procedure (about 30 s; do it at 8:45 on Sunday)

1. Workshop Studio dashboard: **Get AWS CLI credentials**, save the block as `Desktop\creds.txt`.
2. `.venv\Scripts\python scripts\aws_creds.py` (saves profile ws, deletes creds.txt).
3. `.venv\Scripts\python scripts\whoami.py gateway` must show `assumed-role/mytopia-gateway-role/...`. The running gateway picks the new keys up at its next refresh; restart it only if its role session already expired.
4. `.venv\Scripts\python scripts\bedrock_key.py`, then restart the agent through the launcher (it reads `agent\.env`).

Cognito is unaffected by the refresh: the agents authenticate with client secrets, not AWS keys.

## Host it on EC2

`infra\host_ec2.py` puts the gateway, the island and the agents on one EC2 server behind HTTPS and a team password. [docs/HOSTING.md](../docs/HOSTING.md) explains the design and how to check, update and take down the server. It runs as profile ws after `provision.py`, needs `bcrypt`, and is safe to run again: it finds the role, the trust line, the firewall and a running server before it creates anything.

```powershell
.venv\Scripts\python -m pip install bcrypt               # only host_ec2.py needs it
.venv\Scripts\python infra\host_ec2.py --dry-run         # the plan, no AWS calls
.venv\Scripts\python infra\host_ec2.py                   # creates or finds everything; prints the address
.venv\Scripts\python infra\host_ec2.py --status          # the server, its state and its address
.venv\Scripts\python -m pytest tests\test_host_ec2.py -q # offline tests, no AWS
```

| Resource | Name | Notes |
|---|---|---|
| IAM role and instance profile | `mytopia-host-role` | trusted by EC2; inline policy: `sts:AssumeRole` on `mytopia-gateway-role`, Bedrock `InvokeModel`, `InvokeModelWithResponseStream`, `CallWithBearerToken` on any model, `ssm:GetParameter` on the seed parameter; plus `AmazonSSMManagedInstanceCore` (Session Manager; it also allows `ssm:GetParameter` on any parameter) |
| SSM parameter | `/mytopia/seed-agent-lines` | SecureString (the account's aws/ssm key): the seed agents' four Cognito lines from `agent\.env`; the first boot appends them to the server's `agent/.env` |
| Trust line | on `mytopia-gateway-role` | lets `mytopia-host-role` assume it; `provision.py` keeps it when it rewrites that trust |
| Security group | `mytopia-web` | default VPC; tcp 80 and 443 from anywhere, nothing else |
| EC2 instance | `mytopia-gateway` | t3.medium (t3.small or t2.medium if refused), Amazon Linux 2023, IMDSv2 only, 20 GB gp3; first boot `host_userdata.sh` |

It writes the address and a new password (username `mytopia`) to `Desktop\MYTOPIA_SITE_ACCESS.txt`, outside the repo, or to `MYTOPIA_SITE_ACCESS-<instance id>.txt` when that file is already there, and prints no secret. The server clones the pushed branch from GitHub (main by default), not this folder.

## Delete it all

Take the website down first, then the rest:

```powershell
.venv\Scripts\python infra\host_ec2.py --teardown --yes   # first: the server, the firewall, the seed parameter, the trust line, the server's role
.venv\Scripts\python infra\teardown.py --dry-run     # what would go
.venv\Scripts\python infra\teardown.py --yes         # deletes the Lambda, both roles, both tables, the pool; sets the .env files back to local mode
```
