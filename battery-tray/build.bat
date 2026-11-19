@echo off
rem Build BatteryTray.exe with MinGW-w64 (MSYS2 / WinLibs); g++ must be in PATH.
cd /d "%~dp0"
g++ -std=c++17 -O2 -s -static -municode -mwindows battery_tray.cpp -o BatteryTray.exe -lsetupapi -lgdiplus -lshell32 -ladvapi32 -lole32
if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)
echo OK: BatteryTray.exe
