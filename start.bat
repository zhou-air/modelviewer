@echo off
setlocal
cd /d "%~dp0"

echo ====================================================================
echo   PDMS Model Asset Manager - local launcher
echo ====================================================================
echo.

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if not defined PY goto nopython
echo   [1/3] Python interpreter: %PY%

if not exist "data\projects" mkdir "data\projects"
if not exist "viewer\vendor\three.module.js" goto novendor
if not exist "tools\rvmparser\rvmparser.exe" (
  echo   [warn] tools\rvmparser\rvmparser.exe not found - viewing works, importing will fail.
)

echo   [2/3] asset store: data\projects
echo   [3/3] starting local backend, the browser will open by itself ...
echo.
echo   Only 127.0.0.1 is used. Model data never leaves this machine.
echo   Close this window or press Ctrl+C to stop the server.
echo.

"%PY%" -u "tools\server.py" --port 8765
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
