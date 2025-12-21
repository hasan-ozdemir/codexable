@echo off
setlocal enableextensions enabledelayedexpansion

for /f "delims=" %%i in ('git rev-parse --show-toplevel 2^>nul') do set "ROOT=%%i"
if not defined ROOT (
  echo ERROR: not inside a git repository.
  exit /b 1
)

pushd "%ROOT%" >nul

for /f "delims=" %%i in ('git status --porcelain 2^>nul') do (
  echo ERROR: working tree has uncommitted changes.
  echo HINT: commit or stash before running this script.
  popd
  exit /b 1
)

call :run "git fetch upstream" || goto :fail
call :run "git switch main" || goto :fail
call :merge "git merge upstream/main" || goto :fail
call :run "git push origin main" || goto :fail

call :run "git switch dev" || goto :fail
call :merge "git merge main" || goto :fail
call :run "git push origin dev" || goto :fail

echo.
echo Done.
popd
exit /b 0

:run
echo.
echo ==^> %~1
%~1
if errorlevel 1 (
  echo ERROR: command failed: %~1
  exit /b 1
)
exit /b 0

:merge
echo.
echo ==^> %~1
%~1
if errorlevel 1 (
  echo ERROR: merge failed: %~1
  call :report_conflicts
  exit /b 1
)
call :report_conflicts
if errorlevel 1 exit /b 1
exit /b 0

:report_conflicts
set "HAS_CONFLICTS="
for /f "delims=" %%i in ('git diff --name-only --diff-filter=U 2^>nul') do (
  set "HAS_CONFLICTS=1"
)
if defined HAS_CONFLICTS (
  echo ERROR: unresolved merge conflicts detected.
  echo.
  git diff --name-only --diff-filter=U
  echo.
  echo HINT: resolve conflicts, then run:
  echo   git add -A
  echo   git commit
  exit /b 1
)
exit /b 0

:fail
popd
exit /b 1
