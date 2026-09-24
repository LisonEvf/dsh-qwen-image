@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo ==========================================================
echo   dsh-qwen-image  install  (one click)
echo   https://github.com/lisonevf/dsh-qwen-image  ^(Qwen-Image-2.1 for dsh^)
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "installer\install.mjs" %*
set "CODE=%ERRORLEVEL%"
goto DONE

:NONODE
echo [X] Node.js not found.
echo.
echo     This installer (and dsh itself) needs Node.js 18 or newer.
echo     Download:  https://nodejs.org/en/download
echo     CN mirror: https://npmmirror.com/mirrors/node/
echo     After installing Node.js, run install.bat again.
echo.
set "CODE=1"
goto DONE

:DONE
echo.
if "%CODE%"=="0" echo [OK] Installation finished. Restart dsh to load the plugin.
if not "%CODE%"=="0" echo [X]  Installation failed (exit code %CODE%). Read the messages above / the log file.
echo.
echo Press any key to close this window...
pause >nul
exit /b %CODE%
