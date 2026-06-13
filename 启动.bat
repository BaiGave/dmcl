@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装：https://nodejs.org
    echo       安装后重新双击本脚本即可。
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [首次运行] 正在安装依赖，请稍候...
    rem Electron 二进制走国内镜像，避免下载卡死
    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

echo [启动] 正在编译 GUI...
call npm run gui:build
if %errorlevel% neq 0 (
    echo [错误] 编译失败。
    pause
    exit /b 1
)

echo [启动] 正在打开 DMCL 窗口...
call npx electron gui/main.js
if %errorlevel% neq 0 (
    echo [错误] 程序异常退出，请把上方日志截图反馈。
    pause
)
