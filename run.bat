@echo off
title Aruna Paint POS
echo ========================================================
echo   Starting Pannala Aruna Paint Center POS Local Server
echo ========================================================
echo Starting PostgreSQL Bridge...
start "Aruna-PG-Bridge" /B node bridge.js
timeout /t 2 >nul
echo Starting Web and Backend Dev Servers...
pnpm dev
