@echo off
setlocal EnableExtensions
cd /d C:\uncen\collection-ledger
node apps\jobs\carib-owned-operations.js --step exception-review --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "PLAN="
for /f "delims=" %%F in ('dir /b /o-d "C:\uncen\collection-ledger\storage\exports\carib\carib_exception-review_*.csv"') do if not defined PLAN set "PLAN=C:\uncen\collection-ledger\storage\exports\carib\%%F"
if not defined PLAN goto :failed
echo Review CSV: %PLAN%
echo For uncertain rows, fill manual_movie_code and set review_status=approved before continuing.
choice /c YN /n /m "Apply this reviewed carib exception-folder plan? [Y/N] "
if errorlevel 2 goto :cancelled
node apps\jobs\carib-owned-operations.js --step exception-ready-plan --plan-csv "%PLAN%" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
set "READY_PLAN="
for /f "delims=" %%F in ('dir /b /o-d "C:\uncen\collection-ledger\storage\exports\carib\carib_exception-ready-plan_*.csv"') do if not defined READY_PLAN set "READY_PLAN=C:\uncen\collection-ledger\storage\exports\carib\%%F"
if not defined READY_PLAN goto :failed
echo Ready CSV: %READY_PLAN%
node apps\jobs\carib-owned-operations.js --step exception-apply --plan-csv "%READY_PLAN%" --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo carib exception-folder import completed.
pause
exit /b 0

:cancelled
echo carib exception-folder import cancelled after review.
pause
exit /b 0

:failed
echo carib exception-folder import stopped. Check the review CSV.
pause
exit /b 1
