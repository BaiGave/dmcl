@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem 双击运行时 Explorer 可能拿不到用户 PATH，补常见 Node 安装路径
set "PATH=%LocalAppData%\Programs\nodejs;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装：https://nodejs.org
    echo       安装后重新双击本脚本即可。
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 npm，请重新安装 Node.js（勾选 npm 组件）。
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [首次运行] 正在安装依赖，请稍候...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

echo [启动] 正在编译并打开 DMCL 窗口...
call npm run gui
if errorlevel 1 (
    echo [错误] 启动失败，请把上方日志截图反馈。
    pause
    exit /b 1
)

endlocal
