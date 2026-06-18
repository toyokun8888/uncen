@echo off
setlocal
cd /d C:\uncen\collection-ledger
node apps\jobs\paco-manual-dry-run.js --source paco --step owned-apply --new-mp4-dir "%~dp0." --owned-dir "%~d0\uncen\paco" --trash-dir "%~d0\uncen\paco_trash" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
echo.
pause
