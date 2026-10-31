@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Pharmacy Site Finder - startup
echo ============================================

if not exist "data\raw\zarfiat_pages\page_0006000.json" (
  echo [1/3] fetching data from pharmacy.fda.gov.ir ^(~18 min, resumable^) ...
  python src\fetch_zarfiat.py --transport playwright --take 5000 || goto :err
) else (
  echo [1/3] raw pages already captured ^(delete data\raw\zarfiat_pages to refresh^)
)

echo [2/3] loading pages into db\pharmacy.sqlite (shared with the web app) ...
python etl\load_pages.py --observed-at "2026-10-10T12:47:00+03:30" || goto :err

echo [3/3] starting the dashboard (Next.js) on http://localhost:3737
cd web
if not exist "node_modules" (
  echo       installing npm dependencies ...
  call npm install || goto :err
)
call npm run dev
goto :eof

:err
echo.
echo FAILED with exit code %errorlevel%
echo Optional standalone workspace: python app\server.py  -^> http://127.0.0.1:8765
pause
