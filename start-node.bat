@echo off
setlocal EnableExtensions

REM Start an OpenClaw node host and connect to a gateway running in Docker.
REM
REM Usage:
REM   start-node.bat --token <token> [--port <port>] [--host <host>]
REM   start-node.bat -t <token> [-p <port>] [-h <host>]
REM
REM Defaults: host=127.0.0.1, port=19000
REM
REM You can also set OPENCLAW_GATEWAY_TOKEN in the environment instead of
REM passing --token. A --token flag takes precedence over the env var.

set "GATEWAY_HOST=127.0.0.1"
set "GATEWAY_PORT=19000"
set "CLI_TOKEN="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--token" (
    set "CLI_TOKEN=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="-t" (
    set "CLI_TOKEN=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="--port" (
    set "GATEWAY_PORT=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="-p" (
    set "GATEWAY_PORT=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="--host" (
    set "GATEWAY_HOST=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="-h" (
    set "GATEWAY_HOST=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="--help" goto show_help
if /I "%~1"=="/?" goto show_help
echo [start-node] ERROR: unknown argument "%~1"
goto show_help

:show_help
echo Usage: start-node.bat --token ^<token^> [--port ^<port^>] [--host ^<host^>]
echo   -t, --token  Gateway auth token (or set OPENCLAW_GATEWAY_TOKEN)
echo   -p, --port   Gateway port (default: 19000)
echo   -h, --host   Gateway host (default: 127.0.0.1)
exit /b 1

:args_done

if not "%CLI_TOKEN%"=="" set "OPENCLAW_GATEWAY_TOKEN=%CLI_TOKEN%"

if "%OPENCLAW_GATEWAY_TOKEN%"=="" (
    echo [start-node] ERROR: no gateway token provided.
    echo Pass one with --token ^<token^> or set OPENCLAW_GATEWAY_TOKEN.
    exit /b 1
)

cd /d "%~dp0"

if not exist "dist\entry.mjs" if not exist "dist\entry.js" (
    echo [start-node] dist/ not found - building openclaw first...
    where pnpm >nul 2>nul
    if errorlevel 1 (
        echo [start-node] ERROR: pnpm is not installed.
        echo Install it with: npm install -g pnpm
        exit /b 1
    )
    call pnpm install || exit /b 1
    call pnpm build || exit /b 1
)

REM Override the default command shell with Git Bash when available.
REM Set OPENCLAW_NODE_SHELL to the path of any bash-compatible shell.
if not defined OPENCLAW_NODE_SHELL (
    if exist "C:\Program Files\Git\bin\bash.exe" (
        set "OPENCLAW_NODE_SHELL=C:\Program Files\Git\bin\bash.exe"
    )
)
if defined OPENCLAW_NODE_SHELL (
    echo [start-node] Using shell: %OPENCLAW_NODE_SHELL%
)

echo [start-node] Connecting node host to %GATEWAY_HOST%:%GATEWAY_PORT%
node "%~dp0openclaw.mjs" node run --host %GATEWAY_HOST% --port %GATEWAY_PORT%

endlocal
