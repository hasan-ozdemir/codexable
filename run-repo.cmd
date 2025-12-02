@echo off
setlocal

rem Run Codex CLI directly from sources (debug build), no npm packaging.
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

rem Point extensions to the repo root folder so dev builds see JS plugins.
set "CODEX_TUI_EXTENSION_DIR=%REPO_ROOT%\extensions"
rem Enable extension logging in dev runs.
set "codex_extensions_log=true"

pushd "%REPO_ROOT%\codex-rs" >nul
cargo run -p codex-cli -- %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul

endlocal & exit /b %EXITCODE%
