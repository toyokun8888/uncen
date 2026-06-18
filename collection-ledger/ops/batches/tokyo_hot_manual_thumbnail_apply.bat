@echo off
setlocal EnableExtensions
cd /d C:\uncen\collection-ledger
node apps\jobs\import-tokyo-hot-manual-thumbnails.js --step review --input-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "PLAN="
for /f "delims=" %%F in ('dir /b /o-d "%~dp0tokyo_hot_manual_thumbnail_review_*.csv"') do if not defined PLAN set "PLAN=%~dp0%%F"
if not defined PLAN goto :failed
echo Review CSV: %PLAN%
choice /c YN /n /m "Apply this reviewed tokyo_hot thumbnail plan? [Y/N] "
if errorlevel 2 goto :cancelled
node apps\jobs\import-tokyo-hot-manual-thumbnails.js --step apply --input-dir "%~dp0." --plan-csv "%PLAN%" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo tokyo_hot manual thumbnail import completed.
pause
exit /b 0

:cancelled
echo tokyo_hot manual thumbnail import cancelled after review.
pause
exit /b 0

:failed
echo tokyo_hot manual thumbnail import stopped.
pause
exit /b 1
