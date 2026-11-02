# Removes the Lambda Rackside helper (ping, BMC) from Windows.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File uninstall.ps1
$HostName = "com.dcops.ping_helper"
foreach ($key in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName")) {
  Remove-Item -Path $key -Force -ErrorAction SilentlyContinue
}
Remove-Item -Path (Join-Path $env:LOCALAPPDATA "DCOpsPingHelper") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Removed the Lambda Rackside helper."
