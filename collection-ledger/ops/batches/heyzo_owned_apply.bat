@echo off
setlocal
cd /d C:\uncen\collection-ledger
node apps\jobs\heyzo-owned-operations.js --step owned-review --input-dir "%~dp0" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "PLAN="
for /f "delims=" %%F in ('dir /b /o-d "%~dp0heyzo_owned-review_*.csv"') do if not defined PLAN set "PLAN=%~dp0%%F"
if not defined PLAN goto :failed
echo Review CSV: %PLAN%
choice /c YN /n /m "Apply this reviewed HEYZO owned-file plan? [Y/N] "
if errorlevel 2 goto :cancelled
node apps\jobs\heyzo-owned-operations.js --step owned-apply --input-dir "%~dp0" --plan-csv "%PLAN%" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo HEYZO owned import completed.
pause
exit /b 0

:cancelled
echo HEYZO owned import cancelled after review.
pause
exit /b 0

:failed
echo HEYZO owned import stopped. Check the review CSV in this folder.
pause
exit /b 1
