@echo off
rem Opens the shop screens in an app window (Microsoft Edge), or else the default browser.
set "URL=http://localhost:3000"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --start-maximized
) else (
  start "" %URL%
)
