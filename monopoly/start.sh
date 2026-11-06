#!/bin/sh
# Запуск сервера «Магнат» на Mac / Linux / Termux:  sh start.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Termux: pkg install nodejs   Mac/Linux: https://nodejs.org"
  exit 1
fi
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
node server.js
