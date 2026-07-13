@echo off
chcp 65001 >nul
setlocal
title 入团申请材料审核助手

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-review.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-review.ps1"
)

set "launchExit=%errorlevel%"
if not "%launchExit%"=="0" (
  color 0C
  echo.
  echo 启动失败。请查看上方错误信息，或把窗口内容截图反馈。
  echo 此窗口不会自动关闭。
  echo.
  pause
)
exit /b %launchExit%
