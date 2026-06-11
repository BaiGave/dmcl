@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo 未找到 Node.js，请先安装：https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo 正在安装依赖，请稍候...
    call npm install
)

echo 正在启动 mcdev-wizard...
call npm run gui
pause
