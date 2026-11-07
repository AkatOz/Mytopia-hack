#!/usr/bin/env bash
# The MYTOPIA demo steps with plain curl against a running gateway: list, allow, deny, revoke, deny again, empty list, events, restore.
# Each step prints one line and the script exits non-zero on the first unexpected answer. Usage: scripts/curl_demo.sh [GATEWAY_URL]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$ROOT/.venv/bin/python"
URL="${1:-${GATEWAY_URL:-http://127.0.0.1:8787}}"
AGENT="research-bot"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

cd "$ROOT"
setting() { "$PY" -c "from gateway.config import Settings; print(Settings.from_env().$1)"; }
json() { "$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print($1)" "$OUT"; }
fail() { echo "FAIL: $*"; exit 1; }

ADMIN_TOKEN="$(setting admin_token)"
TOKEN_MODE="${TOKEN_MODE:-$(setting token_mode)}"

# 0. mint a token (never printed in full)
if [ "$TOKEN_MODE" = "cognito" ]; then
  TOKEN="$("$PY" - "$AGENT" <<'PYEOF'
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
                                  Scopes=["mytopia/tools"])
sys.stdout.write(result["ClientAuthenticationResult"]["AccessToken"])
PYEOF
)"
else
  TOKEN="$("$PY" -m gateway.issuer_local "$AGENT")"
fi
echo "0 token        -> ${TOKEN_MODE} token ${TOKEN:0:12}... for $AGENT"

mcp() {  # mcp <id> <method> <params-json> ; leaves the body in $OUT, prints the HTTP status
  curl -s -o "$OUT" -w "%{http_code}" -X POST "$URL/mcp" \
    -H "Authorization: Bearer $TOKEN" -H "X-Run-Id: run-curl" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$1,\"method\":\"$2\",\"params\":$3}"
}
admin() {  # admin <path> ; POST with the admin token
  curl -s -o "$OUT" -w "%{http_code}" -X POST "$URL$1" -H "X-Admin-Token: $ADMIN_TOKEN"
}

# 1. tools/list: expect the 4 tools on research-bot's badge
[ "$(mcp 1 tools/list '{}')" = 200 ] || fail "tools/list HTTP error: $(cat "$OUT")"
N="$(json 'len(d["result"]["tools"])')"
[ "$N" = 4 ] || fail "expected 4 tools, got $N"
echo "1 tools/list   -> $N tools: $(json '" ".join(t["name"] for t in d["result"]["tools"])')"

# 2. read_file: allowed
mcp 2 tools/call '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}' >/dev/null
[ "$(json 'd["result"]["isError"]')" = False ] || fail "read_file was not allowed: $(cat "$OUT")"
echo "2 read_file    -> ALLOW: $(json 'd["result"]["content"][0]["text"].splitlines()[0][:60]')"

# 3. send_email: denied with a reason
mcp 3 tools/call '{"name":"send_email","arguments":{"to":"ceo@example.corp","subject":"Q3 summary","body":"hi"}}' >/dev/null
TEXT="$(json 'd["result"]["content"][0]["text"]')"
[ "$TEXT" = "DENIED: send_email is not on badge research-bot [rule: allow-list]" ] || fail "send_email: $TEXT"
echo "3 send_email   -> $TEXT"

# 4. revoke the badge
[ "$(admin "/agents/$AGENT/revoke")" = 200 ] || fail "revoke: $(cat "$OUT")"
REVOKE_SEQ="$(json 'd["seq"]')"
echo "4 revoke       -> status $(json 'd["status"]') at seq $REVOKE_SEQ"

# 5. read_file again: denied, and the event carries ms_since_revoke
mcp 5 tools/call '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}' >/dev/null
TEXT="$(json 'd["result"]["content"][0]["text"]')"
case "$TEXT" in "DENIED: badge REVOKED at"*"[rule: status-revoked]") ;; *) fail "read_file after revoke: $TEXT" ;; esac
curl -s -o "$OUT" "$URL/events?since_seq=$REVOKE_SEQ"
MS="$(json '([e["ms_since_revoke"] for e in d["events"] if e["decision"] == "deny"] + [None])[0]')"
[ "$MS" != None ] || fail "the deny after revoke carries no ms_since_revoke"
echo "5 read_file    -> $TEXT (ms_since_revoke=$MS)"

# 6. tools/list again: empty
mcp 6 tools/list '{}' >/dev/null
[ "$(json 'len(d["result"]["tools"])')" = 0 ] || fail "tools/list after revoke is not empty"
echo "6 tools/list   -> 0 tools (badge REVOKED)"

# 7. the event chain
curl -s -o "$OUT" "$URL/events?since_seq=0"
OK="$("$PY" -c "import json,sys; from gateway.events import verify_chain; print(verify_chain(json.load(open(sys.argv[1]))['events']))" "$OUT")"
[ "$OK" = True ] || fail "hash chain does not verify"
echo "7 GET /events  -> $(json 'len(d["events"])') events on $(json 'd["chain"]'), last hash $(json 'd["events"][-1]["hash"][:12]')..., chain verifies"

# 8. restore the badge
[ "$(admin "/agents/$AGENT/restore")" = 200 ] || fail "restore: $(cat "$OUT")"
echo "8 restore      -> status $(json 'd["status"]') at seq $(json 'd["seq"]')"
echo "curl demo OK"
