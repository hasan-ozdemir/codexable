@echo off
setlocal enabledelayedexpansion

rem Determine repo root (directory of this script)
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

rem Normalize package.json path for Node (avoid backslash escapes)
set "PKG_PATH=%REPO_ROOT%\codex-cli\package.json"
set "PKG_PATH=%PKG_PATH:\=/%"
for /f "usebackq tokens=* delims=" %%v in (`node -e "console.log(require(process.env.PKG_PATH).version)"`) do set "VERSION=%%v"
if "%VERSION%"=="" (
  echo Failed to read version from codex-cli/package.json
  exit /b 1
)

set "TARGET_TRIPLE=x86_64-pc-windows-msvc"
set "DIST_DIR=%REPO_ROOT%\dist\npm"
set "STAGE_DIR=%DIST_DIR%\codex-%VERSION%"
set "VENDOR_SRC=%DIST_DIR%\vendor-src-%VERSION%"
set "PACK_TGZ=%DIST_DIR%\openai-codex-%VERSION%.tgz"

echo === Building release binary (codex-cli) ===
pushd "%REPO_ROOT%\codex-rs" >nul
cargo build --release -p codex-cli || (popd >nul & exit /b 1)
popd >nul

echo === Preparing vendor source ===
if exist "%VENDOR_SRC%" rd /s /q "%VENDOR_SRC%"
mkdir "%VENDOR_SRC%\%TARGET_TRIPLE%\codex" || exit /b 1
mkdir "%VENDOR_SRC%\%TARGET_TRIPLE%\path" || exit /b 1
echo === Copying codex.exe into vendor source ===
copy /Y "%REPO_ROOT%\codex-rs\target\release\codex.exe" "%VENDOR_SRC%\%TARGET_TRIPLE%\codex\codex.exe" || exit /b 1

echo === Staging npm package ===
if exist "%STAGE_DIR%" rd /s /q "%STAGE_DIR%"
if exist "%PACK_TGZ%" del "%PACK_TGZ%"

rem Discover npm command
set "NODE_DIR=%ProgramFiles%\nodejs"
set "NPM_CMD=npm"
if exist "%NODE_DIR%\npm.cmd" set "NPM_CMD=%NODE_DIR%\npm.cmd"

python "%REPO_ROOT%\codex-cli\scripts\build_npm_package.py" ^
  --package codex ^
  --version %VERSION% ^
  --staging-dir "%STAGE_DIR%" ^
  --vendor-src "%VENDOR_SRC%" || exit /b 1

echo === Packing npm tarball ===
pushd "%STAGE_DIR%" >nul
"%NPM_CMD%" pack --json --pack-destination "%DIST_DIR%"
if errorlevel 1 (
  popd >nul
  echo npm pack failed.
  exit /b 1
)
popd >nul
rem Clean vendor-src helper after successful pack to avoid clutter
if exist "%VENDOR_SRC%" rd /s /q "%VENDOR_SRC%"
echo.
echo Done. Staged package: %STAGE_DIR%
echo Tarball: %PACK_TGZ%

endlocal
