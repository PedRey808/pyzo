@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Магнат - сервер
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Не найден Node.js. Установите его с сайта https://nodejs.org  ^(кнопка LTS^),
  echo  затем снова запустите этот файл.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
start "" http://localhost:8080
node server.js
pause
