@echo off
rem Spin up N Ribbon Cable agents on one llama.cpp server (ADR-0031).
rem   scripts\agents.bat            asks what to do
rem   scripts\agents.bat --help     the options of scripts\load.ts, which does the work
rem Needs Node 24 (mise.toml pins it). Nothing else: no pnpm install, no WSL.
setlocal EnableExtensions
cd /d "%~dp0.."

where node >nul 2>nul || (echo Node was not found. Install Node 24 or run: mise install & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node --version') do set NODEMAJOR=%%v
if "%NODEMAJOR%" LSS "v24" (echo Node 24 or newer is needed; this is %NODEMAJOR%. Run: mise install & exit /b 1)

if /i "%~1"=="--help" goto help
if /i "%~1"=="/?" goto help
if not "%~1"=="" (node scripts\load.ts %* & exit /b %errorlevel%)

:menu
echo.
echo  Ribbon Cable agents
echo  -------------------
echo   1. Start a new group of agents
echo   2. Continue the previous session (same agents, same server)
echo   3. Continue a different saved session
echo   4. List saved sessions
echo   5. Quit
echo.
choice /c 12345 /n /m "Choose 1-5: "
if errorlevel 5 exit /b 0
if errorlevel 4 goto list
if errorlevel 3 goto pick
if errorlevel 2 goto resume
goto fresh

:list
node scripts\load.ts --list
goto end

:resume
set ROUNDS_ASK=
set /p ROUNDS_ASK="How many more rounds? [3]: "
if "%ROUNDS_ASK%"=="" set ROUNDS_ASK=3
node scripts\load.ts --resume --rounds %ROUNDS_ASK%
goto end

:pick
node scripts\load.ts --list
echo.
set SID=
set /p SID="Session id to continue: "
if "%SID%"=="" goto end
set ROUNDS_ASK=
set /p ROUNDS_ASK="How many more rounds? [3]: "
if "%ROUNDS_ASK%"=="" set ROUNDS_ASK=3
node scripts\load.ts --resume %SID% --rounds %ROUNDS_ASK%
goto end

:fresh
set N=
set /p N="How many agents? [3]: "
if "%N%"=="" set N=3

echo.
echo  Which server should they connect to?
echo   1. This machine      http://localhost:8081
echo   2. The Fly server    https://comp4020-final-da-w1nn3r.fly.dev
echo   3. Another address
choice /c 123 /n /m "Choose 1-3: "
set SERVER=http://localhost:8081
if errorlevel 3 (set /p SERVER="Server URL: ") else if errorlevel 2 set SERVER=https://comp4020-final-da-w1nn3r.fly.dev

echo.
echo  When the run ends, should the agents delete their accounts?
echo   Y = delete them through /admin (tidy)
echo   N = keep them, so you can continue this session later
choice /c YN /n /m "Delete the accounts at the end? [Y/N]: "
set DELFLAG=--delete
if errorlevel 2 set DELFLAG=--keep

set LLAMA_ASK=
echo.
set /p LLAMA_ASK="llama.cpp URL ending in /v1 [Enter = find one automatically]: "
set LLAMAARG=
if not "%LLAMA_ASK%"=="" set LLAMAARG=--llama %LLAMA_ASK%

set ROUNDS_ASK=
set /p ROUNDS_ASK="Rounds (1 = join and swipe, 2+ = chat) [3]: "
if "%ROUNDS_ASK%"=="" set ROUNDS_ASK=3

echo.
node scripts\load.ts --agents %N% --server %SERVER% %DELFLAG% --rounds %ROUNDS_ASK% %LLAMAARG%
goto end

:help
echo Usage: scripts\agents.bat                      asks what to do
echo        scripts\agents.bat --agents 4 --server http://localhost:8081 --delete
echo        scripts\agents.bat --resume               continue the latest session
echo        scripts\agents.bat --list
echo Every option is described at the top of scripts\load.ts.
exit /b 0

:end
echo.
pause
endlocal
