# The bypass proof: a revoked badge refuses the SAME still-valid Cognito token, a tampered token gets 401,
# and a shell without the gateway's credentials cannot reach the tools Lambda directly. Then the badge is restored.
# One line per step; exits non-zero at the first unexpected answer (and restores the badge if it revoked it).
# Same steps as scripts/replay.sh. Usage: powershell -ExecutionPolicy Bypass -File scripts\replay.ps1 [-Url http://127.0.0.1:8787]
param([string]$Url = $(if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { "http://127.0.0.1:8787" }))
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root ".venv\Scripts\python.exe"
$AwsCli = if ($env:AWS_CLI) { $env:AWS_CLI } else { "C:\Users\bobvu\AppData\Local\awscli-venv\Scripts\aws.cmd" }
$Agent = "research-bot"
$ScrubDir = Join-Path $Root "scripts\scrubbed"
$Out = [System.IO.Path]::GetTempFileName()
$Hdr = [System.IO.Path]::GetTempFileName()
$Body = [System.IO.Path]::GetTempFileName()
$MintBase = [System.IO.Path]::GetTempFileName()
$Mint = $MintBase + ".py"
$script:RevokedByUs = $false
Set-Location $Root

function Remove-Temp { Remove-Item $Out, $Hdr, $Body, $MintBase, $Mint -ErrorAction SilentlyContinue }
function Fail([string]$Message) {
    Write-Output "FAIL: $Message"
    if ($script:RevokedByUs) {
        curl.exe -s -o NUL -X POST "$Url/agents/$Agent/restore" -H "X-Admin-Token: $AdminToken" | Out-Null
        Write-Output "   (cleanup: badge restored after the failure)"
    }
    Remove-Temp
    exit 1
}
function Read-Out { Get-Content $Out -Raw | ConvertFrom-Json }
function Admin([string]$Path) {
    # POST with the admin token; returns the HTTP status, body in $Out
    return (curl.exe -s -o $Out -w "%{http_code}" -X POST "$Url$Path" -H "X-Admin-Token: $AdminToken")
}
function Get-BadgeStatus {
    curl.exe -s -o $Out "$Url/agents/$Agent/status" -H "X-Admin-Token: $AdminToken" | Out-Null
    return (Read-Out).status
}
function Mcp([string]$Tok, [int]$Id, [string]$Method, [string]$ParamsJson) {
    # writes the JSON-RPC body to a file (no quoting trouble); returns the HTTP status, body in $Out, headers in $Hdr
    $json = '{"jsonrpc":"2.0","id":' + $Id + ',"method":"' + $Method + '","params":' + $ParamsJson + '}'
    [System.IO.File]::WriteAllText($Body, $json)
    return (curl.exe -s -D $Hdr -o $Out -w "%{http_code}" -X POST "$Url/mcp" -H "Authorization: Bearer $Tok" `
        -H "X-Run-Id: run-replay" -H "Content-Type: application/json" --data-binary "@$Body")
}
function Invoke-Scrubbed([string[]]$CliArgs) {
    # A child process whose environment is EMPTIED first; only the OS basics the CLI needs to start come back,
    # plus AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE pointing at empty files. No AWS_PROFILE, no keys.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot "System32\cmd.exe"
    $quoted = ($CliArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "
    $psi.Arguments = '/d /s /c ""' + $AwsCli + '" ' + $quoted + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables.Clear()
    foreach ($k in "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "COMSPEC", "PATHEXT") {
        $v = [Environment]::GetEnvironmentVariable($k)
        if ($v) { $psi.EnvironmentVariables[$k] = $v }
    }
    $psi.EnvironmentVariables["AWS_CONFIG_FILE"] = Join-Path $ScrubDir "aws_config.ini"
    $psi.EnvironmentVariables["AWS_SHARED_CREDENTIALS_FILE"] = Join-Path $ScrubDir "aws_credentials.ini"
    $aws = @($psi.EnvironmentVariables.Keys | Where-Object { $_ -like "AWS_*" } | Sort-Object)
    if (($aws -join " ") -ne "AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE") { Fail "the scrubbed environment carries: $($aws -join ' ')" }
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $stdout = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    return @{ Code = $p.ExitCode; Text = ($stdout + $errTask.Result) }
}

$AdminToken = & $Py -c "from dotenv import dotenv_values; print(dotenv_values('gateway/.env').get('ADMIN_TOKEN') or '')"
if (-not $AdminToken) { Fail "ADMIN_TOKEN is empty in gateway\.env" }
try { $h = Invoke-RestMethod "$Url/healthz" } catch { Fail "no gateway at $Url" }
if ("$($h.mode)/$($h.token_mode)" -ne "aws/cognito") { Fail "gateway is in $($h.mode)/$($h.token_mode) mode; this proof needs mode aws with Cognito tokens" }

# 0. precondition: the badge must start ACTIVE (a previous run may have left it REVOKED or KILLED)
$s = Get-BadgeStatus
if ($s -ne "ACTIVE") {
    if ((Admin "/agents/$Agent/restore") -ne "200") { Fail "restore before the proof: $(Get-Content $Out -Raw)" }
    Write-Output "0 precondition -> $Agent was $s; restored to ACTIVE at seq $((Read-Out).seq)"
} else {
    Write-Output "0 precondition -> $Agent is ACTIVE"
}

# 1. mint a research-bot token (unsigned GetClientToken, no AWS credentials) and call read_file: allow
$mintCode = @'
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
'@
[System.IO.File]::WriteAllText($Mint, $mintCode)
$Token = & $Py $Mint $Agent
if (-not $Token) { Fail "could not mint a Cognito token" }
$code = Mcp $Token 1 "tools/call" '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}'
if ($code -ne "200") { Fail "read_file HTTP $code $(Get-Content $Out -Raw)" }
$r = Read-Out
if ($r.result.isError) { Fail "read_file was not allowed: $($r.result.content[0].text)" }
$first = ($r.result.content[0].text -split "`n")[0]
Write-Output "1 read_file    -> ALLOW with a fresh Cognito token $($Token.Substring(0, 8))...: $($first.Substring(0, [Math]::Min(50, $first.Length)))"

# 2. revoke the badge
if ((Admin "/agents/$Agent/revoke") -ne "200") { Fail "revoke: $(Get-Content $Out -Raw)" }
$script:RevokedByUs = $true
$r = Read-Out
Write-Output "2 revoke       -> status $($r.status) at seq $($r.seq)"

# 3. replay the SAME token: tools/call refused with the badge reason, tools/list empty
$code = Mcp $Token 3 "tools/call" '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}'
if ($code -ne "200") { Fail "replayed read_file HTTP $code $(Get-Content $Out -Raw)" }
$r = Read-Out
$text = $r.result.content[0].text
if (-not $r.result.isError) { Fail "replayed read_file was not refused: $text" }
if (-not $text.Contains("badge REVOKED")) { Fail "replayed read_file refused for another reason: $text" }
Write-Output "3 same token   -> tools/call read_file: isError, $text"
$code = Mcp $Token 4 "tools/list" "{}"
if ($code -ne "200") { Fail "replayed tools/list HTTP $code $(Get-Content $Out -Raw)" }
$n = @((Read-Out).result.tools).Count
if ($n -ne 0) { Fail "replayed tools/list shows $n tools" }
Write-Output "3 same token   -> tools/list: 0 tools"

# 4. tampered token: one character flipped in the middle of the signature part -> HTTP 401 + WWW-Authenticate
#    (the middle, not the last character: the last base64url character carries padding bits and may decode the same)
$parts = $Token.Split(".")
$sig = $parts[2]
$i = [int][Math]::Floor($sig.Length / 2)
$flip = if ($sig[$i] -ne [char]"A") { "A" } else { "B" }
$Bad = $parts[0] + "." + $parts[1] + "." + $sig.Substring(0, $i) + $flip + $sig.Substring($i + 1)
if ($Bad -eq $Token) { Fail "the tampered token equals the original" }
$code = Mcp $Bad 5 "tools/call" '{"name":"read_file","arguments":{"path":"/drive/q3-planning.md"}}'
$www = (Get-Content $Hdr | Where-Object { $_ -match "^(?i)www-authenticate:" } | Select-Object -First 1)
if ($code -ne "401") { Fail "tampered token got HTTP $code $(Get-Content $Out -Raw)" }
if (-not $www) { Fail "tampered token: 401 without WWW-Authenticate" }
$www = ($www -replace "^(?i)www-authenticate:\s*", "").Trim()
Write-Output "4 tampered     -> HTTP 401, WWW-Authenticate: $www; $((Read-Out).error.message)"

# 5. an expired token: not run; step 3 already shows that a token still inside its lifetime is refused
Write-Output "5 expired      -> skipped (not needed: step 3 refused a token that had not expired)"

# 6. a scrubbed shell (no AWS_* variables, no profile, empty config and credentials files) calls the tools Lambda directly
New-Item -ItemType Directory -Force $ScrubDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $ScrubDir "aws_config.ini"), "")
[System.IO.File]::WriteAllText((Join-Path $ScrubDir "aws_credentials.ini"), "")
$outJson = Join-Path $ScrubDir "out.json"
Remove-Item $outJson -ErrorAction SilentlyContinue
$res = Invoke-Scrubbed @("lambda", "invoke", "--function-name", "mytopia-tools", "--region", "us-east-1", $outJson)
if ($res.Code -eq 0) { Fail "the scrubbed shell invoked the Lambda (exit 0)" }
$line = ($res.Text -split "`r?`n" | Where-Object { $_ -match "Unable to locate credentials" } | Select-Object -First 1)
if (-not $line) { Fail "scrubbed lambda invoke: unexpected answer: $($res.Text)" }
if ((Test-Path $outJson) -and ((Get-Item $outJson).Length -gt 0)) { Fail "out.json was written" }
Write-Output "6 no creds     -> aws lambda invoke mytopia-tools: exit $($res.Code), $($line.Trim())"
$res = Invoke-Scrubbed @("lambda", "invoke", "--function-name", "mytopia-tools", "--region", "us-east-1", "--profile", "gateway", $outJson)
if ($res.Code -eq 0) { Fail "the scrubbed shell invoked the Lambda with --profile gateway (exit 0)" }
$line = ($res.Text -split "`r?`n" | Where-Object { $_ -match "could not be found" } | Select-Object -First 1)
if (-not $line) { Fail "scrubbed lambda invoke --profile gateway: unexpected answer: $($res.Text)" }
if ((Test-Path $outJson) -and ((Get-Item $outJson).Length -gt 0)) { Fail "out.json was written" }
Write-Output "6 no profile   -> aws lambda invoke --profile gateway: exit $($res.Code), $($line.Trim())"

# 7. restore the badge and read it back
if ((Admin "/agents/$Agent/restore") -ne "200") { Fail "restore: $(Get-Content $Out -Raw)" }
$seq = (Read-Out).seq
$script:RevokedByUs = $false
$s = Get-BadgeStatus
if ($s -ne "ACTIVE") { Fail "badge reads $s after restore" }
Write-Output "7 restore      -> status ACTIVE at seq $seq (read back from the registry: $s)"
Remove-Temp
Write-Output "replay proof OK"
