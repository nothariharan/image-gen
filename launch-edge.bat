@echo off
:: Check if Edge is already running WITH debug port — if yes, nothing to do
curl -s http://localhost:9222/json/version > nul 2>&1
if %errorlevel%==0 (
    echo Edge is already running with debug port 9222. Ready!
    goto end
)

echo Edge is running WITHOUT debug port. Closing it now...
taskkill /F /IM msedge.exe > nul 2>&1
timeout /t 2 /nobreak > nul

:: Find Edge executable
set EDGE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    set EDGE="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)

echo Relaunching Edge with --remote-debugging-port=9222 ...
start "" %EDGE% --remote-debugging-port=9222 --restore-last-session

echo.
echo Edge is restarting with your normal profile. Wait 3-4 seconds for it to load.
timeout /t 4 /nobreak > nul

:: Verify the port is now open
curl -s http://localhost:9222/json/version > nul 2>&1
if %errorlevel%==0 (
    echo SUCCESS - Port 9222 is open. Claude can now generate images.
) else (
    echo Port not detected yet - Edge may still be loading. Try the setup test in a moment.
)

:end
pause
