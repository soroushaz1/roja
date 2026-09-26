@echo off
title Roja - local preview
cd /d "%~dp0"

echo.
echo   Roja is starting at  http://127.0.0.1:4173
echo.
echo   Keep this window open while you use the site.
echo   Press Ctrl+C (or just close this window) to stop it.
echo.

REM Open the browser a moment after the server is listening.
start /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4173'"

node tools\preview.cjs

echo.
echo   Server stopped.
pause
