@echo off
setlocal EnableExtensions
cd /d C:\uncen\collection-ledger
node apps\jobs\tokyo-hot-pipeline.js --step init-db --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\tokyo-hot-pipeline.js --step master --max-pages 3 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\tokyo-hot-pipeline.js --step common-master --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\tokyo-hot-pipeline.js --step thumbnails --limit 120 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo tokyo_hot master differential import completed.
pause
exit /b 0

:failed
echo tokyo_hot master import stopped.
pause
exit /b 1
