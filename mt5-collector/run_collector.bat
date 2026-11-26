@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" collect_mt5.py %*
) else (
    python collect_mt5.py %*
)

set EXIT_CODE=%ERRORLEVEL%
endlocal & exit /b %EXIT_CODE%
