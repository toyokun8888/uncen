@echo off
setlocal EnableExtensions
cd /d C:\uncen\collection-ledger
node apps\jobs\tokyo-hot-owned-operations.js --step review --output-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "PLAN="
for /f "delims=" %%F in ('dir /b /o-d "%~dp0tokyo_hot_owned_review_*.csv"') do if not defined PLAN set "PLAN=%~dp0%%F"
if not defined PLAN goto :failed
echo Review CSV: %PLAN%
echo This review scanned all available NAS drive roots, not only tokyo_hot_new_mp4.
choice /c YN /n /m "Apply this reviewed tokyo_hot owned-file plan? [Y/N] "
if errorlevel 2 goto :cancelled
node apps\jobs\tokyo-hot-owned-operations.js --step ready-plan --plan-csv "%PLAN%" --output-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "READY_PLAN="
for /f "delims=" %%F in ('dir /b /o-d "%~dp0tokyo_hot_owned_ready-plan_*.csv"') do if not defined READY_PLAN set "READY_PLAN=%~dp0%%F"
if not defined READY_PLAN goto :failed
echo Ready CSV: %READY_PLAN%
node apps\jobs\tokyo-hot-owned-operations.js --step apply --plan-csv "%READY_PLAN%" --output-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\collect-video-metadata.js --source tokyo_hot --step collect --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo tokyo_hot owned import completed.
pause
exit /b 0

:cancelled
echo tokyo_hot owned import cancelled after review.
pause
exit /b 0

:failed
echo tokyo_hot owned import stopped. Check the review CSV in this folder.
pause
exit /b 1
