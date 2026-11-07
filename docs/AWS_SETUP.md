# AWS setup for MYTOPIA (the event's Workshop Studio account)

Source of truth for the joining procedure: the organizers' repo https://github.com/SCUACM/aws-access-26 (read 2026-11-07). This page adapts it to our laptop and our architecture.

## What the event gives us

- One temporary AWS account per team, run by AWS Workshop Studio, for the 72-hour event window, region **us-east-1 only**. No credit card; the organizers pay.
- **Every teammate joins individually** with their own `@scu.edu` email (a one-time passcode by email). One person joining does not cover the team. A personal Gmail puts you in a different, empty environment with no error message.
- From the event dashboard: **Open AWS console** (a browser session) and **Get AWS CLI credentials** (three environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`). The CLI credentials **expire after a few hours**; you fetch a fresh set from the same button.
- Each participant also gets a personal Kiro code worth 1,000 credits (judging.scuacm.com, "Your team"). Stretch only for us.

## The three rules the organizers set

1. **No long-lived IAM access keys.** Do not create IAM users with access keys. The temporary session credentials are the only keys allowed.
2. **Never call AWS from the frontend.** The island is a static page that talks only to our gateway, so we comply.
3. **us-east-1 for everything.**

Rule 1 changes last night's plan, which created two IAM users with keys. The replacement (details in `docs/AWS_CREDENTIAL_DESIGN.md` once the research finishes, and tested by `scripts/probe.py`):

- The **gateway** runs under a narrow **IAM role** it assumes from the session credentials (temporary, auto-refreshed, only the three permissions it needs).
- The **agent** holds a **short-term Bedrock API key** (a bearer token minted from the session credentials, Bedrock-only, 12 hours at most). It cannot call DynamoDB or Lambda, which is the demo's bypass proof.
- The **provisioning script** runs once with the session credentials.

## Do not run the organizers' `set_aws_creds.ps1` on the demo laptop

Their script writes the keys into your **user-level environment variables** (the registry) and your PowerShell profile, so every process you start afterwards inherits AWS credentials, including the agent whose whole point is to hold none. Use `scripts\aws_creds.py` instead: it saves the keys to `gateway\.aws-credentials` (git-ignored) and nothing else. Teammates can use the organizers' script on their own laptops if they like.

(This laptop's PowerShell execution policy blocks `.ps1` script files, which is why the credential script is Python. `scripts\aws_creds.ps1` does the same thing and still works with `powershell -ExecutionPolicy Bypass -File .\scripts\aws_creds.ps1`, which changes no setting.)

If you already ran their script here, undo it: open Settings, Environment Variables, delete the four `AWS_*` user variables, and remove the `.aws_workshop_env` line from `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`.

## Steps on the demo laptop (Bob)

1. Go to https://judging.scuacm.com and sign in with the link the organizers emailed you. Open **Your team**: it shows the **AWS workshop join link** and the **access code**.
2. Click the join link (or go to https://catalog.us-east-1.prod.workshops.aws/join and enter the access code). Choose **Email one-time password (OTP)**, enter your `@scu.edu` address, enter the 6-digit code from your inbox, accept the terms, click **Join event**.
3. On the event dashboard, under **AWS account access**, click **Open AWS console (us-east-1)**. Keep that tab open all weekend: it is the DynamoDB tab for the demo.
4. Click **Get AWS CLI credentials**, choose any tab, select the lines (or click the copy icon), paste them into Notepad and save the file on your Desktop as **`creds.txt`**.
5. In PowerShell, in the repo folder:

   ```powershell
   cd "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia"
   .venv\Scripts\python scripts\aws_creds.py
   ```

   It finds `Desktop\creds.txt` by itself, saves the keys, **deletes `creds.txt`**, and prints `OK [ws]: account <12 digits>, arn:aws:sts::...:assumed-role/...`. If it prints FAILED, save the whole block again (the three `AWS_` lines) and re-run. Without a Desktop file it falls back to the clipboard. Never paste a screenshot of the credentials dialog anywhere.
6. Run the probe and send Claude its summary:

   ```powershell
   .venv\Scripts\python scripts\probe.py
   ```

   It takes two to four minutes. It creates and deletes a table, a role, a Lambda function and a user pool named `mytopia-probe-*`, and prints a PASS/FAIL table. Nothing it creates survives.
7. In the AWS console tab: **Amazon Bedrock**, **Model catalog**, search **Nova 2 Lite**. If the page offers to request or enable access, do it. The probe's `bedrock converse us.amazon.nova-2-lite-v1:0` line tells you whether it already works.
8. **When the keys expire** (any command fails with `ExpiredToken`): repeat steps 4 and 5. Thirty seconds. Do it at **8:45 AM Sunday**, right before judging; the gateway picks the new keys up by itself (its role credentials are re-minted from the file), the agent is restarted by the launcher anyway.

## Checking where you stand

```powershell
.venv\Scripts\python scripts\whoami.py            # the session identity and the age of the saved keys
.venv\Scripts\python scripts\whoami.py gateway    # the narrow gateway role, once infra\provision.py has run
aws sts get-caller-identity                       # should FAIL in a plain shell: no default profile anywhere
```

The AWS CLI on this laptop is version 1 in its own environment (`%LOCALAPPDATA%\awscli-venv`, added to your user PATH; open a new terminal to pick it up). The official v2 installer needs an administrator account, which this Windows account is not. Either CLI is fine for our use.
