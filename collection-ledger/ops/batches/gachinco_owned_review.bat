@echo off
setlocal
cd /d "%~dp0\..\.."
node apps\jobs\gachinco-owned-operations.js --step owned-review
if errorlevel 1 exit /b 1
start "" explorer "storage\exports\gachinco"
echo Review the Gachinco owned-file CSV. Filename markers with no unique title go to unmatched.
echo Folder-only markers and title-only rows without a Gachinco marker remain at their original paths.
pause
