#!/usr/bin/env bash
# The bypass proof: a revoked badge refuses the SAME still-valid Cognito token, a tampered token gets 401,
# and a shell without the gateway's credentials cannot reach the tools Lambda directly. Then the badge is restored.
# One line per step; exits non-zero at the first unexpected answer (and restores the badge if it revoked it).
# Same steps as scripts/replay.ps1. Usage: scripts/replay.sh [GATEWAY_URL]   (Git Bash)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$ROOT/.venv/bin/python"
AWS_CLI="${AWS_CLI:-C:/Users/bobvu/AppData/Local/awscli-venv/Scripts/aws.cmd}"
URL="${1:-${GATEWAY_URL:-http://127.0.0.1:8787}}"
AGENT="research-bot"
SCRUB_DIR="$ROOT/scripts/scrubbed"
OUT="$(mktemp)"
HDR="$(mktemp)"
MINT="$(mktemp)"
REVOKED_BY_US=0

cd "$ROOT"
json() { "$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print($1)" "$OUT"; }
admin() {  # admin <path> ; POST with the admin token, leaves the body in $OUT, prints the HTTP status
  curl -s -o "$OUT" -w "%{http_code}" -X POST "$URL$1" -H "X-Admin-Token: $ADMIN_TOKEN"
}
status() {  # the badge status as the gateway reads it from the registry
  curl -s -o "$OUT" "$URL/agents/$AGENT/status" -H "X-Admin-Token: $ADMIN_TOKEN"
  json 'd.get("status")'
}
mcp() {  # mcp <token> <id> <method> <params-json> ; body in $OUT, headers in $HDR, prints the HTTP status
  curl -s -D "$HDR" -o "$OUT" -w "%{http_code}" -X POST "$URL/mcp" \
    -H "Authorization: Bearer $1" -H "X-Run-Id: run-replay" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$2,\"method\":\"$3\",\"params\":$4}"
}
cleanup() {
  if [ "$REVOKED_BY_US" = 1 ]; then
    admin "/agents/$AGENT/restore" >/dev/null || true
    echo "   (cleanup: badge restored after the failure)"
  fi
  rm -f "$OUT" "$HDR" "$MINT"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

ADMIN_TOKEN="$("$PY" -c "from dotenv import dotenv_values; print(dotenv_values('gateway/.env').get('ADMIN_TOKEN') or '')")"
[ -n "$ADMIN_TOKEN" ] || fail "ADMIN_TOKEN is empty in gateway/.env"
MODE="$(curl -s "$URL/healthz" | "$PY" -c "import json,sys; d=json.load(sys.stdin); print(d['mode'] + '/' + d['token_mode'])")" \
  || fail "no gateway at $URL"
[ "$MODE" = "aws/cognito" ] || fail "gateway is in $MODE mode; this proof needs mode aws with Cognito tokens"

# 0. precondition: the badge must start ACTIVE (a previous run may have left it REVOKED or KILLED)
S="$(status)"
if [ "$S" != "ACTIVE" ]; then
  [ "$(admin "/agents/$AGENT/restore")" = 200 ] || fail "restore before the proof: $(cat "$OUT")"
  echo "0 precondition -> $AGENT was $S; restored to ACTIVE at seq $(json 'd["seq"]')"
else
  echo "0 precondition -> $AGENT is ACTIVE"
fi

# 1. mint a research-bot token (unsigned GetClientToken, no AWS credentials) and call read_file: allow
cat > "$MINT" <<'PYEOF'
import sys
import boto3
from botocore import UNSIGNED
from botocore.config import Config
from dotenv import dotenv_values
env = dotenv_values("agent/.env")
prefix = sys.argv[1].upper().replace("-", "_")
cognito = boto3.client("cognito-idp", region_name=env.get("AWS_REGION") or "us-east-1",
                       config=Config(signature_version=UNSIGNED))
result = cognito.get_client_token(ClientId=env[prefix + "_CLIENT_ID"], Secret=env[prefix + "_CLIENT_SECRET"],
                                  Scopes=[env.get("COGNITO_SCOPE") or "mytopia/tools"])
sys.stdout.write(result["ClientAuthenticationResult"]["AccessToken"])
PYEOF
TOKEN="$("$PY" "$MINT" "$AGENT")" || fail "could not mint a Cognito token"
CODE="$(mcp "$TOKEN" 1 tools/call '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}')"
[ "$CODE" = 200 ] || fail "read_file HTTP $CODE: $(cat "$OUT")"
[ "$(json 'd["result"]["isError"]')" = False ] || fail "read_file was not allowed: $(json 'd["result"]["content"][0]["text"]')"
echo "1 read_file    -> ALLOW with a fresh Cognito token ${TOKEN:0:8}...: $(json 'd["result"]["content"][0]["text"].splitlines()[0][:50]')"

# 2. revoke the badge
[ "$(admin "/agents/$AGENT/revoke")" = 200 ] || fail "revoke: $(cat "$OUT")"
REVOKED_BY_US=1
echo "2 revoke       -> status $(json 'd["status"]') at seq $(json 'd["seq"]')"

# 3. replay the SAME token: tools/call refused with the badge reason, tools/list empty
CODE="$(mcp "$TOKEN" 3 tools/call '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}')"
[ "$CODE" = 200 ] || fail "replayed read_file HTTP $CODE: $(cat "$OUT")"
TEXT="$(json 'd["result"]["content"][0]["text"]')"
[ "$(json 'd["result"]["isError"]')" = True ] || fail "replayed read_file was not refused: $TEXT"
case "$TEXT" in *"badge REVOKED"*) ;; *) fail "replayed read_file refused for another reason: $TEXT" ;; esac
echo "3 same token   -> tools/call read_file: isError, $TEXT"
CODE="$(mcp "$TOKEN" 4 tools/list '{}')"
[ "$CODE" = 200 ] || fail "replayed tools/list HTTP $CODE: $(cat "$OUT")"
N="$(json 'len(d["result"]["tools"])')"
[ "$N" = 0 ] || fail "replayed tools/list shows $N tools"
echo "3 same token   -> tools/list: 0 tools"

# 4. tampered token: one character flipped in the middle of the signature part -> HTTP 401 + WWW-Authenticate
#    (the middle, not the last character: the last base64url character carries padding bits and may decode the same)
BAD="$("$PY" -c "import sys; h,p,s=sys.argv[1].split('.'); i=len(s)//2; print(h+'.'+p+'.'+s[:i]+('A' if s[i]!='A' else 'B')+s[i+1:])" "$TOKEN")"
[ "$BAD" != "$TOKEN" ] || fail "the tampered token equals the original"
CODE="$(mcp "$BAD" 5 tools/call '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}')"
WWW="$(grep -i '^www-authenticate:' "$HDR" | tr -d '\r' | cut -d' ' -f2- || true)"
[ "$CODE" = 401 ] || fail "tampered token got HTTP $CODE: $(cat "$OUT")"
[ -n "$WWW" ] || fail "tampered token: 401 without WWW-Authenticate"
echo "4 tampered     -> HTTP 401, WWW-Authenticate: $WWW; $(json 'd["error"]["message"]')"

# 5. an expired token: not run; step 3 already shows that a token still inside its lifetime is refused
echo "5 expired      -> skipped (not needed: step 3 refused a token that had not expired)"

# 6. a scrubbed shell (no AWS_* variables, no profile, empty config and credentials files) calls the tools Lambda directly
mkdir -p "$SCRUB_DIR"
: > "$SCRUB_DIR/aws_config.ini"
: > "$SCRUB_DIR/aws_credentials.ini"
rm -f "$SCRUB_DIR/out.json"
CFG_W="$(cygpath -w "$SCRUB_DIR/aws_config.ini" 2>/dev/null || echo "$SCRUB_DIR/aws_config.ini")"
CRED_W="$(cygpath -w "$SCRUB_DIR/aws_credentials.ini" 2>/dev/null || echo "$SCRUB_DIR/aws_credentials.ini")"
OUT_W="$(cygpath -w "$SCRUB_DIR/out.json" 2>/dev/null || echo "$SCRUB_DIR/out.json")"
scrubbed() {  # env -i drops every inherited variable; only the OS basics the CLI needs to start come back
  env -i PATH="$PATH" SYSTEMROOT="${SYSTEMROOT:-C:\\Windows}" SYSTEMDRIVE="${SYSTEMDRIVE:-C:}" \
    TEMP="${TEMP:-}" TMP="${TMP:-}" USERPROFILE="${USERPROFILE:-}" \
    AWS_CONFIG_FILE="$CFG_W" AWS_SHARED_CREDENTIALS_FILE="$CRED_W" "$@"
}
ENVS="$(scrubbed env | grep '^AWS_' | cut -d= -f1 | tr '\n' ' ')"
[ "$ENVS" = "AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE " ] || fail "the scrubbed environment carries: $ENVS"
set +e
ERR="$(scrubbed "$AWS_CLI" lambda invoke --function-name mytopia-tools --region us-east-1 "$OUT_W" 2>&1)"
RC=$?
set -e
[ "$RC" != 0 ] || fail "the scrubbed shell invoked the Lambda (exit 0)"
case "$ERR" in *"Unable to locate credentials"*) ;; *) fail "scrubbed lambda invoke: unexpected answer: $ERR" ;; esac
[ ! -s "$SCRUB_DIR/out.json" ] || fail "out.json was written"
echo "6 no creds     -> aws lambda invoke mytopia-tools: exit $RC, $(echo "$ERR" | tr -d '\r' | grep -m1 'Unable to locate credentials' | sed 's/^ *//')"
set +e
ERR="$(scrubbed "$AWS_CLI" lambda invoke --function-name mytopia-tools --region us-east-1 --profile gateway "$OUT_W" 2>&1)"
RC=$?
set -e
[ "$RC" != 0 ] || fail "the scrubbed shell invoked the Lambda with --profile gateway (exit 0)"
case "$ERR" in *"could not be found"*) ;; *) fail "scrubbed lambda invoke --profile gateway: unexpected answer: $ERR" ;; esac
[ ! -s "$SCRUB_DIR/out.json" ] || fail "out.json was written"
echo "6 no profile   -> aws lambda invoke --profile gateway: exit $RC, $(echo "$ERR" | tr -d '\r' | grep -m1 'could not be found' | sed 's/^ *//')"

# 7. restore the badge and read it back
[ "$(admin "/agents/$AGENT/restore")" = 200 ] || fail "restore: $(cat "$OUT")"
SEQ="$(json 'd["seq"]')"
REVOKED_BY_US=0
S="$(status)"
[ "$S" = ACTIVE ] || fail "badge reads $S after restore"
echo "7 restore      -> status ACTIVE at seq $SEQ (read back from the registry: $S)"
echo "replay proof OK"
