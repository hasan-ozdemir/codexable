@echo off
setlocal enableextensions

rem Thin wrapper that delegates to PowerShell implementation to avoid cmd parsing issues.

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "REPO_ROOT=%REPO_ROOT:"=%"

set "npm_debug_version=0.73.1"
set "RELEASE_VERSION=%npm_debug_version%"

rem Pass through additional args (e.g., -rb)
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\deploy-repo.ps1" -Version "%RELEASE_VERSION%" -RepoRoot "%REPO_ROOT%" %*
endlocal
