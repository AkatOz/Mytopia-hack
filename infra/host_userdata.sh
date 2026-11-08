#!/bin/bash
# First boot of the MYTOPIA server (Amazon Linux 2023), filled in and sent as EC2 user data by infra/host_ec2.py.
# It clones the repo, installs Python 3.14 through uv, writes the gateway's config (its AWS access comes from this
# server's role, assumed into the gateway's narrow role, so there are no keys to refresh), adds the seed agents'
# Cognito lines from an encrypted SSM parameter, mints the agents' Bedrock key from the server's role every 4 minutes,
# and puts Caddy in front (HTTPS from Let's Encrypt for <ip>.sslip.io and a team password). The gateway itself listens
# on 127.0.0.1:8787 only. No secret is in this script: the admin token is made here, and xtrace stays off so it never reaches a log.
# host_ec2.py fills every double-underscore placeholder except DASH, which is this server's public IP (filled below).
set -euo pipefail
install -m 600 /dev/null /var/log/mytopia-setup.log
exec > >(tee -a /var/log/mytopia-setup.log) 2>&1
trap 'echo "mytopia setup failed at line $LINENO" >&2' ERR
APP=/opt/mytopia
export HOME=/root
echo "== packages, users and the code"
dnf install -y git
id mytopia >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/mytopia --shell /sbin/nologin mytopia
id caddy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/caddy --shell /sbin/nologin caddy
rm -rf "$APP"
git clone --depth 1 --branch __BRANCH__ __REPO_URL__ "$APP"
chmod 700 "$APP"   # the .env files written below hold secrets; chown -R at the end keeps this mode

echo "== Python 3.14 and the requirements"
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
export UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_CACHE_DIR=/var/cache/uv
/usr/local/bin/uv venv --python 3.14 "$APP/.venv"
/usr/local/bin/uv pip install --python "$APP/.venv/bin/python" -r "$APP/requirements.txt"

echo "== config"
IMDS=http://169.254.169.254/latest
T=$(curl -fsS -X PUT "$IMDS/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $T" "$IMDS/meta-data/public-ipv4")
DASH=${IP//./-}
rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ADMIN=$(rand)

cat > "$APP/gateway/.aws-config" <<'EOF'
[profile gateway]
role_arn = __GATEWAY_ROLE_ARN__
credential_source = Ec2InstanceMetadata
region = us-east-1
EOF
: > "$APP/gateway/.aws-credentials"

cat > "$APP/gateway/.env" <<EOF
MODE=aws
TOOLS_MODE=lambda
TOKEN_MODE=cognito
PORT=8787
ADMIN_TOKEN=$ADMIN
DEMO_PACE=__DEMO_PACE__
LOCAL_ISSUER_SECRET=$(rand)
COGNITO_POOL_ID=__COGNITO_POOL_ID__
COGNITO_SCOPE=__COGNITO_SCOPE__
AWS_REGION=us-east-1
AWS_PROFILE=gateway
AWS_CONFIG_FILE=$APP/gateway/.aws-config
AWS_SHARED_CREDENTIALS_FILE=$APP/gateway/.aws-credentials
TABLE_AGENTS=__TABLE_AGENTS__
TABLE_EVENTS=__TABLE_EVENTS__
TOOLS_FUNCTION=__TOOLS_FUNCTION__
EVENTS_JSONL=gateway/events.aws.jsonl
GATEWAY_ROLE_ARN=__GATEWAY_ROLE_ARN__
EOF

cat > "$APP/agent/.env" <<EOF
GATEWAY_URL=http://127.0.0.1:8787
TOKEN_MODE=cognito
COGNITO_SCOPE=__COGNITO_SCOPE__
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=__BEDROCK_MODEL_ID__
HARNESS_POLL_MS=__HARNESS_POLL_MS__
ADMIN_TOKEN=$ADMIN
AWS_BEARER_TOKEN_BEDROCK=
EOF

echo "== the seed agents' Cognito lines (SSM SecureString __SEED_PARAM__)"
if SEED=$(aws ssm get-parameter --region us-east-1 --name __SEED_PARAM__ --with-decryption \
            --query Parameter.Value --output text) && [ -n "$SEED" ]; then
  printf '%s\n' "$SEED" >> "$APP/agent/.env"
  echo "added $(printf '%s\n' "$SEED" | grep -c =) seed lines"
else
  echo "could not read __SEED_PARAM__ (the error above, if any): Research Bot and Ops Bot cannot START until its lines are in agent/.env (docs/HOSTING.md)"
fi

cat > /usr/local/bin/mytopia-bedrock-key.py <<'EOF'
"""Mint a short-term Bedrock key from this server's role and write it into agent/.env atomically. The timer runs it
every 4 minutes: a key lives only as long as the role credentials it was signed with."""
import os
import re
import tempfile

from aws_bedrock_token_generator import provide_token

ENV = "/opt/mytopia/agent/.env"
line = "AWS_BEARER_TOKEN_BEDROCK=" + provide_token(region="us-east-1")
with open(ENV, encoding="utf-8") as f:
    text = f.read()
if re.search(r"(?m)^AWS_BEARER_TOKEN_BEDROCK=", text):
    text = re.sub(r"(?m)^AWS_BEARER_TOKEN_BEDROCK=.*$", lambda m: line, text)
else:
    text = text.rstrip("\n") + "\n" + line + "\n"
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(ENV), prefix=".env.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(text)
os.chmod(tmp, 0o600)
os.replace(tmp, ENV)
print("bedrock key refreshed")
EOF

cat > /usr/local/bin/mytopia-update <<'EOF'
#!/bin/bash
# Deploy the latest pushed commit of the branch this server runs (works after a force push too), then restart the
# gateway. Run as root: sudo /usr/local/bin/mytopia-update (or from SSM Run Command). The git-ignored config is kept.
set -euo pipefail
B=$(runuser -u mytopia -- git -C /opt/mytopia rev-parse --abbrev-ref HEAD)
runuser -u mytopia -- git -C /opt/mytopia fetch --depth 1 origin "$B"
runuser -u mytopia -- git -C /opt/mytopia reset --hard FETCH_HEAD
runuser -u mytopia -- /usr/local/bin/uv pip install --python /opt/mytopia/.venv/bin/python -r /opt/mytopia/requirements.txt
systemctl restart mytopia-gateway
runuser -u mytopia -- git -C /opt/mytopia log -1 --format='deployed %h %s'
EOF
chmod 755 /usr/local/bin/mytopia-update

echo "== Caddy"
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
  || curl -fsSL https://github.com/caddyserver/caddy/releases/download/v2.10.2/caddy_2.10.2_linux_amd64.tar.gz | tar -xz -C /usr/local/bin caddy
chmod 755 /usr/local/bin/caddy
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'EOF'
{
	admin off
}

__DASH__.sslip.io, __DASH__.nip.io {
	basic_auth {
		mytopia __BCRYPT__
	}
	reverse_proxy 127.0.0.1:8787 {
		header_up Host 127.0.0.1:8787
	}
}
EOF
sed -i "s/__DASH__/$DASH/g" /etc/caddy/Caddyfile

echo "== services"
cat > /etc/systemd/system/mytopia-gateway.service <<'EOF'
[Unit]
Description=MYTOPIA gateway (127.0.0.1:8787; Caddy serves it on 443)
After=network-online.target
Wants=network-online.target

[Service]
User=mytopia
Group=mytopia
UMask=0077
WorkingDirectory=/opt/mytopia
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/mytopia/.venv/bin/python -m uvicorn gateway.app:app --host 127.0.0.1 --port 8787
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/mytopia-bedrock-key.service <<'EOF'
[Unit]
Description=Mint a fresh Bedrock key for MYTOPIA's agents from the server's role

[Service]
Type=oneshot
User=mytopia
Group=mytopia
UMask=0077
ExecStart=/opt/mytopia/.venv/bin/python /usr/local/bin/mytopia-bedrock-key.py
EOF
cat > /etc/systemd/system/mytopia-bedrock-key.timer <<'EOF'
[Unit]
Description=Refresh MYTOPIA's Bedrock key every 4 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=4min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS and the team password in front of MYTOPIA)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

chown -R mytopia:mytopia "$APP"
chmod 600 "$APP/gateway/.env" "$APP/agent/.env" "$APP/gateway/.aws-config"
systemctl daemon-reload
runuser -u mytopia -- "$APP/.venv/bin/python" /usr/local/bin/mytopia-bedrock-key.py || echo "first Bedrock key failed; the timer retries"
systemctl enable --now mytopia-gateway.service mytopia-bedrock-key.timer
systemctl enable --now caddy.service
echo "MYTOPIA_READY https://$DASH.sslip.io"
