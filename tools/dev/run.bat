@echo off
title Aruna Paint POS
echo ========================================================
echo   Starting Pannala Aruna Paint Center POS Local Server
echo ========================================================
rem Runs from the project folder (this file lives in tools\dev).
cd /d "%~dp0..\.."
echo Starting PostgreSQL Bridge...
start "Aruna-PG-Bridge" /B node tools\dev\bridge.js
timeout /t 2 >nul
echo Starting Web and Backend Dev Servers...
pnpm dev
