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

echo [启动] 正在打开 mcdev-wizard 窗口...
call npx electron gui/main.js
pause
