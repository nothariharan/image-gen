@echo off
:: Launch the DEDICATED image-gen Edge auth profile with CDP port 9222.
:: Attach-first: if 9222 is already open, do nothing.
:: Does NOT kill your daily Edge — uses a separate --user-data-dir.

set PORT=9222
set PROFILE=%~dp0edge-auth-profile

curl -s http://127.0.0.1:%PORT%/json/version > nul 2>&1
if %errorlevel%==0 (
    echo Auth browser already running on port %PORT%. Ready!
    goto end
)

set EDGE="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set EDGE="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
)

if not exist "%PROFILE%" mkdir "%PROFILE%"

echo Launching dedicated auth-profile Edge on port %PORT%...
echo Profile: %PROFILE%
start "" %EDGE% --remote-debugging-port=%PORT% --remote-allow-origins=* --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check https://chatgpt.com

echo Waiting for port %PORT%...
timeout /t 4 /nobreak > nul

curl -s http://127.0.0.1:%PORT%/json/version > nul 2>&1
if %errorlevel%==0 (
    echo SUCCESS - Port %PORT% is open.
    echo If this is your first time, run:  node login-once.mjs
) else (
    echo Port not detected yet - Edge may still be loading.
    echo Retry: node setup-session.mjs
)

:end
pause
