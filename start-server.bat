@echo off
chcp 65001 >nul
title 哔哩下载器本地代理
cd /d "%~dp0"

rem 检查 Node.js 是否可用
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js（https://nodejs.org）后再运行本脚本。
  pause
  exit /b 1
)

rem 端口已占用则直接退出（避免重复启动多个代理）
netstat -ano | findstr ":8123" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo 本地代理已在运行（端口 8123），无需重复启动。
  timeout /t 2 /nobreak >nul
  exit /b 0
)

rem 静默启动代理：隐藏窗口在后台运行，本窗口自动关闭，无多余弹窗。
rem 浏览器页面每 2 秒自动检测连接，无需手动刷新。
wscript //nologo "%~dp0start-hidden.vbs"
echo 本地代理已在后台静默启动（端口 8123）。
echo 请回到浏览器页面，连接会自动建立。
timeout /t 2 /nobreak >nul
exit /b 0
