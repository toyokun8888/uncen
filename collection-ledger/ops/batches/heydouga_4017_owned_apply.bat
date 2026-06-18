@echo off
setlocal
cd /d C:\uncen\collection-ledger
node apps\jobs\heydouga-4017-new-mp4-import.js --step apply --input-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
echo.
pause
