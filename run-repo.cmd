@echo off
setlocal enabledelayedexpansion

rem Defaults
set "resume_cmd="
set "profile="
set "profile_count=0"
set "resume_conflict="
set "search_flag=--enable web_search_request"
set "show_help="

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

rem Env for dev run
set "CODEX_TUI_EXTENSION_DIR=%REPO_ROOT%\extensions"
set "PATH=%REPO_ROOT%\codex-rs\bin;%PATH%"
set "codex_extensions_log=true"
set "AZURE_AI_API_KEY=[REDACTED_AZURE_KEY]"
rem Accessibility defaults (can be overridden by caller)
set "a11y_hide_edit_marker=true"
set "a11y_hide_prompt_hints=true"
set "a11y_hide_statusbar_hints=true"
set "a11y_editor_align_left=true"
set "a11y_editor_borderline=true"
set "a11y_keyboard_shortcuts=true"
set "a11y_audio_cues=true"
set "a11y_keyboard_shortcuts=true"

:parse_args
if "%~1"=="" goto after_parse
set "arg=%~1"

if /I "!arg!"=="-h"  (set "show_help=1" & shift & goto parse_args)
if /I "!arg!"=="-?"  (set "show_help=1" & shift & goto parse_args)
if /I "!arg!"=="--help" (set "show_help=1" & shift & goto parse_args)

if /I "!arg!"=="-sd" (
    set "search_flag="
    shift
    goto parse_args
)

if /I "!arg!"=="-r" (
    if defined resume_cmd if /I not "!resume_cmd!"=="resume" set "resume_conflict=1"
    set "resume_cmd=resume"
    shift
    goto parse_args
)

if /I "!arg!"=="-rl" (
    if defined resume_cmd if /I not "!resume_cmd!"=="resume --last" set "resume_conflict=1"
    set "resume_cmd=resume --last"
    shift
    goto parse_args
)

if /I "!arg!"=="-az" (
    set /a profile_count+=1
    set "profile=-p az"
    shift
    goto parse_args
)

if /I "!arg!"=="-m5" (
    set /a profile_count+=1
    set "profile=-p m5"
    shift
    goto parse_args
)

if /I "!arg!"=="-oc" (
    set /a profile_count+=1
    set "profile=-p oc"
    shift
    goto parse_args
)

if /I "!arg!"=="-og" (
    set /a profile_count+=1
    set "profile=-p og"
    shift
    goto parse_args
)

echo Unknown parameter: !arg!
goto error_exit

:after_parse
if defined show_help goto show_help

if defined resume_conflict (
    echo Only one resume switch may be used ^(-r or -rl^).
    goto error_exit
)

if %profile_count% GTR 1 (
    echo Only one profile switch allowed ^(-az ^| -m5 ^| -oc ^| -og^).
    goto error_exit
)

cls
set "CALLDIR=%REPO_ROOT%\codex-rs"
set "CLI_ARGS="
if defined resume_cmd set "CLI_ARGS=!CLI_ARGS! !resume_cmd!"
set "CLI_ARGS=!CLI_ARGS! --cd \"!CALLDIR!\""
if defined profile set "CLI_ARGS=!CLI_ARGS! !profile!"
set "CLI_ARGS=!CLI_ARGS! -s danger-full-access -a never"
if defined search_flag set "CLI_ARGS=!CLI_ARGS! !search_flag!"

pushd "%REPO_ROOT%\codex-rs" >nul
cargo run -p codex-cli -- !CLI_ARGS!
set "EXITCODE=%ERRORLEVEL%"
popd >nul
endlocal & exit /b %EXITCODE%

:show_help
echo Kullanilabilir parametreler:
echo   -r      "codex resume" ile baslatip oturum secmenizi saglar.
echo   -rl     "codex resume --last" ile son oturumu acar.
echo   -sd     Web aramasini kapatir ^(web_search parametresi gonderilmez^).
echo   -az     Profil: azure / codex5.
echo   -m5     Profil: azure / mini5.
echo   -oc     Profil: openai / gpt-5.1-codex-max ^(xhigh reasoning^).
echo   -og     Profil: openai / gpt-5.
echo   -h, -?, --help  Bu yardimi gosterir.
echo Notlar:
echo   * -r veya -rl, -sd ve tek profil parametresi birlikte kullanilabilir.
echo   * Profil seciminden yalnizca biri kabul edilir.
exit /b 0

:error_exit
exit /b 1
