@echo off
chcp 65001 >nul
cd /d "%~dp0"
set NODE_NO_WARNINGS=1
echo.
echo   Writing Studio : http://127.0.0.1:7373
echo   Database       : data\studio.db
echo   Close this window to stop the server.
echo.
start "" http://127.0.0.1:7373
node server.js
echo.
echo   Server stopped.
pause
