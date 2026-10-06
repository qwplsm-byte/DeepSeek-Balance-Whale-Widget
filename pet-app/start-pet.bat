@echo off
rem dsh-pet 桌面宠物启动器（双击运行）
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo 首次运行：正在安装 Electron（约 100MB，已配置国内镜像）...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --no-audit --no-fund
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
