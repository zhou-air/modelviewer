@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ====================================================================
echo   PDMS Model Asset Manager - temporary public share (Cloudflare)
echo ====================================================================
echo.
echo   WARNING: this exposes the local server to the internet via a
echo   temporary trycloudflare.com URL. Anyone with the link can browse
echo   the models. The link dies when this window is closed.
echo.

rem ---- [1/4] locate Python ------------------------------------------------
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY goto nopython
echo   [1/4] Python: %PY%

if not exist "viewer\vendor\three.module.js" goto novendor

rem ---- [2/4] start backend if not already listening on 8765 ---------------
set "SERVER_STARTED_HERE=0"
netstat -ano | findstr /c:":8765 " | findstr /c:"LISTENING" >nul 2>nul
if errorlevel 1 (
  echo   [2/4] starting local backend on 127.0.0.1:8765 ...
  start "modelviewer-server" /min cmd /c ""%PY%" -u "tools\server.py" --port 8765"
  set "SERVER_STARTED_HERE=1"
  rem give the server a moment to bind
  ping -n 3 127.0.0.1 >nul
) else (
  echo   [2/4] backend already running on port 8765, reusing it.
)

rem ---- [3/4] locate or download cloudflared -------------------------------
set "CFD_EXE=%~dp0tools\bin\cloudflared.exe"
set "CFD="
if exist "%CFD_EXE%" set "CFD=%CFD_EXE%"
if not defined CFD where cloudflared >nul 2>nul && set "CFD=cloudflared"

if defined CFD (
  echo   [3/4] cloudflared: !CFD!
) else (
  echo   [3/4] cloudflared not found - downloading to tools\bin\ ...
  if not exist "tools\bin" mkdir "tools\bin"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-cloudflared.ps1" -Destination "%CFD_EXE%"
  if errorlevel 1 goto nodownload
  if not exist "%CFD_EXE%" goto nodownload
  set "CFD=%CFD_EXE%"
  echo          done.
)

rem ---- [4/4] open quick tunnel, grab URL, copy to clipboard ---------------
set "TUNNEL_LOG=%TEMP%\modelviewer-tunnel.log"
if exist "%TUNNEL_LOG%" del "%TUNNEL_LOG%" >nul 2>nul

echo   [4/4] opening Cloudflare quick tunnel ...
start "modelviewer-tunnel" /b cmd /c ""!CFD!" tunnel --url http://127.0.0.1:8765 --no-autoupdate > "%TUNNEL_LOG%" 2>&1"

set "URL="
set /a WAIT=0
:waiturl
if !WAIT! geq 45 goto nourtunnel
timeout /t 2 /nobreak >nul
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$m = Select-String -Path '%TUNNEL_LOG%' -Pattern 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $m.Matches[0].Value }"`) do set "URL=%%u"
if not defined URL (
  set /a WAIT+=2
  goto waiturl
)

powershell -NoProfile -Command "Set-Clipboard -Value '!URL!'"
echo.
echo   ==================================================================
echo.
echo     Public URL : !URL!
echo     (copied to clipboard)
echo.
echo   ==================================================================
echo.
echo   Keep this window open. Closing it (or Ctrl+C) tears the tunnel
echo   down and the URL stops working. Local server keeps running.
echo.

rem stay alive while the tunnel process runs, so the user sees the state
:keepalive
timeout /t 5 /nobreak >nul
tasklist /fi "imagename eq cloudflared.exe" 2>nul | findstr /i "cloudflared" >nul 2>nul
if errorlevel 1 (
  echo   Tunnel process exited. The URL is no longer valid.
  echo.
  pause
  exit /b 0
)
goto keepalive

:nourtunnel
echo   [ERROR] Could not get a trycloudflare.com URL within 90 seconds.
echo   Log tail:
powershell -NoProfile -Command "Get-Content '%TUNNEL_LOG%' -Tail 15 -ErrorAction SilentlyContinue"
echo.
echo   Check your network (a proxy on 127.0.0.1:7890 is used only for
echo   the first download, not for the tunnel itself - Cloudflare
echo   regions may need a VPN in some networks).
pause
exit /b 1

:nodownload
echo   [ERROR] Failed to download cloudflared.exe.
echo   Download manually from:
echo     https://github.com/cloudflare/cloudflared/releases/latest
echo   and save it as: %CFD_EXE%
pause
exit /b 1

:nopython
echo   [ERROR] No Python interpreter found.
pause
exit /b 1

:novendor
echo   [ERROR] viewer\vendor\three.module.js is missing (see README.md).
pause
exit /b 1
