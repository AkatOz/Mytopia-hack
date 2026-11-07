# AWS credential design for MYTOPIA under the Workshop Studio rules

> Produced 2026-11-07 about 12:20 by a four-lens research workflow (Opus agents) with one adversarial fact check per high-stakes claim; 12 claims checked, 2 confirmed, 10 left unverified because only the live account can answer them (the probe does). **Mapping to this repo:** the research's `ws_source.ini` is our `gateway\.aws-credentials` (profile `[ws]`, written by `scriptsws_creds.ps1`); its `tools\set_source.py` is `scriptsws_creds.ps1` plus `scriptsedrock_key.py`; its `tools\gw_creds.py` is `infra\gateway_creds.py` (the `credential_process` for profile `[gateway]` in `gateway\.aws-config`); its table names `mytopia-badges` / `mytopia-audit` are our contract's `mytopia_agents` / `mytopia_events`; its scope `mytopia-gateway/tools.invoke` is our `mytopia/tools`; its agent names are our `research-bot` / `ops-bot`. The decisions below stand; the names in the snippets are illustrative.

## 1. Decision

**Provisioning script.** It runs once, in a dedicated "admin" PowerShell window. Paste the Workshop Studio "Get AWS CLI credentials" values there as process-scope `$Env:` variables only. Do NOT run the organizers' `set_aws_creds.ps1` on this laptop. It writes the participant keys to User-scope environment variables and to `$HOME\.aws_workshop_env.ps1`, which `$PROFILE` loads. Every new terminal, including the agent's, would then start with full participant rights. If it has already been run, undo it (§4 step 3).

**Gateway.** It runs as `mytopia-gateway-role`, created today. Its trust policy names the participant role's exact IAM ARN, read with `iam.get_role`. Its inline policy allows only GetItem/UpdateItem on `mytopia-badges`, PutItem/Query on `mytopia-audit`, and InvokeFunction on `mytopia-tools`.
- Credentials come from a `credential_process` profile. A small script reads `ws_source.ini` on every refresh and calls `AssumeRole(DurationSeconds=3600)`. This is role chaining, so 1 hour is the hard maximum. botocore re-runs the script before each expiry.
- The gateway shell has no `AWS_ACCESS_KEY_ID` set. Environment variables take precedence over profiles, so leftover keys would silently give the gateway full participant rights.

**Agent.** It holds three things and no AWS credentials:
1. A short-term Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`), minted directly from the Workshop session. It is not minted from a chained role, because that would cap it at 1 hour.
2. Its own Cognito client id and secret.
3. `AWS_REGION=us-east-1`.

Strands uses `BedrockModel(api_key=...)`, which sends unsigned requests with a bearer header. Cognito tokens come from `get_client_token` on a boto3 client built with `Config(signature_version=UNSIGNED)`. That call needs no AWS credentials and no domain. From the agent's shell, `aws lambda invoke` and `aws dynamodb get-item` must fail with "Unable to locate credentials".

**Refresh procedure (about 30 s).**
1. Dashboard → Get AWS CLI credentials.
2. `python tools\set_source.py` writes `ws_source.ini` and mints a new Bedrock key to the clipboard.
3. In the gateway shell, run `aws sts get-caller-identity --profile mytopia-gateway`. It should show `assumed-role/mytopia-gateway-role`.
4. Restart the agent with the new key. Restart the gateway only if its role session has already expired.

Cognito agent auth is unaffected, because it uses client secrets, not AWS credentials. On 2026-11-08, do the refresh at 8:45–8:50, not 9:00. Then read the real Expiration (`aws configure export-credentials`) and refresh again before that time if judging runs past it. The session could last as little as 1 hour.

**For the judges (two sentences).** "The gateway runs under a role we created that can only touch two DynamoDB tables and one Lambda function, and the agent holds only a short-lived Bedrock bearer token plus its own Cognito client secret, so from the agent's shell `aws lambda invoke` fails. Because Cognito cannot revoke machine-to-machine access tokens, tokens expire after 5 minutes and every call does a strongly consistent DynamoDB badge read, which is our real kill switch; the narrow role limits the gateway process, not our teammates, who share the same Workshop role."

## 2. Facts we rely on

| Fact | Source URL | Status |
|---|---|---|
| Organizer rules: no long-lived IAM keys, no AWS calls from the frontend, us-east-1 only, never hardcode credentials | https://raw.githubusercontent.com/SCUACM/aws-access-26/main/1-setup/README.md | verified |
| Tokens "auto-expire every few hours". Fix: get credentials again from the dashboard. CloudShell is pre-authenticated | same | verified |
| `set_aws_creds.ps1` persists keys at User scope and in `$HOME\.aws_workshop_env.ps1` loaded by `$PROFILE`. It writes no `~/.aws` profile | https://raw.githubusercontent.com/SCUACM/aws-access-26/main/1-setup/set_aws_creds.ps1 | verified |
| Each member joins with an @scu.edu email. A personal email lands you outside the team account | 1-setup/README.md | verified |
| Participant identity is `assumed-role/WSParticipantRole/Participant` | https://ec2spotworkshops.com/karpenter/010_prerequisites/aws_event.html | likely (not confirmed for this event) |
| Participant role can CreateRole / PutRolePolicy / PassRole / AssumeRole | https://github.com/smart-campus-ai/smart-campus-ai/issues/98 vs https://github.com/kallmekabir/AWS-Track/pull/2 | unverified (sources conflict) |
| CLI credentials last at most 12 h | https://github.com/kallmekabir/AWS-Track/pull/2 | refuted-and-corrected: undocumented. STS allows 15 min–12 h, at most 1 h if Workshop Studio itself chains. Assume about 1 h |
| A click at 8:55 gives credentials valid through judging | (none) | refuted-and-corrected: no evidence. Read the Expiration and refresh before it |
| Role chaining caps the session at 1 h. DurationSeconds > 3600 fails (it is not clamped) | https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html | verified |
| Error text: "The requested DurationSeconds exceeds the 1 hour session limit for roles assumed by role chaining." | https://repost.aws/knowledge-center/iam-role-chaining-limit | likely |
| A grant to a role ARN is still subject to an implicit deny in that role's permissions boundary or session policy | https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html | verified |
| An assumed-role ARN omits the IAM path. Use `iam.get_role(...)['Role']['Arn']` | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html | verified |
| IAM is eventually consistent. `role_exists` does not mean the role is assumable | https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html | verified |
| Lambda "The role defined for the function cannot be assumed by Lambda" right after CreateRole. Retry about 10 s | https://www.repost.aws/questions/QUb-mYhQOkTjmB--xRnKvfPw/ | likely |
| `role_arn`+`source_profile` freezes the source credentials at first resolve (botocore 1.43.126). Refresh window: advisory at 15 min before expiry, mandatory at 10 min | local botocore/credentials.py | verified |
| `credential_process` JSON {Version:1,…,Expiration} is re-run before expiry. On Windows the path must be quoted, with no %VARS% and no ~ | https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html | verified |
| GetFederationToken / GetSessionToken cannot be called with AssumeRole credentials | https://docs.aws.amazon.com/STS/latest/APIReference/API_GetFederationToken.html | verified |
| Short-term Bedrock key: lifetime is the shorter of 12 h or the session, it inherits the principal's permissions, and it works in one Region only | https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-how.html | verified |
| Keys work only for Bedrock and Bedrock Runtime (not Agents, not bidirectional streaming) | https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html | verified |
| Use is gated by `bedrock:CallWithBearerToken`. Generation cannot be blocked | https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-permissions.html | verified |
| `aws-bedrock-token-generator` 1.1.0: `provide_token(region, aws_credentials_provider, expiry)`. It reads AWS_REGION, never AWS_DEFAULT_REGION. No cache (contrary to the docs). Signs locally | https://pypi.org/pypi/aws-bedrock-token-generator/json ; https://github.com/aws/aws-bedrock-token-generator-python | verified |
| botocore ≥1.39.12 uses AWS_BEARER_TOKEN_BEDROCK only for bearer-capable Bedrock services | https://raw.githubusercontent.com/boto/botocore/develop/CHANGELOG.rst | verified |
| Strands 1.64.0 `BedrockModel(api_key=)` sends unsigned requests with a bearer header, fixed at construction. Default region us-west-2. Passing region_name together with boto_session raises ValueError | https://strandsagents.com/latest/documentation/docs/user-guide/concepts/model-providers/amazon-bedrock/ | verified |
| Nova 2 Lite has no In-Region option in us-east-1. Use `us.amazon.nova-2-lite-v1:0`, which routes to us-east-1, us-east-2 and us-west-2 | https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html | verified |
| `amazon.nova-lite-v1:0` runs In-Region in us-east-1 and is Active | https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html | verified |
| Commercial Regions have no manual model-access step. Amazon models need no Marketplace subscription | https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html | verified (the organizers' README still says to check model access) |
| Whether the participant role or event SCPs allow CallWithBearerToken or Nova 2 Lite | (none) | unverified |
| GetClientToken (Aug 31 2026) issues an M2M token with no domain. IAM is not evaluated | https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetClientToken.html | verified |
| boto3 must use `signature_version=UNSIGNED` (the model has no noAuth trait) | botocore service-2.json + local test | verified (correction) |
| GetClientToken needs a client secret and `ALLOW_CLIENT_TOKEN_AUTH` as the only ExplicitAuthFlow | https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html | verified |
| GetClientToken honors AccessTokenValidity=5 min (ExpiresIn=300) | (doc example shows 3600) | unverified |
| Default issuer `https://cognito-idp.us-east-1.amazonaws.com/POOL_ID`. `IssuerConfiguration` is ORIGINAL or UPDATED | https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html | verified |
| M2M token: sub = client_id, token_use = access, no aud. It cannot be revoked and is valid until exp | https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html | verified |
| ClientAuthentication quota: 150 RPS, cannot be raised | https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html | verified |
| M2M pricing: per token, no free tier, example rate $0.00225 per token | https://aws.amazon.com/cognito/pricing/ | likely |

## 3. Provisioning parameters

Run these in the admin window, with the session credentials in `$Env:` and `AWS_REGION=us-east-1`. Prefix and tag every resource with `mytopia`. Table key schemas and the Lambda runtime are inferred; the reports do not specify them.

```python
import json, time, boto3, botocore
from botocore.exceptions import ClientError
R='us-east-1'; TAG=[{'Key':'project','Value':'mytopia'}]
sts=boto3.client('sts',region_name=R); iam=boto3.client('iam')
cog=boto3.client('cognito-idp',region_name=R); ddb=boto3.client('dynamodb',region_name=R)
lam=boto3.client('lambda',region_name=R)
me=sts.get_caller_identity(); acct=me['Account']
src_role_arn=iam.get_role(RoleName=me['Arn'].split('/')[1])['Role']['Arn']  # includes path
```

**Step 1: Cognito pool, resource server and one M2M client per agent**
```python
pid=cog.create_user_pool(PoolName='mytopia',UserPoolTier='ESSENTIALS',
        DeletionProtection='INACTIVE')['UserPool']['Id']   # IssuerConfiguration omitted -> ORIGINAL
cog.create_resource_server(UserPoolId=pid,Identifier='mytopia-gateway',Name='MYTOPIA MCP Gateway',
    Scopes=[{'ScopeName':'tools.invoke','ScopeDescription':'Call gateway tools'}])
clients={}
for a in ['agent-alpha','agent-beta']:
    c=cog.create_user_pool_client(UserPoolId=pid,ClientName=a,GenerateSecret=True,
        ExplicitAuthFlows=['ALLOW_CLIENT_TOKEN_AUTH'],          # must be explicit and alone
        AllowedOAuthFlowsUserPoolClient=True,AllowedOAuthFlows=['client_credentials'],
        AllowedOAuthScopes=['mytopia-gateway/tools.invoke'],
        AccessTokenValidity=5,TokenValidityUnits={'AccessToken':'minutes'},
        EnableTokenRevocation=True)['UserPoolClient']
    clients[a]=(c['ClientId'],c['ClientSecret'])   # write to a gitignored per-agent .env
iss=cog.describe_user_pool(UserPoolId=pid)['UserPool']  # check IssuerConfiguration
```
Domain (fallback only):
```python
cog.create_user_pool_domain(Domain=f'mytopia-{acct}',UserPoolId=pid,ManagedLoginVersion=2)
while cog.describe_user_pool_domain(Domain=f'mytopia-{acct}')['DomainDescription'].get('Status')!='ACTIVE':
    time.sleep(5)   # duration undocumented
# token: POST https://mytopia-<acct>.auth.us-east-1.amazoncognito.com/oauth2/token
```

**Step 2: DynamoDB (inferred schema)**
```python
ddb.create_table(TableName='mytopia-badges',BillingMode='PAY_PER_REQUEST',
    AttributeDefinitions=[{'AttributeName':'client_id','AttributeType':'S'}],
    KeySchema=[{'AttributeName':'client_id','KeyType':'HASH'}],Tags=TAG)
ddb.create_table(TableName='mytopia-audit',BillingMode='PAY_PER_REQUEST',
    AttributeDefinitions=[{'AttributeName':'chain','AttributeType':'S'},{'AttributeName':'seq','AttributeType':'N'}],
    KeySchema=[{'AttributeName':'chain','KeyType':'HASH'},{'AttributeName':'seq','KeyType':'RANGE'}],Tags=TAG)
for t in ['mytopia-badges','mytopia-audit']: ddb.get_waiter('table_exists').wait(TableName=t)
```

**Step 3: Lambda execution role and function**
```python
lt={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':'lambda.amazonaws.com'},'Action':'sts:AssumeRole'}]}
exec_arn=iam.create_role(RoleName='mytopia-tools-exec',AssumeRolePolicyDocument=json.dumps(lt),Tags=TAG)['Role']['Arn']
iam.attach_role_policy(RoleName='mytopia-tools-exec',
    PolicyArn='arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
iam.get_waiter('role_exists').wait(RoleName='mytopia-tools-exec')
z=open('tools.zip','rb').read()
for _ in range(12):
    try: lam.create_function(FunctionName='mytopia-tools',Runtime='python3.13',Role=exec_arn,
            Handler='app.handler',Code={'ZipFile':z},Tags={'project':'mytopia'}); break
    except ClientError as e:
        if e.response['Error']['Code']!='InvalidParameterValueException': raise
        time.sleep(10)          # 'cannot be assumed by Lambda' = IAM propagation
lam.get_waiter('function_active_v2').wait(FunctionName='mytopia-tools')
```
The caller needs `iam:PassRole` on `mytopia-tools-exec`.

**Step 4: Gateway role**
```python
trust={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'AWS':src_role_arn},'Action':'sts:AssumeRole'}]}
iam.create_role(RoleName='mytopia-gateway-role',AssumeRolePolicyDocument=json.dumps(trust),
                MaxSessionDuration=3600,Tags=TAG)
T=lambda n:f'arn:aws:dynamodb:{R}:{acct}:table/{n}'
perm={'Version':'2012-10-17','Statement':[
 {'Effect':'Allow','Action':['dynamodb:GetItem','dynamodb:UpdateItem'],'Resource':T('mytopia-badges')},
 {'Effect':'Allow','Action':['dynamodb:PutItem','dynamodb:Query'],'Resource':[T('mytopia-audit'),T('mytopia-audit')+'/index/*']},
 {'Effect':'Allow','Action':'lambda:InvokeFunction','Resource':f'arn:aws:lambda:{R}:{acct}:function:mytopia-tools'}]}
iam.put_role_policy(RoleName='mytopia-gateway-role',PolicyName='narrow',PolicyDocument=json.dumps(perm))
iam.get_waiter('role_exists').wait(RoleName='mytopia-gateway-role')
gw=iam.get_role(RoleName='mytopia-gateway-role')['Role']['Arn']
for _ in range(18):
    try: sts.assume_role(RoleArn=gw,RoleSessionName='probe',DurationSeconds=3600); break  # never >3600
    except ClientError as e:
        if e.response['Error']['Code']!='AccessDenied': raise
        time.sleep(5)
```
Strong consistency is a `ConsistentRead=True` request parameter on GetItem. It needs no extra IAM action (inferred).

**Step 5: Assume-role profile (credential_process)**
```ini
# C:\Users\bobvu\.mytopia\config   (AWS_CONFIG_FILE for the gateway shell)
[profile mytopia-gateway]
credential_process = "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia\.venv\Scripts\python.exe" -I "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia\tools\gw_creds.py"
region = us-east-1
```
```python
# tools\gw_creds.py
import configparser, json, boto3
s=configparser.ConfigParser(); s.read(r'C:\Users\bobvu\.mytopia\ws_source.ini'); s=s['ws-source']
r=boto3.client('sts',region_name='us-east-1',aws_access_key_id=s['aws_access_key_id'],
   aws_secret_access_key=s['aws_secret_access_key'],aws_session_token=s['aws_session_token']
  ).assume_role(RoleArn='arn:aws:iam::ACCOUNT:role/mytopia-gateway-role',
                RoleSessionName='mytopia-gateway',DurationSeconds=3600)['Credentials']
print(json.dumps({'Version':1,'AccessKeyId':r['AccessKeyId'],'SecretAccessKey':r['SecretAccessKey'],
                  'SessionToken':r['SessionToken'],'Expiration':r['Expiration'].isoformat()}))
```

**Step 6: Short-term Bedrock key (in the admin window)**
```python
from datetime import timedelta
from botocore.credentials import EnvProvider
from aws_bedrock_token_generator import provide_token
tok=provide_token(region='us-east-1',aws_credentials_provider=EnvProvider(),expiry=timedelta(hours=12))
# actual life = min(12h, remaining Workshop session). Treat as secret (contains session token).
```

**Agent side**
```python
model=BedrockModel(model_id=os.environ.get('MODEL_ID','us.amazon.nova-2-lite-v1:0'),
                   region_name='us-east-1',api_key=os.environ['AWS_BEARER_TOKEN_BEDROCK'])
c=boto3.client('cognito-idp',region_name='us-east-1',config=botocore.config.Config(signature_version=botocore.UNSIGNED))
r=c.get_client_token(ClientId=CID,Secret=SEC,Scopes=['mytopia-gateway/tools.invoke'])['ClientAuthenticationResult']
# cache; refresh ~60 s before ExpiresIn; never fetch per tool call (150 RPS hard quota)
```
The gateway verifies tokens with `PyJWKClient(ISS+'/.well-known/jwks.json')` and `jwt.decode(..., algorithms=['RS256'], issuer=ISS, options={'verify_aud':False,...})`. It then checks `token_use=='access'`, `sub==client_id`, that client_id is a known agent, and that the scope is present.

## 4. Setup steps for the human

1. Join the Workshop Studio event with your **@scu.edu** email and the one-time passcode. Each teammate joins individually.
2. On the dashboard, click Get AWS CLI credentials. Copy the PowerShell `$Env:` lines.
3. If `set_aws_creds.ps1` was ever run, undo it:
   - Run `[Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID',$null,'User')` and the same for `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`.
   - Delete `$HOME\.aws_workshop_env.ps1` and remove its line from `$PROFILE`.
   - Check that `%USERPROFILE%\.aws\credentials` and `config` contain no `[default]` profile.
4. Open the admin PowerShell window and paste the `$Env:` lines. Set `$Env:AWS_REGION='us-east-1'`. Run `aws sts get-caller-identity` and note the role name.
5. Run the probe script (§6) before provisioning.
6. Model access: none should be needed for Amazon models in commercial Regions (verified). The organizers' guide still says to check, so open Bedrock in the console (us-east-1) and confirm that Nova 2 Lite is listed and invocable.
7. Run `provision.py` (§3). Write `ws_source.ini` with `python tools\set_source.py`.
8. Gateway shell:
   - Start it with `powershell -NoProfile`.
   - Run `Remove-Item Env:AWS_ACCESS_KEY_ID,Env:AWS_SECRET_ACCESS_KEY,Env:AWS_SESSION_TOKEN -EA SilentlyContinue`.
   - Set `$Env:AWS_CONFIG_FILE='C:\Users\bobvu\.mytopia\config'`, `$Env:AWS_SHARED_CREDENTIALS_FILE='C:\Users\bobvu\.mytopia\empty'`, `$Env:AWS_PROFILE='mytopia-gateway'` and `$Env:AWS_REGION='us-east-1'`.
   - Run `aws sts get-caller-identity`, which should show `assumed-role/mytopia-gateway-role`. Run `aws dynamodb list-tables`, which should give AccessDenied. Then start the gateway.
9. Agent shell:
   - Start it with `powershell -NoProfile`.
   - Remove all `AWS_*` credential variables and `AWS_PROFILE`, plus `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN` and `AWS_CONTAINER_CREDENTIALS_*`.
   - Point `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` at empty files.
   - Set `$Env:AWS_BEARER_TOKEN_BEDROCK` from the clipboard (never use `setx`) and `AWS_REGION=us-east-1`.
   - Run `aws configure list` (should show no credentials). `aws lambda invoke` should fail with "Unable to locate credentials". Then start the agent.
10. **When credentials expire** (ExpiredToken, or at 8:45 on 11-08):
    - Dashboard → new credentials → run `set_source.py`, which writes the ini and copies a new Bedrock key.
    - Re-check step 8's get-caller-identity. Restart the gateway only if its credentials have already expired.
    - Restart the agent with the new key.
    - Read the new Expiration and set a reminder 10 min before it.
11. Ask the organizers when the event and its account end. Accounts are de-provisioned at event end (likely). If the event ends before 9:00 on 11-08, nothing can be refreshed.

## 5. Fallbacks

| Piece | If refused | On-screen line |
|---|---|---|
| `iam:CreateRole` / PutRolePolicy denied | Gateway runs on the participant session in its own shell. Narrowing is enforced in code: an allowlist of table and function ARNs in the boto3 wrapper | "Gateway identity: Workshop participant role (event forbids custom IAM roles); least privilege enforced in application layer." |
| Role created but AssumeRole denied (boundary or SCP) | Same as above. Keep the role and its policy as a documented artifact | "Narrow role provisioned; event boundary blocks assuming it. See policy JSON." |
| `iam:PassRole` / Lambda role denied | Run the six tools in-process behind the same interface | "Tools executed in-process (event blocks Lambda execution roles)." |
| CallWithBearerToken denied, or the key fails | Agent uses SigV4 with the session credentials (documented by the organizers). The agent shell then has AWS credentials, so drop the "lambda invoke fails" claim | "Agent uses temporary Workshop session credentials; bearer-token auth disabled in this account." |
| Nova 2 Lite denied, or us. profile judged out of region | `MODEL_ID=amazon.nova-lite-v1:0`, which runs In-Region in us-east-1 | "Model: Nova Lite (strictly in us-east-1)." |
| Unsigned `get_client_token` fails | Create a domain and POST to `/oauth2/token` with Basic auth | "Agents authenticate via OAuth2 client_credentials at the Cognito token endpoint." |
| ExpiresIn ≠ 300 | Gateway rejects tokens with `exp - iat > 300` (inferred mitigation) | "Gateway enforces a 5-minute max token age." |
| Session expires mid-demo | Gateway keeps working for the remaining life of its role credentials (≤1 h) and the agent key dies. Run the refresh procedure | "Rotating credentials: new session in 30 s." |

## 6. Open questions only the live account can answer

The probe script should test these, in order, stopping and logging the exact error code at each step:

1. `sts.get_caller_identity()`: role name and session. Then `iam.get_role(RoleName=...)`: exact ARN and path, and whether `PermissionsBoundary` is present.
2. Session expiry: `aws configure export-credentials` → Expiration. Log the minutes remaining.
3. `iam.create_role` on a throwaway `mytopia-probe` role, then `put_role_policy`, then `assume_role(DurationSeconds=3600)` with retries for up to 90 s. Also call `assume_role(DurationSeconds=3601)` once to confirm the chaining error string. Then delete the role. Use real calls; simulator results are misleading.
4. `iam:PassRole`: `lambda.create_function` with a probe execution role.
5. Region deny: one read-only call in us-west-2 (expect AccessDenied).
6. `bedrock get-inference-profile --inference-profile-identifier us.amazon.nova-2-lite-v1:0`. Then mint a key, and from a clean subprocess with only `AWS_BEARER_TOKEN_BEDROCK`, make one Converse call. If that fails, repeat with `amazon.nova-lite-v1:0`.
7. In the same clean subprocess: `aws sts get-caller-identity`, `aws lambda invoke` and `aws dynamodb get-item`. All should fail with "Unable to locate credentials".
8. Cognito: create a probe pool and client with `ALLOW_CLIENT_TOKEN_AUTH` and AccessTokenValidity of 5 minutes. Then call unsigned `get_client_token` and record `ExpiresIn` and the decoded `iss`, `sub`, `client_id`, `scope` and `token_use`. Then delete the pool.
9. After a refresh, confirm that a running gateway's `credential_process` picks up the new `ws_source.ini` without a restart.
