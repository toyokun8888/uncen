@echo off
setlocal
cd /d "%~dp0\..\.."
set "ENV_FILE=C:\Users\toyoaki\Desktop\filedatachange\.env"
if not exist "%ENV_FILE%" (
  echo DB env file was not found.
  exit /b 1
)
set /p "REVIEW_CSV=Reviewed Gachinco review CSV full path: "
if not exist "%REVIEW_CSV%" (
  echo Review CSV was not found.
  exit /b 1
)
echo Filename markers with no unique title move to same-drive unmatched; matched files retain their names.
echo Existing registered paths, FC2-marked paths, and unrelated uncen paths are protected.
set /p "CONFIRM=Enter APPLY to proceed: "
if /i not "%CONFIRM%"=="APPLY" exit /b 0
node apps\jobs\gachinco-owned-operations.js --step owned-apply --input-file "%REVIEW_CSV%" --apply --env-file "%ENV_FILE%"
pause
