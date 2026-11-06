@echo off
title Push to GitHub
cd /d "C:\Users\dmcpc\Downloads\Aruna_Paint"
echo ========================================================
echo Pushing Aruna_Paint to https://github.com/KING-UPE/Aruna_Paint
echo A GitHub sign-in popup or browser window will appear now.
echo ========================================================
git push -u origin main
echo.
pause
