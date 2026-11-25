@echo off
setlocal
cd /d "%~dp0"

if not exist "workbench\server.py" (
    echo [ERROR] workbench\server.py not found in %cd%.
    pause
    exit /b 1
)

set "PYCMD="
where py >nul 2>nul && set "PYCMD=py -3"
if "%PYCMD%"=="" (
    where python >nul 2>nul && set "PYCMD=python"
)

if "%PYCMD%"=="" (
    echo [ERROR] Python 3 not found in PATH. Please install Python 3.8+.
    pause
    exit /b 1
)

echo Using Python: %PYCMD%
echo Starting MCU-Forge (51) Workbench: http://127.0.0.1:8765
echo Close this window to stop the server.
echo.
%PYCMD% -m workbench.server
echo.
echo Workbench server exited.
pause
endlocal
