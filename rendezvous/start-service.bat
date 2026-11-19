@echo off
rem Starts the EsteefCast rendezvous service. Close this window to stop it.
cd /d "%~dp0"
if not exist cert.pem (
  echo cert.pem and key.pem are missing. Copy them into this folder first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install --no-audit --no-fund || goto :fail
)
:loop
node server.js
echo The service stopped. Restarting in 5 seconds (close this window to stop it)...
timeout /t 5 /nobreak >nul
goto loop
:fail
echo Setup failed.
pause
