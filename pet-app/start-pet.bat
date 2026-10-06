@echo off
rem dsh-pet 桌面宠物启动器（双击运行）
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行：正在安装 Electron（约 100MB，走 npmmirror 镜像）...
  call npm install --no-audit --no-fund
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo 安装失败：请在本目录手动执行 npm install
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b 0
