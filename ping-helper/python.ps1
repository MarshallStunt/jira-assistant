# Finds Python 3.6+ on Windows for the Lambda Rackside helper. Dot-sourced by setup.ps1 and install.ps1.
# Looks on PATH (py launcher, python, python3), in the registry where Python installers record themselves, and in the
# usual install folders, so a Python that isn't on PATH (unticked "Add to PATH", or installed a minute ago) is still found.
# Prefers one with TLS 1.3 (some BMCs refuse older TLS). Every candidate is actually started: the Microsoft Store
# "python" placeholder is on PATH but doesn't run anything.

function Update-PathFromRegistry {
  $env:Path = $env:Path + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Test-PythonExe([string]$exe, [string[]]$extra = @()) {
  try {
    $out = @(& $exe @extra -c "import sys, ssl; assert sys.version_info >= (3, 6); print(sys.executable); print(ssl.HAS_TLSv1_3)" 2>$null)
    if ($LASTEXITCODE -eq 0 -and $out.Count -ge 2) { return @{ Path = "$($out[0])".Trim(); Tls13 = ("$($out[1])".Trim() -eq "True") } }
  } catch {}
  return $null
}

function Find-Python {
  Update-PathFromRegistry
  $found = @()
  foreach ($c in @("py -3", "python", "python3")) {
    $parts = $c -split " "
    if (Get-Command $parts[0] -ErrorAction SilentlyContinue) {
      $p = Test-PythonExe $parts[0] @($parts | Select-Object -Skip 1)
      if ($p) { $found += $p }
    }
  }

  $files = @()
  foreach ($root in @("HKCU:\Software\Python\PythonCore", "HKLM:\Software\Python\PythonCore", "HKLM:\Software\WOW6432Node\Python\PythonCore")) {
    foreach ($k in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $ip = Get-ItemProperty -Path "$($k.PSPath)\InstallPath" -ErrorAction SilentlyContinue
      if ($ip.ExecutablePath) { $files += $ip.ExecutablePath }
      elseif ($ip.'(default)') { $files += (Join-Path $ip.'(default)' "python.exe") }
    }
  }
  foreach ($pattern in @("$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", "$env:ProgramFiles\Python3*\python.exe", "${env:ProgramFiles(x86)}\Python3*\python.exe")) {
    $files += @(Resolve-Path $pattern -ErrorAction SilentlyContinue | ForEach-Object { $_.Path })
  }
  foreach ($f in @($files | Select-Object -Unique)) {
    if ($f -and (Test-Path -LiteralPath $f) -and -not ($found | Where-Object { $_.Path -eq $f })) {
      $p = Test-PythonExe $f
      if ($p) { $found += $p }
    }
  }

  $py = $found | Where-Object { $_.Tls13 } | Select-Object -First 1
  if (-not $py) { $py = $found | Select-Object -First 1 }
  return $py
}

# Installs Python for this user with winget (no admin needed) and puts it on PATH. False when winget isn't there.
function Install-Python {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
  winget install -e --id Python.Python.3.13 --scope user --accept-source-agreements --accept-package-agreements --custom "PrependPath=1" | Out-Host
  return $true
}

function Write-NoPython {
  Write-Host "X  Python 3 not found." -ForegroundColor Red
  Write-Host "   Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') or ask IT,"
  Write-Host "   then close this window, open a new PowerShell and run the command again."
}
