@echo off
:: Launch Edge with CDP port 9222 using your normal profile (ChatGPT login).
:: Fully closes Edge first — required so the debug port actually binds.

curl -s http://127.0.0.1:9222/json/version > nul 2>&1
if %errorlevel%==0 (
    echo Edge is already running with debug port 9222. Ready!
    goto end
)

echo Closing any running Edge so the debug port can bind...
taskkill /F /IM msedge.exe /T > nul 2>&1
timeout /t 3 /nobreak > nul

set EDGE="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set EDGE="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
)

set USERDATA=%LOCALAPPDATA%\Microsoft\Edge\User Data

echo Relaunching Edge with --remote-debugging-port=9222 ...
start "" %EDGE% --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%USERDATA%" --profile-directory=Default --restore-last-session https://chatgpt.com

echo.
echo Waiting for port 9222...
timeout /t 4 /nobreak > nul

curl -s http://127.0.0.1:9222/json/version > nul 2>&1
if %errorlevel%==0 (
    echo SUCCESS - Port 9222 is open.
    echo Open chatgpt.com in that Edge window and make sure you are logged in.
) else (
    echo Port not detected yet - Edge may still be loading. Retry in a few seconds:
    echo   node setup-session.mjs
)

:end
pause
