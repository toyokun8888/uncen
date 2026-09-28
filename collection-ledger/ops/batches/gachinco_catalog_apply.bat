@echo off
setlocal
cd /d "%~dp0\..\.."
set "ENV_FILE=C:\Users\toyoaki\Desktop\filedatachange\.env"
set "CATALOG=storage\imports\gachinco\gachinco-catalog-latest.json"
if not exist "%ENV_FILE%" (
  echo DB env file was not found: %ENV_FILE%
  exit /b 1
)
node apps\jobs\gachinco-pipeline.js --step crawl
if errorlevel 1 exit /b 1
node apps\jobs\gachinco-pipeline.js --step catalog-sync --input-file "%CATALOG%"
if errorlevel 1 exit /b 1
echo Review the dry-run totals above. Press a key to apply schema and catalog updates.
pause
node apps\jobs\gachinco-pipeline.js --step init-db --apply --env-file "%ENV_FILE%"
if errorlevel 1 exit /b 1
node apps\jobs\gachinco-pipeline.js --step catalog-sync --input-file "%CATALOG%" --apply --env-file "%ENV_FILE%"
if errorlevel 1 exit /b 1
node apps\jobs\gachinco-pipeline.js --step thumbnails --input-file "%CATALOG%" --apply --env-file "%ENV_FILE%"
if errorlevel 1 exit /b 1
node apps\jobs\gachinco-pipeline.js --step status --env-file "%ENV_FILE%"
pause
