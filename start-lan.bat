@echo off
setlocal
cd /d "%~dp0"

echo ====================================================================
echo   PDMS Model Asset Manager - LAN launcher (accessible on the LAN)
echo ====================================================================
echo.

rem ---- Python: the portable runtime shipped in this package comes first,
rem ---- so the target machine does NOT need Python installed at all.
set "PY="
if exist "%~dp0runtime\python\python.exe" set "PY=%~dp0runtime\python\python.exe"
if not defined PY where python >nul 2>nul && set "PY=python"
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

"%PY%" -u "tools\server.py" --port 8765 --host 0.0.0.0 --public-port 8766
echo.
echo   Server stopped.
pause
exit /b 0

:nopython
echo   [ERROR] No Python interpreter found.
echo.
echo   This package ships its own interpreter at runtime\python\python.exe.
echo   If that folder is missing, re-extract the archive - do not delete runtime\.
echo   Or install Python 3 from https://www.python.org/downloads/ and tick
echo   "Add python.exe to PATH" during setup.
echo.
pause
exit /b 1

:novendor
echo   [ERROR] viewer\vendor\three.module.js is missing.
echo   The viewer needs the local three.js copy (see README.md).
echo.
pause
exit /b 1
