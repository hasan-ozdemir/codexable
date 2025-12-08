@echo off
setlocal enabledelayedexpansion

rem ============================================================
rem Deploy helper: build Codex, assemble @openai/codex npm pack,
rem and install it globally. Everything happens in this script;
rem no external build-repo.cmd invocation.
rem ============================================================

rem Resolve repo root (directory of this script)
set "REPO_ROOT=%~dp0"
rem Version to publish; edit NPM_DEBUG_VERSION here.
set "npm_debug_version=0.65.1"
set "RELEASE_VERSION=%npm_debug_version%"
echo === Syncing repository versions to %RELEASE_VERSION% ===
powershell -NoProfile -Command ^
  "& { " ^
  "  $ErrorActionPreference='Stop';" ^
  "  $v='%RELEASE_VERSION%';" ^
  "  $root='%REPO_ROOT%';" ^
  "  $jsons=@('codex-cli/package.json','sdk/typescript/package.json','codex-rs/responses-api-proxy/npm/package.json','shell-tool-mcp/package.json');" ^
  "  foreach($rel in $jsons){" ^
  "    $p=Join-Path $root $rel;" ^
  "    $obj=Get-Content $p -Raw | ConvertFrom-Json;" ^
  "    $obj.version=$v;" ^
  "    $obj | ConvertTo-Json -Depth 50 | Set-Content -Encoding UTF8 $p" ^
  "  }" ^
  "  $tomlPath=Join-Path $root 'codex-rs/Cargo.toml';" ^
  "  $lines=Get-Content $tomlPath;" ^
  "  $start=$lines.IndexOf('[workspace.package]');" ^
  "  if($start -lt 0){throw 'workspace.package section not found'};" ^
  "  $found=$false;" ^
  "  for($i=$start+1;$i -lt $lines.Count;$i++){" ^
  "    if($lines[$i] -match '^\\s*\\['){break}" ^
  "    if($lines[$i] -match '^\\s*version\\s*='){ $lines[$i] = 'version = \"'+$v+'\"'; $found=$true; break }" ^
  "  }" ^
  "  if(-not $found){throw 'workspace.package version not found'}" ^
  "  Set-Content -Path $tomlPath -Value $lines -Encoding UTF8;" ^
  "}"
if errorlevel 1 (
    echo Version sync failed.
    exit /b 1
)

set "TARGET_TRIPLE=x86_64-pc-windows-msvc"
set "DIST_DIR=%REPO_ROOT%\dist\npm"
set "STAGE_DIR=%DIST_DIR%\codex-%RELEASE_VERSION%"
set "VENDOR_SRC=%DIST_DIR%\vendor-src-%RELEASE_VERSION%"
set "PACK_TGZ=%DIST_DIR%\openai-codex-%RELEASE_VERSION%.tgz"

rem Ensure output directories exist
if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

echo === Building codex CLI (release) ===
pushd "%REPO_ROOT%\codex-rs" >nul || exit /b 1
cargo build --release -p codex-cli
if errorlevel 1 (
    popd >nul
    echo cargo build failed.
    exit /b 1
)
popd >nul

echo === Preparing vendor payload ===
if exist "%VENDOR_SRC%" rd /s /q "%VENDOR_SRC%"
mkdir "%VENDOR_SRC%\%TARGET_TRIPLE%\codex" || exit /b 1
mkdir "%VENDOR_SRC%\%TARGET_TRIPLE%\path" || exit /b 1
copy /Y "%REPO_ROOT%\codex-rs\target\release\codex.exe" "%VENDOR_SRC%\%TARGET_TRIPLE%\codex\codex.exe" || exit /b 1

echo === Downloading ripgrep binary ===
set "RG_URL=https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip"
set "RG_ARCHIVE=%TEMP%\rg-%RANDOM%.zip"
set "RG_EXTRACT=%TEMP%\rg-extract-%RANDOM%"
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%RG_URL%' -OutFile '%RG_ARCHIVE%'" || (echo ripgrep download failed. & exit /b 1)
powershell -NoProfile -Command "New-Item -Force -ItemType Directory -Path '%RG_EXTRACT%' >$null; Expand-Archive -LiteralPath '%RG_ARCHIVE%' -DestinationPath '%RG_EXTRACT%' -Force" || (echo ripgrep extract failed. & exit /b 1)
set "RG_BIN=%RG_EXTRACT%\ripgrep-14.1.1-x86_64-pc-windows-msvc\rg.exe"
if not exist "%RG_BIN%" (
    echo ripgrep binary not found at %RG_BIN%
    exit /b 1
)
copy /Y "%RG_BIN%" "%VENDOR_SRC%\%TARGET_TRIPLE%\path\rg.exe" || exit /b 1
del "%RG_ARCHIVE%" 2>nul
rd /s /q "%RG_EXTRACT%" 2>nul

echo === Staging npm package ===
if exist "%STAGE_DIR%" rd /s /q "%STAGE_DIR%"
if exist "%PACK_TGZ%" del "%PACK_TGZ%"

set "NODE_DIR=%ProgramFiles%\nodejs"
set "NPM_CMD=npm"
if exist "%NODE_DIR%\npm.cmd" set "NPM_CMD=%NODE_DIR%\npm.cmd"

python "%REPO_ROOT%\codex-cli\scripts\build_npm_package.py" ^
  --package codex ^
  --release-version %RELEASE_VERSION% ^
  --staging-dir "%STAGE_DIR%" ^
  --vendor-src "%VENDOR_SRC%" || (
    echo npm staging failed.
    exit /b 1
)

echo === Packing npm tarball ===
pushd "%STAGE_DIR%" >nul || exit /b 1
call "%NPM_CMD%" pack --json --pack-destination "%DIST_DIR%"
set "PACK_STATUS=%ERRORLEVEL%"
popd >nul
if not "%PACK_STATUS%"=="0" (
    echo npm pack failed.
    exit /b 1
)

set "PACK_TGZ_FOUND="
if not exist "%PACK_TGZ%" (
    for /f "delims=" %%f in ('dir /b /a-d /o-d "%DIST_DIR%\openai-codex-*.tgz"') do (
        if "!PACK_TGZ_FOUND!"=="" set "PACK_TGZ_FOUND=%DIST_DIR%\%%f"
    )
    if "!PACK_TGZ_FOUND!"=="" (
        echo Unable to locate generated npm tarball in %DIST_DIR%.
        exit /b 1
    )
    set "PACK_TGZ=!PACK_TGZ_FOUND!"
)

rem Cleanup vendor source helper after packing
if exist "%VENDOR_SRC%" rd /s /q "%VENDOR_SRC%"

echo === Installing %PACK_TGZ% globally ===
call "%NPM_CMD%" install -g "%PACK_TGZ%"
if errorlevel 1 (
    echo npm install failed.
    exit /b 1
)

echo === deploy finished ===
endlocal
