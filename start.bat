@echo off
rem NeoGuide - serve this folder and open it in your browser.
rem Browsers block data files when index.html is opened directly from disk,
rem so a tiny local web server is needed. Nothing is uploaded anywhere.
cd /d "%~dp0"
set PORT=8765
where python >nul 2>nul && goto :py
where py     >nul 2>nul && goto :pyl
where node   >nul 2>nul && goto :node
echo Could not find Python or Node on this computer.
echo Install Python from https://python.org and run this file again.
pause
exit /b 1
:py
start "" http://localhost:%PORT%/
python -m http.server %PORT%
exit /b
:pyl
start "" http://localhost:%PORT%/
py -m http.server %PORT%
exit /b
:node
start "" http://localhost:%PORT%/
npx --yes http-server -p %PORT%
exit /b
