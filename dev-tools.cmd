@echo off
setlocal
echo Running developer environment check...

powershell -NoProfile -ExecutionPolicy Bypass -Command @'
$ErrorActionPreference = "Stop"

function Test-Check([scriptblock]$sb) {
  try { & $sb *> $null; return $true } catch { return $false }
}

$winget = Get-Command winget -ErrorAction SilentlyContinue

$reqs = @(
  @{name='git';         check={ git --version };             install='Git.Git'},
  @{name='node';        check={ node --version };            install='OpenJS.NodeJS.LTS'},
  @{name='npm';         check={ npm --version };             install=$null},
  @{name='python';      check={ python --version };          install='Python.Python.3'},
  @{name='pwsh';        check={ pwsh -Version };             install='Microsoft.Powershell'},
  @{name='rustup';      check={ rustup --version };          install='Rustlang.Rustup'},
  @{name='cargo';       check={ cargo --version };           install=$null},
  @{name='just';        check={ just --version };            install='Casey.Just'},
  @{name='cargo-insta'; check={ cargo insta --version };     install=$null},
  @{name='rg';          check={ rg --version };              install='BurntSushi.ripgrep'}
)

$missing = @()

foreach ($r in $reqs) {
  Write-Host "Checking $($r.name)..."
  if (Test-Check $r.check) {
    Write-Host "  [ok] $($r.name)"
    continue
  }

  Write-Host "  [missing] $($r.name)"
  if ($r.install -and $winget) {
    $ans = Read-Host "  Install $($r.name) via winget? (y/n)"
    if ($ans -match '^[yY]') {
      try {
        winget install --id $($r.install) -e --silent --accept-package-agreements --accept-source-agreements
      } catch {
      }
      if (Test-Check $r.check) {
        Write-Host "  [installed] $($r.name)"
        continue
      }
    }
  }
  $missing += $r.name
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host ("Missing: " + ($missing -join ", ")) -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "All required tools found." -ForegroundColor Green
exit 0
'@

endlocal
