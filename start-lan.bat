@echo off
setlocal
cd /d "%~dp0"

echo ====================================================================
echo   PDMS Model Asset Manager - LAN launcher (accessible on the LAN)
echo ====================================================================
echo.

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if not defined PY goto nopython
echo   [1/2] Python interpreter: %PY%

if not exist "viewer\vendor\three.module.js" goto novendor

echo   [2/2] starting backend on 0.0.0.0 (LAN visible), browser will open ...
echo.
echo   LAN URL is printed below ("LAN"). Close this window or Ctrl+C to stop.
echo.

"%PY%" -u "tools\server.py" --port 8765 --host 0.0.0.0
echo.
echo   Server stopped.
pause
exit /b 0

:nopython
echo   [ERROR] No Python interpreter found.
echo   Install Python 3, or add its folder to PATH.
echo.
pause
exit /b 1

:novendor
echo   [ERROR] viewer\vendor\three.module.js is missing.
echo   The viewer needs the local three.js copy (see README.md).
echo.
pause
exit /b 1
