@echo off
setlocal
cd /d "%~dp0\..\.."
node apps\jobs\night24-owned-operations.js --step owned-review
if errorlevel 1 exit /b 1
start "" explorer "storage\exports\night24"
echo Check the CSV. Exact ID/title matches are pre-approved for moving and DB registration.
echo Explicit Night24 filename-only matches are move-only and will remain off the browser list.
echo Folder-only and title-only candidates require your own CSV review.
pause

