@echo off
setlocal EnableExtensions
cd /d C:\uncen\collection-ledger
node apps\jobs\heydouga-4017-new-mp4-import.js --step review --input-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\heydouga-4017-new-mp4-import.js --step apply --input-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo.
echo Import completed.
pause
exit /b 0
:failed
echo.
echo Import stopped. Check the review CSV in this folder.
pause
exit /b 1
