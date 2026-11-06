# One-time setup for the Lambda Rackside on Windows.
# Installs what the extension needs on this computer, asking before each install:
#   - Python 3   -> for the ping / BMC helper
#   - the ping / BMC helper itself
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File setup.ps1 <extension-id>
# (copy the exact command from the extension's Settings page)
param([string]$ExtensionId = "")
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Ok($m)   { Write-Host "OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "X  $m" -ForegroundColor Red }
function Step($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Ask($m)  { $a = Read-Host "$m [Y/n]"; return ($a -eq "" -or $a -match '^[Yy]') }
. (Join-Path $Dir "ping-helper\python.ps1")

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Fail "Missing or wrong extension ID."
  Write-Host "  Open the extension's Settings -> Getting started, click Copy next to the setup command, and paste it here."
  exit 1
}

Write-Host "Lambda Rackside - setup" -ForegroundColor Cyan
Write-Host "This installs the tools the extension needs. You'll be asked before anything is installed."

# 1. Python -----------------------------------------------------------------
Step "1/2  Python (for the ping and BMC helper)"
$Py = Find-Python
if ($Py) {
  Ok "Python is installed ($($Py.Path))"
} elseif ((Ask "Python isn't installed. Install it now (for this user, no admin needed)?") -and (Install-Python) -and ($Py = Find-Python)) {
  Ok "Python installed ($($Py.Path))"
} else {
  Write-NoPython
  exit 1
}

# 2. Helper ------------------------------------------------------------------
Step "2/2  Ping and BMC helper"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "ping-helper\install.ps1") $ExtensionId
if ($LASTEXITCODE -ne 0) { Fail "Helper install failed (see above)."; exit 1 }

Write-Host ""
Ok "Setup done. Go back to Chrome, reload the extension, and click 'Test ping helper' in Settings."
