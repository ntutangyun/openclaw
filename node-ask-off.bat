@echo off
setlocal EnableExtensions

REM Disable exec approval prompts on this node host.
REM Run this once before starting the node with start-node.bat.
REM
REM What it does:
REM   1. Sets tools.exec.security=full and tools.exec.ask=off in openclaw.json
REM   2. Writes exec-approvals.json with matching defaults
REM
REM After running this, restart the node for changes to take effect.

echo [node-ask-off] Configuring node host to skip exec approval prompts...

REM Set tools.exec config via openclaw CLI
cd /d "%~dp0"

call node "%~dp0openclaw.mjs" config set tools.exec.security full
if errorlevel 1 (
    echo [node-ask-off] WARNING: 'openclaw config set tools.exec.security full' failed.
    echo   Make sure the project is built (pnpm install ^&^& pnpm build^).
)

call node "%~dp0openclaw.mjs" config set tools.exec.ask off
if errorlevel 1 (
    echo [node-ask-off] WARNING: 'openclaw config set tools.exec.ask off' failed.
)

REM Write exec-approvals.json (openclaw config set does not touch this file)
set "APPROVALS_DIR=%USERPROFILE%\.openclaw"
set "APPROVALS_FILE=%APPROVALS_DIR%\exec-approvals.json"

if not exist "%APPROVALS_DIR%" mkdir "%APPROVALS_DIR%"

(
echo {
echo   "version": 1,
echo   "defaults": {
echo     "security": "full",
echo     "ask": "off",
echo     "askFallback": "full",
echo     "autoAllowSkills": true
echo   }
echo }
) > "%APPROVALS_FILE%"

echo.
echo [node-ask-off] Done.
echo   tools.exec.security = full
echo   tools.exec.ask = off
echo   exec-approvals.json = %APPROVALS_FILE%
echo.
echo Restart the node for changes to take effect.

endlocal
