# The MYTOPIA demo steps with curl.exe against a running gateway: list, allow, deny, revoke, deny again, empty list, events, restore.
# Each step prints one line and the script exits non-zero on the first unexpected answer. Usage: scripts\curl_demo.ps1 [-Url http://127.0.0.1:8787]
param([string]$Url = $(if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { "http://127.0.0.1:8787" }))
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root ".venv\Scripts\python.exe"
$Agent = "research-bot"
$Out = [System.IO.Path]::GetTempFileName()
$Body = [System.IO.Path]::GetTempFileName()
Set-Location $Root

function Fail([string]$Message) { Write-Output "FAIL: $Message"; Remove-Item $Out, $Body -ErrorAction SilentlyContinue; exit 1 }
function Setting([string]$Name) { & $Py -c "from gateway.config import Settings; print(Settings.from_env().$Name)" }
function Read-Out { Get-Content $Out -Raw | ConvertFrom-Json }

function Mcp([int]$Id, [string]$Method, [string]$ParamsJson) {
    # writes the JSON-RPC body to a file (no quoting trouble), returns the parsed answer
    $json = '{"jsonrpc":"2.0","id":' + $Id + ',"method":"' + $Method + '","params":' + $ParamsJson + '}'
    [System.IO.File]::WriteAllText($Body, $json)
    $code = curl.exe -s -o $Out -w "%{http_code}" -X POST "$Url/mcp" -H "Authorization: Bearer $Token" `
        -H "X-Run-Id: run-curl" -H "Content-Type: application/json" --data-binary "@$Body"
    if ($code -ne "200") { Fail "$Method HTTP $code $(Get-Content $Out -Raw)" }
    return Read-Out
}
function Admin([string]$Path) {
    $code = curl.exe -s -o $Out -w "%{http_code}" -X POST "$Url$Path" -H "X-Admin-Token: $AdminToken"
    if ($code -ne "200") { Fail "$Path HTTP $code $(Get-Content $Out -Raw)" }
    return Read-Out
}

$AdminToken = Setting "admin_token"
$TokenMode = if ($env:TOKEN_MODE) { $env:TOKEN_MODE } else { Setting "token_mode" }

# 0. mint a token (never printed in full)
if ($TokenMode -eq "cognito") {
    $mint = @'
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
'@
    [System.IO.File]::WriteAllText($Body, $mint)
    $Token = & $Py $Body $Agent
} else {
    $Token = & $Py -m gateway.issuer_local $Agent
}
if (-not $Token) { Fail "could not mint a token" }
Write-Output "0 token        -> $TokenMode token $($Token.Substring(0, 12))... for $Agent"

# 1. tools/list: expect the 4 tools on research-bot's badge
$r = Mcp 1 "tools/list" "{}"
$names = @($r.result.tools | ForEach-Object { $_.name })
if ($names.Count -ne 4) { Fail "expected 4 tools, got $($names.Count)" }
Write-Output "1 tools/list   -> $($names.Count) tools: $($names -join ' ')"

# 2. read_file: allowed
$r = Mcp 2 "tools/call" '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}'
if ($r.result.isError) { Fail "read_file was not allowed: $($r.result.content[0].text)" }
$first = ($r.result.content[0].text -split "`n")[0]
Write-Output "2 read_file    -> ALLOW: $($first.Substring(0, [Math]::Min(60, $first.Length)))"

# 3. send_email: denied with a reason
$r = Mcp 3 "tools/call" '{"name":"send_email","arguments":{"to":"ceo@example.corp","subject":"Q3 summary","body":"hi"}}'
$text = $r.result.content[0].text
if ($text -ne "DENIED: send_email is not on badge research-bot [rule: allow-list]") { Fail "send_email: $text" }
Write-Output "3 send_email   -> $text"

# 4. revoke the badge
$r = Admin "/agents/$Agent/revoke"
$RevokeSeq = $r.seq
Write-Output "4 revoke       -> status $($r.status) at seq $($r.seq)"

# 5. read_file again: denied, and the event carries ms_since_revoke
$r = Mcp 5 "tools/call" '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}'
$text = $r.result.content[0].text
if (-not ($text.StartsWith("DENIED: badge REVOKED at") -and $text.EndsWith("[rule: status-revoked]"))) { Fail "read_file after revoke: $text" }
curl.exe -s -o $Out "$Url/events?since_seq=$RevokeSeq"
$last = @((Read-Out).events | Where-Object { $_.decision -eq "deny" })[0]
if ($null -eq $last -or $null -eq $last.ms_since_revoke) { Fail "the deny after revoke carries no ms_since_revoke" }
Write-Output "5 read_file    -> $text (ms_since_revoke=$($last.ms_since_revoke))"

# 6. tools/list again: empty
$r = Mcp 6 "tools/list" "{}"
if (@($r.result.tools).Count -ne 0) { Fail "tools/list after revoke is not empty" }
Write-Output "6 tools/list   -> 0 tools (badge REVOKED)"

# 7. the event chain
curl.exe -s -o $Out "$Url/events?since_seq=0"
$ok = & $Py -c "import json,sys; from gateway.events import verify_chain; print(verify_chain(json.load(open(sys.argv[1]))['events']))" $Out
if ($ok -ne "True") { Fail "hash chain does not verify" }
$ev = Read-Out
Write-Output "7 GET /events  -> $(@($ev.events).Count) events on $($ev.chain), last hash $($ev.events[-1].hash.Substring(0, 12))..., chain verifies"

# 8. restore the badge
$r = Admin "/agents/$Agent/restore"
Write-Output "8 restore      -> status $($r.status) at seq $($r.seq)"
Remove-Item $Out, $Body -ErrorAction SilentlyContinue
Write-Output "curl demo OK"
