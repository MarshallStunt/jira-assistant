# Installs the Lambda Rackside helper on Windows so the Chrome extension can ping servers and talk to BMCs.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File install.ps1 <extension-id>
# The exact command (with your extension ID) is shown in the extension's Settings page.
param([string]$ExtensionId = "")
$ErrorActionPreference = "Stop"

$HostName = "com.dcops.ping_helper"
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Host "Usage: powershell -ExecutionPolicy Bypass -File install.ps1 <extension-id>"
  Write-Host "Copy the full command from the extension's Settings page -> Ping helper."
  exit 1
}
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path

# Find Python 3.6+ (prefer one with TLS 1.3: some BMCs refuse older TLS). The Microsoft Store "python"
# placeholder doesn't run anything, so every candidate is actually started.
function Get-PythonExe([string]$exe, [string[]]$extra) {
  try {
    $exe = & $exe @extra -c "import sys, ssl; assert sys.version_info >= (3, 6); print(sys.executable); print(ssl.HAS_TLSv1_3)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe) { return @{ Path = $exe[0].Trim(); Tls13 = ($exe[1].Trim() -eq "True") } }
  } catch {}
  return $null
}
$found = @()
foreach ($c in @("py -3", "python", "python3")) {
  $parts = $c -split " "
  if (Get-Command $parts[0] -ErrorAction SilentlyContinue) {
    $p = Get-PythonExe $parts[0] @($parts | Select-Object -Skip 1)
    if ($p) { $found += $p }
  }
}
$Py = ($found | Where-Object { $_.Tls13 } | Select-Object -First 1)
if (-not $Py) { $Py = $found | Select-Object -First 1 }
if (-not $Py) {
  Write-Host "X Python 3 not found." -ForegroundColor Red
  Write-Host "  Install it with:  winget install -e --id Python.Python.3.13   (or from python.org), then run this again."
  exit 1
}

$InstallDir = Join-Path $env:LOCALAPPDATA "DCOpsPingHelper"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Src "dcops_ping_helper.py") (Join-Path $InstallDir "dcops_ping_helper.py") -Force
$Run = Join-Path $InstallDir "run.bat"
Set-Content -Path $Run -Encoding ASCII -Value "@echo off`r`n`"$($Py.Path)`" `"%~dp0dcops_ping_helper.py`" %*"

$Manifest = Join-Path $InstallDir "$HostName.json"
# Keep extensions allowed by an earlier install (e.g. a second copy of the folder), newest last.
$New = "chrome-extension://$ExtensionId/"
$Origins = @()
if (Test-Path $Manifest) { try { $Origins = @((Get-Content -Raw $Manifest | ConvertFrom-Json).allowed_origins) } catch {} }
$Origins = @(@($Origins | Where-Object { $_ -match '^chrome-extension://[a-p]{32}/$' -and $_ -ne $New }) + $New | Select-Object -Last 5)
$json = @{
  name = $HostName
  description = "Lambda Rackside helper (ping, BMC)"
  path = $Run
  type = "stdio"
  allowed_origins = $Origins
} | ConvertTo-Json
[IO.File]::WriteAllText($Manifest, $json)  # UTF-8 without BOM (Chrome rejects a BOM)

# Chrome, Edge, Brave and Chromium read native messaging hosts from these registry keys.
$Browsers = @{
  "Google Chrome" = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
  "Microsoft Edge" = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  "Brave" = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
  "Chromium" = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
}
foreach ($b in $Browsers.GetEnumerator()) {
  New-Item -Path $b.Value -Force | Out-Null
  Set-Item -Path $b.Value -Value $Manifest
  Write-Host "OK Registered for $($b.Key)" -ForegroundColor Green
}

# Self-test: send a 'hello' message through the helper exactly like Chrome would.
$test = @'
import json, struct, subprocess, sys
msg = json.dumps({"action": "hello"}).encode()
p = subprocess.run([sys.argv[1]], input=struct.pack("=I", len(msg)) + msg, stdout=subprocess.PIPE, timeout=20, shell=True)
n = struct.unpack("=I", p.stdout[:4])[0]
r = json.loads(p.stdout[4:4 + n])
print("OK Helper works (v%s, %s, Python %s, %s)" % (r["version"], r["platform"], r["python"], r.get("tls", "")))
'@
$testFile = Join-Path $env:TEMP "dcops_helper_test.py"
[IO.File]::WriteAllText($testFile, $test)
& $Py.Path $testFile $Run
Remove-Item $testFile -ErrorAction SilentlyContinue
if (-not $Py.Tls13) { Write-Host "! This Python has no TLS 1.3. Some BMCs may refuse it; the helper will retry with curl." -ForegroundColor Yellow }

Write-Host ""
Write-Host "Done. In Chrome, open the extension's Settings and click 'Test ping helper'."
