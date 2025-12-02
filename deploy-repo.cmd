@echo off
setlocal
call "%~dp0build-repo.cmd"
if errorlevel 1 goto :eof

echo === deploy finished ===
endlocal
