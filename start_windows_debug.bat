@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title Virtual Server Manager 0.90.0 - debug
set PORT=3080

echo ==============================================
echo   Virtual Server Manager 0.90.0 - DEBUG
echo ==============================================
echo [INFO] Ta wersja nie zamyka okna i pokazuje log serwera na zywo.
echo [INFO] Po starcie wejdz recznie na: http://127.0.0.1:%PORT%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [BLAD] Node.js nie jest zainstalowany lub nie ma go w PATH.
  pause
  exit /b 1
)

node -v
if not exist node_modules (
  echo [INFO] Brak node_modules - uruchamiam npm install...
  call npm install --no-fund --no-audit || goto :fail
)

set PORT=%PORT%
node server.js
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [BLAD] Serwer zakonczyl sie bledem.
pause
exit /b 1
