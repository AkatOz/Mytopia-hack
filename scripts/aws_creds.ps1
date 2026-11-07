<#
.SYNOPSIS
  Save the Workshop Studio temporary AWS credentials for the MYTOPIA gateway, and nothing else.

.DESCRIPTION
  1. In Workshop Studio, click "Get AWS CLI credentials", choose the "Windows (PowerShell)" tab
     (any tab works) and click the copy icon.
  2. From the repo root run:   .\scripts\aws_creds.ps1
  The script reads the copied block from the clipboard (or from -FromFile), writes profile [ws]
  into gateway\.aws-credentials and gateway\.aws-config (both git-ignored), and verifies the
  identity with STS. It never touches ~\.aws, the registry or your PowerShell profile, so no other
  process on this laptop (the agent included) inherits the credentials. Re-run it whenever
  Workshop Studio shows new keys (they expire after a few hours; the error is ExpiredToken).
#>
param(
  [string]$FromFile,
  [string]$Profile = "ws"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$credsFile = Join-Path $root "gateway\.aws-credentials"
$configFile = Join-Path $root "gateway\.aws-config"
$region = "us-east-1"

if ($FromFile) {
  $text = Get-Content -Path $FromFile -Raw
} else {
  $text = ""
  try { $text = Get-Clipboard -Raw } catch { $text = "" }
  if (-not $text) {
    try { Add-Type -AssemblyName System.Windows.Forms; $text = [System.Windows.Forms.Clipboard]::GetText() } catch { $text = "" }
  }
}
if (-not $text) {
  Write-Host "Clipboard is empty. In Workshop Studio click 'Get AWS CLI credentials', copy the block, then run this again." -ForegroundColor Red
  exit 1
}

# Accept the PowerShell, CMD, bash and fish forms:
#   $Env:AWS_X="v"   set AWS_X=v   export AWS_X="v"   set -gx AWS_X "v"
$creds = @{}
foreach ($line in ($text -split "`r?`n")) {
  $c = $line.Trim()
  $c = $c -replace '^\$Env:', '' -replace '^export\s+', '' -replace '^set\s+-gx\s+', '' -replace '^set\s+', '' -replace '^setx\s+', ''
  if ($c -match '^(AWS_[A-Z_]+)\s*[= ]\s*"?([^"\s]+)"?\s*$') { $creds[$Matches[1]] = $Matches[2] }
}
foreach ($k in @("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")) {
  if (-not $creds[$k]) {
    Write-Host "Could not find $k in the copied text. Copy the whole block (three lines) and try again." -ForegroundColor Red
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path $credsFile) | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
@"
# Written by scripts\aws_creds.ps1 at $stamp (local time).
# Temporary Workshop Studio credentials for the gateway only. They expire after a few hours;
# re-run scripts\aws_creds.ps1 with fresh keys when any call fails with ExpiredToken.
[$Profile]
aws_access_key_id = $($creds['AWS_ACCESS_KEY_ID'])
aws_secret_access_key = $($creds['AWS_SECRET_ACCESS_KEY'])
aws_session_token = $($creds['AWS_SESSION_TOKEN'])
"@ | Set-Content -Path $credsFile -Encoding ASCII

if (-not (Test-Path $configFile)) {
@"
# Written by scripts\aws_creds.ps1. infra\provision.py adds [profile gateway] below.
[profile $Profile]
region = $region
output = json
"@ | Set-Content -Path $configFile -Encoding ASCII
}

Write-Host "Saved profile [$Profile] to $credsFile" -ForegroundColor Green

# Verify with STS, using only the two files (never ~\.aws, never the environment).
$env:AWS_SHARED_CREDENTIALS_FILE = $credsFile
$env:AWS_CONFIG_FILE = $configFile
foreach ($v in @("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE")) {
  if (Test-Path "Env:$v") { Remove-Item "Env:$v" }
}
$aws = Get-Command aws -ErrorAction SilentlyContinue
$py = Join-Path $root ".venv\Scripts\python.exe"
Write-Host "Verifying with AWS..." -ForegroundColor Cyan
if (Test-Path $py) {
  & $py (Join-Path $root "scripts\whoami.py") $Profile
} elseif ($aws) {
  & $aws.Source sts get-caller-identity --profile $Profile --region $region
} else {
  Write-Host "Saved, but neither the AWS CLI nor .venv\Scripts\python.exe is available to verify. Run scripts\probe.py once the venv exists." -ForegroundColor Yellow
}
Write-Host "Next: .venv\Scripts\python scripts\probe.py   (tests every permission MYTOPIA needs)" -ForegroundColor Cyan
