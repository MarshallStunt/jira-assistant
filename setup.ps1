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
function HasPython {
  foreach ($c in @("py", "python", "python3")) {
    if (Get-Command $c -ErrorAction SilentlyContinue) {
      try { & $c -c "import sys; assert sys.version_info >= (3, 6)" 2>$null; if ($LASTEXITCODE -eq 0) { return $true } } catch {}
    }
  }
  return $false
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Fail "Missing or wrong extension ID."
  Write-Host "  Open the extension's Settings -> Getting started, click Copy next to the setup command, and paste it here."
  exit 1
}
$HasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

Write-Host "Lambda Rackside - setup" -ForegroundColor Cyan
Write-Host "This installs the tools the extension needs. You'll be asked before anything is installed."

# 1. Python -----------------------------------------------------------------
Step "1/2  Python (for the ping and BMC helper)"
if (HasPython) {
  Ok "Python is installed"
} elseif ($HasWinget -and (Ask "Python isn't installed. Install it now with winget?")) {
  winget install -e --id Python.Python.3.13 --scope user --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
  if (HasPython) { Ok "Python installed" } else { Fail "Python didn't install. Close this window, open a new PowerShell and run setup again, or ask IT."; exit 1 }
} else {
  Fail "Python is needed. Install it from python.org (tick 'Add python.exe to PATH') or ask IT, then run setup again."
  exit 1
}

# 2. Helper ------------------------------------------------------------------
Step "2/2  Ping and BMC helper"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "ping-helper\install.ps1") $ExtensionId
if ($LASTEXITCODE -ne 0) { Fail "Helper install failed (see above)."; exit 1 }

Write-Host ""
Ok "Setup done. Go back to Chrome, reload the extension, and click 'Test ping helper' in Settings."
