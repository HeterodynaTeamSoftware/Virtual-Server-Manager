@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title Virtual Server Manager 0.90.0 - start
set PORT=3080
set HOST=127.0.0.1
set URL=http://127.0.0.1:%PORT%
set LOGFILE=%~dp0runtime-server.log
set PIDFILE=%~dp0runtime-server.pid

echo ==============================================
echo   Virtual Server Manager 0.90.0 - start Windows
echo ==============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [BLAD] Node.js nie jest zainstalowany lub nie ma go w PATH.
  echo Zainstaluj Node.js 18+ i uruchom ten plik ponownie.
  pause
  exit /b 1
)

echo [INFO] Wersja Node:
node -v

echo [INFO] Sprawdzam zaleznosci lokalne...
node -e "require.resolve('express'); require.resolve('express-session'); require.resolve('bcryptjs'); console.log('OK')" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Brakuje lokalnych zaleznosci. Probuje uruchomic npm install...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [BLAD] Nie udalo sie zainstalowac zaleznosci.
    pause
    exit /b 1
  )
)

echo [INFO] Zatrzymuje poprzedni proces na porcie %PORT%, jesli istnieje...
for /f "tokens=*" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -ExpandProperty OwningProcess -Unique"') do (
  if not "%%P"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Stop-Process -Id %%P -Force -ErrorAction Stop } catch {}" >nul 2>&1
  )
)

del /f /q "%LOGFILE%" >nul 2>&1

echo [INFO] Uruchamiam serwer w tle...
start "Virtual Server Manager Server" /min cmd /c "cd /d "%~dp0" && set PORT=%PORT% && node server.js 1>> "%LOGFILE%" 2>>&1"

echo [INFO] Czekam na odpowiedz API /api/health ...
set READY=
for /L %%i in (1,1,60) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing %URL%/api/health -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
  if !errorlevel! == 0 (
    set READY=1
    goto :openbrowser
  )
  timeout /t 1 /nobreak >nul
)

:openbrowser
if defined READY (
  echo [OK] Serwer odpowiada.
  echo [OK] Otwieram przegladarke: %URL%
  start "" "%URL%"
  echo [OK] Gdyby karta nie otworzyla sie automatycznie, wejdz recznie na %URL%
  exit /b 0
)

echo [BLAD] Serwer nie odpowiedzial na czas.
echo [INFO] Otworz plik runtime-server.log i sprawdz log startu.
echo [INFO] Uruchom tez start_windows_debug.bat aby zobaczyc logi na zywo.
pause
exit /b 1
