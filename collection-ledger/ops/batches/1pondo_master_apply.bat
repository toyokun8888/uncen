@echo off
setlocal
cd /d C:\uncen\collection-ledger
node apps\jobs\1pondo-pipeline.js --step master --dry-run --max-pages 1 --limit 25 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\1pondo-pipeline.js --step master --max-pages 3 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\1pondo-pipeline.js --step common-master --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\1pondo-pipeline.js --step thumbnails --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo 1Pondo master update completed.
pause
exit /b 0

:failed
echo 1Pondo master update stopped.
pause
exit /b 1
