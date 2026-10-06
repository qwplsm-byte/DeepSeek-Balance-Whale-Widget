@echo off
rem dsh-pet desktop pet launcher (double-click to run).
rem Keep this file ASCII-only: cmd.exe parses .bat with the OEM codepage, so any
rem non-ASCII text here becomes mojibake commands. .gitattributes pins it to CRLF
rem too - cmd mis-parses LF-only line endings inside if(...) blocks.
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing Electron, about 100MB, via npmmirror ...
  call npm install --no-audit --no-fund
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: Electron not found. Run "npm install" in this folder manually.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b 0
