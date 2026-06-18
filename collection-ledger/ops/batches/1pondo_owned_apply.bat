@echo off
setlocal EnableExtensions
cd /d C:\uncen\collection-ledger
node apps\jobs\1pondo-owned-operations.js --step owned-review --input-dir "%~dp0." --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "PLAN="
for /f "delims=" %%F in ('dir /b /o-d "%~dp01pondo_owned-review_*.csv"') do if not defined PLAN set "PLAN=%~dp0%%F"
if not defined PLAN goto :failed
echo Review CSV: %PLAN%
choice /c YN /n /m "Apply this reviewed 1Pondo owned-file plan? [Y/N] "
if errorlevel 2 goto :cancelled
node apps\jobs\1pondo-owned-operations.js --step owned-ready-plan --input-dir "%~dp0." --plan-csv "%PLAN%" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "READY_PLAN="
for /f "delims=" %%F in ('dir /b /o-d "%~dp01pondo_owned-ready-plan_*.csv"') do if not defined READY_PLAN set "READY_PLAN=%~dp0%%F"
if not defined READY_PLAN goto :failed
echo Ready CSV: %READY_PLAN%
node apps\jobs\1pondo-owned-operations.js --step owned-apply --input-dir "%~dp0." --plan-csv "%READY_PLAN%" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo 1Pondo owned import completed.
pause
exit /b 0

:cancelled
echo 1Pondo owned import cancelled after review.
pause
exit /b 0

:failed
echo 1Pondo owned import stopped. Check the review CSV in this folder.
pause
exit /b 1
