@echo off
cd /d "%~dp0"
node server.js --open
if errorlevel 1 pause
