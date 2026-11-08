# Hosting: MYTOPIA as a website on AWS

Since Sunday 2026-11-08 at 4 AM PT, the demo runs on one Amazon EC2 server in the team's AWS account (us-east-1) instead of a laptop. Anyone on the team opens it from any laptop or phone at an HTTPS address, with the username `mytopia` and the team password. It is the same code: nothing in the gateway, the launcher or the agent changed for hosting. One thing has to travel to the server besides the code: the two seed agents' Cognito lines (see "Why it is built this way"). Run 12 in [LIVE_RUN.md](LIVE_RUN.md) is the first full check of the hosted site.

## What runs where

```
browser --HTTPS 443, user mytopia + team password--> Caddy on the server (Let's Encrypt certificate for <ip>.sslip.io)
                                         |  Host header rewritten to 127.0.0.1:8787
                                         v
                            gateway (uvicorn, 127.0.0.1:8787 only) --runner--> launcher --> agent (one per START)
                                         |                                                    |
          the server's role, assumed into mytopia-gateway-role              the Bedrock key the server minted
                                         v                                                    v
       Cognito, DynamoDB (mytopia_agents, mytopia_events), Lambda mytopia-tools        Bedrock (Nova 2 Lite)
```

- One EC2 instance (t3.medium, Amazon Linux 2023, tag `Name=mytopia-gateway`), launched by [infra/host_ec2.py](../infra/host_ec2.py). Its first boot is [infra/host_userdata.sh](../infra/host_userdata.sh): it clones the repo's pushed branch from GitHub into `/opt/mytopia`, installs Python 3.14 with uv, writes the config and starts three systemd units.
- `mytopia-gateway`: the gateway, as the user `mytopia`, on loopback only. It serves the island and starts the launchers, exactly as on a laptop.
- `caddy`: HTTPS on 443, the redirect on 80, and a password in front of every path.
- `mytopia-bedrock-key.timer`: mints a fresh Bedrock key for the agents every 4 minutes.

## Why it is built this way

- **No keys to refresh.** The server has its own role (`mytopia-host-role`, attached as an instance profile), and AWS renews its credentials automatically. The server's `gateway/.aws-config` says `credential_source = Ec2InstanceMetadata` with `role_arn` set to `mytopia-gateway-role`, so botocore assumes the gateway's narrow role from it, as the laptop's `credential_process` did from the Workshop keys. The Workshop keys are used once, by `host_ec2.py`, to create things.
- **The agents' Bedrock key.** A short-term Bedrock key lives only as long as the credentials that signed it, so the timer mints a new one from the server's role every 4 minutes and writes it into `agent/.env`. Each START reads the current one. As on the laptop, the agent process gets only that Bedrock-only key and a 5-minute Cognito access token; the launcher keeps the client secret in `agent/.env`. Unlike on the laptop, every program on the server can also reach the instance metadata service (Known limits, 1).
- **The seed agents' secrets.** Research Bot and Ops Bot were made by `infra/provision.py`, and their Cognito secrets live in the laptop's `agent\.env`. `host_ec2.py` copies those four lines, and only those, into an encrypted SSM parameter (`/mytopia/seed-agent-lines`, a SecureString), and the first boot adds them to the server's `agent/.env`. EC2 user data carries no secret. Agents built in the Factory on the website get their secrets on the server, so they need nothing.
- **HTTPS without a domain.** sslip.io and nip.io answer `100-58-243-79.sslip.io` with `100.58.243.79`, so Caddy can get a Let's Encrypt certificate for that name. Both names are on the server, and each gets its own certificate.
- **A password in front of everything.** The island reads the admin token from `/config.js`, so whoever can load the page can press KILL or RESET. Caddy's `basic_auth` guards every path, `/config.js` included, with one team password. `host_ec2.py` makes the password on the operator's machine, sends only its bcrypt hash to the server, and writes the password to a file outside the repo, from where the team shares it by private message.
- **The gateway unchanged.** Caddy sends `Host: 127.0.0.1:8787`, so the gateway's allowed-hosts list and its DNS-rebinding defence stay as they are. The admin token is made on the server at first boot and kept in its `.env` files (mode 600). It only works through the gateway on 127.0.0.1, so from outside the password guards it.
- **The same AWS resources as the laptop.** The badges, the ledger table, the Cognito pool and the tools Lambda are shared with any laptop gateway in AWS mode. So RESET on the website retires the laptop's Factory agents too, and an agent built on the laptop shows on the website but cannot START there (its secret stays in the laptop's `agent\.env`).

## Deploy

Provisioning must have run first ([infra/README.md](../infra/README.md)), with fresh Workshop keys saved by `scripts\aws_creds.py`. The server clones the branch from GitHub, not this folder, so push first (or pass `--branch` with a pushed branch).

```powershell
cd "C:\Users\bobvu\Desktop\AWS x A10 Hackathon\mytopia"
.venv\Scripts\python -m pip install bcrypt               # only host_ec2.py needs it
.venv\Scripts\python infra\host_ec2.py --dry-run         # the plan, no AWS calls
.venv\Scripts\python infra\host_ec2.py                   # prints the address when the server is running
```

The script finds or creates `mytopia-host-role` and its instance profile, adds that role to the trust of `mytopia-gateway-role` (keeping the participant role), finds or creates the security group `mytopia-web`, stores the seed agents' lines in `/mytopia/seed-agent-lines`, and launches the server, unless one is already up (`--new` launches another). It reads the non-secret settings (pool id, scope, table and function names, model id) from `gateway\.env` and `agent\.env`. It writes the address and a new password to `Desktop\MYTOPIA_SITE_ACCESS.txt` as soon as the server exists, or to `MYTOPIA_SITE_ACCESS-<instance id>.txt` when that file is already there, and it prints no secret. The first boot takes a few minutes: in run 12 the site was ready by the first check.

## Check it

- `.venv\Scripts\python infra\host_ec2.py --status` lists the server, its state and its address.
- Without the password the site answers 401. With it, `/healthz` answers `{"ok": true, "mode": "aws", "tools_mode": "lambda", "token_mode": "cognito"}`, and the island's badge reads LIVE.
- On the server: AWS console, Systems Manager, Session Manager, start a session on the instance, then `sudo journalctl -u mytopia-gateway -n 50`, `sudo tail -n 50 /var/log/mytopia-setup.log` and `systemctl status caddy`. On the first server, clean its setup log first (next section).

## Bring the first server up to date

The first server (run 12) was launched from an earlier copy of the boot script, before the review that followed it. Its address and password are in `Desktop\AWS x A10 Hackathon\MYTOPIA_SITE_ACCESS.txt` (the earlier script wrote it there). Five steps, in a Session Manager session, off the projector:

1. **The seed agents' lines**, so Research Bot and Ops Bot can START on the website. First run `infra\host_ec2.py` once more on the laptop: it finds the role, the trust line, the firewall and the running server, stores `/mytopia/seed-agent-lines`, and launches nothing. Then on the server:
   ```bash
   sudo systemctl stop mytopia-bedrock-key.timer
   aws ssm get-parameter --region us-east-1 --name /mytopia/seed-agent-lines --with-decryption --query Parameter.Value --output text | sudo -u mytopia tee -a /opt/mytopia/agent/.env >/dev/null
   sudo systemctl start mytopia-bedrock-key.timer
   sudo grep -cE '^(RESEARCH|OPS)_BOT_CLIENT_(ID|SECRET)=.' /opt/mytopia/agent/.env      # must print 4
   ```
   The timer is stopped because it replaces `agent/.env` every 4 minutes, which could drop lines appended at the same moment. No restart is needed: START reads the file every time.
2. **The setup log.** The earlier boot script traced its commands, so the admin token it made is written in `/var/log/mytopia-setup.log`, in `/var/log/cloud-init-output.log`, in the journal and in the EC2 system log. On its own the token opens nothing without the team password, but do not show those logs on screen. Remove it from the two files:
   ```bash
   sudo sed -i '/^+ ADMIN=/d' /var/log/mytopia-setup.log /var/log/cloud-init-output.log && sudo chmod 600 /var/log/mytopia-setup.log
   ```
3. **The latest code** (the island's architecture sheet and these docs; no gateway change, so no restart):
   ```bash
   sudo -u mytopia git -C /opt/mytopia fetch --depth 1 origin main
   sudo -u mytopia git -C /opt/mytopia reset --hard FETCH_HEAD
   ```
4. **Tighter files** (optional): `sudo chmod 700 /opt/mytopia`. New servers also run the gateway with `UMask=0077`.
5. **Caddy's local admin API** (optional): the first server still listens on 127.0.0.1:2019, where any local program could replace Caddy's config. Turn it off: `sudo vi /etc/caddy/Caddyfile` and add these three lines at the very top: `{`, then a tab and `admin off`, then `}`. Delete the `ExecReload=` line from `/etc/systemd/system/caddy.service`. Check, then restart (the site is down for about a second):
   ```bash
   sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl daemon-reload && sudo systemctl restart caddy
   ```
   If `validate` complains, fix the file before restarting: the running Caddy keeps serving until then.

## Update it after a push

A server launched from this repo has `mytopia-update`. In a Session Manager session, `sudo /usr/local/bin/mytopia-update` fetches the latest pushed commit of the branch the server runs, resets to it (this works after a force push too, and keeps the git-ignored config), reinstalls the requirements and restarts the gateway. Agents running at that moment stop. Commits that are not pushed, or are on another branch, do not reach the server. On the first server, use step 3 above, then `sudo systemctl restart mytopia-gateway` if the gateway's code changed.

## Change the password

`host_ec2.py` does not change the password of a running server. In a Session Manager session: run `caddy hash-password` and type the new password twice; then `sudo vi /etc/caddy/Caddyfile` and replace the hash after `mytopia` on the basic_auth line; then `sudo systemctl restart caddy` (its certificates stay on disk, so this takes about a second). The username stays `mytopia`. Update the access file by hand.

## After a stop and start

The first boot writes `<ip>.sslip.io` and `<ip>.nip.io` into `/etc/caddy/Caddyfile` once, and there is no Elastic IP. A reboot keeps the IP. A stop and start gives the server a new public IP, and the site does not come back on its own: the old names point elsewhere, and Caddy has no site for the new name that `--status` prints. To fix it, in a Session Manager session:

```bash
OLD=$(grep -m1 -oE '^[0-9]+(-[0-9]+){3}\.sslip\.io' /etc/caddy/Caddyfile | cut -d. -f1)
T=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
NEW=$(curl -fsS -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/public-ipv4 | tr . -)
sudo sed -i "s/$OLD/$NEW/g" /etc/caddy/Caddyfile && sudo systemctl restart caddy
```

Caddy then gets certificates for the new names. Put the new address in the access file by hand. Or run `host_ec2.py --teardown --yes` and launch again, which also makes a new password.

## Measured (run 12)

| What | On the server | On the laptop (run 11) |
|---|---|---|
| Decision, p50 / p95 | 5 ms / 13 ms (16 decisions) | 78 ms / 85 ms |
| The egress refusal in the AI drill | 13 ms | 81 ms |
| Mint (a real Cognito client) | 320 to 340 ms | |
| START to 202 | 1.2 s | 1.05 to 1.1 s |
| KILL to `run_stopped` | 0.26 s | |
| The island page through HTTPS | 907 ms | |

The badge read now stays inside us-east-1 instead of crossing the country, which is where the 73 ms went.

## Cost

A t3.medium in us-east-1 costs about 4 cents an hour on demand, plus 20 GB of gp3 storage (about 1.60 dollars a month). Taking it down stops both.

## Take it down

```powershell
.venv\Scripts\python infra\host_ec2.py --teardown --yes
```

This terminates the server, deletes the security group and the seed parameter, takes `mytopia-host-role` out of the gateway role's trust, and deletes the role and its instance profile. Run it before `infra\teardown.py`, which deletes the gateway role itself. Then delete the access file (`Desktop\MYTOPIA_SITE_ACCESS.txt`, or for the first server `Desktop\AWS x A10 Hackathon\MYTOPIA_SITE_ACCESS.txt`), so the next launch writes its address and password to the default place.

## Known limits

1. **The agents share the server with the gateway**, as they shared the laptop. Any program on the server can ask the instance metadata service for the server role's credentials. With them it can assume the gateway role, call Bedrock on any model, read SSM parameters (the managed policy allows `ssm:GetParameter` on any parameter, the seed lines included) and use Session Manager's channels. Our agents have no tool that makes web requests, and the launcher gives them no AWS settings, but nothing at the operating-system level stops a hostile program. The fix is the one already on the README's "what's next" list: each agent in its own sandbox (Amazon Bedrock AgentCore Runtime), or at least its own Unix user with the metadata address blocked.
2. **One shared password**, and whoever has it gets the admin token. Basic auth has no lockout, but guessing a password of about 60 bits over the network is not practical.
3. **The site is pinned to the first boot's IP** (see "After a stop and start"). Do not stop the server before judging.
4. **sslip.io and nip.io are third-party DNS services.** If one is down, the other name still works. Their operators control what the names resolve to, so they could get a certificate for them and catch the password. A name in a domain the team controls (Route 53), with an Elastic IP, would remove that dependency.
5. **The key timer rewrites `agent/.env` every 4 minutes.** A Factory mint that appends its lines in the same instant could lose them. That agent's START would then report missing lines: RETIRE it and mint it again (or mint it under a new id).
6. **The first boot runs downloads as root without pinned versions or checksums**: the uv installer and the latest Caddy build (a pinned Caddy release is only the fallback). Pinning both and checking their checksums is the next step.
7. **Port 80 is open** for Let's Encrypt's check and the redirect to HTTPS. It serves nothing else.
