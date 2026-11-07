; Aruna POS — Windows installer (built by installer/build.mjs with makensis).
;
; One file for a clean Windows PC: it puts in Node.js, PostgreSQL, the server and the screens,
; makes the database, starts both as Windows services and opens the first-run wizard. Run again
; (or by the updater, silently with /S) it updates: tools\setup.ps1 backs the database up, swaps
; the program, takes the new migrations and checks the server answers, or puts everything back.
;
; Defines from build.mjs: VERSION, STAGE (the staged files), OUTFILE.

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
!ifdef FAST
SetCompressor /SOLID zlib
!else
SetCompressor /SOLID lzma
SetCompressorDictSize 64
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define APPNAME "Aruna POS"
!define COMPANY "Pannala Aruna Paint Center"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArunaPOS"
!define URL "http://localhost:3000"

Name "${APPNAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
BrandingText "${COMPANY}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileDescription" "${APPNAME} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${COMPANY}"
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "${STAGE}\tools\aruna.ico"
!define MUI_UNICON "${STAGE}\tools\aruna.ico"
!define MUI_WELCOMEPAGE_TITLE "Install ${APPNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This puts the shop server on this PC: the database, the server and the screens, all started by themselves with Windows.$\r$\n$\r$\nRun it on the shop's main PC. Other PCs in the shop only need a browser.$\r$\n$\r$\nIf ${APPNAME} is already here, this updates it and keeps all the shop's data (a backup is made first).$\r$\n$\r$\nClick Next, then Install, and wait."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${APPNAME} is ready"
!define MUI_FINISHPAGE_TEXT "The shop server runs by itself and starts with Windows.$\r$\n$\r$\nOn this PC use the ${APPNAME} icon on the desktop. On other PCs in the shop open a browser at the address below.$\r$\n$\r$\n$0"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APPNAME} now"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APPNAME} needs 64-bit Windows 10 or 11." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
  ; Updates keep the folder the shop server is already in.
  ReadRegStr $1 HKLM "${UNINST_KEY}" "InstallLocation"
  ${If} $1 != ""
    StrCpy $INSTDIR $1
  ${EndIf}
FunctionEnd

Function OpenApp
  ExecShell "open" "$INSTDIR\tools\Open Aruna POS.cmd" "" SW_HIDE
FunctionEnd

Section "Install"
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  ; The new files go to a staging folder first; setup.ps1 swaps them in once the server has
  ; stopped, so a running server's files are never overwritten half way.
  RMDir /r "$INSTDIR\staging"
  SetOutPath "$INSTDIR\staging"
  File /r "${STAGE}\*.*"

  DetailPrint "Setting up the database and the server (this takes a few minutes)..."
  ; setup.ps1 moves the tools folder it came in, so it runs from a temporary copy.
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\staging\tools\setup.ps1" "$PLUGINSDIR\setup.ps1"
  ${GetParameters} $2
  ClearErrors
  ${GetOptions} $2 "/PINSECRET=" $1
  ${IfNot} ${Errors}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ARUNA_PIN_SECRET", t r1)'
  ${EndIf}
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\setup.ps1" -InstallDir "$INSTDIR" -Version "${VERSION}"'
  Pop $0
  ${If} $0 != "0"
    DetailPrint "Setup stopped (code $0). Nothing was changed for an existing shop: its old version is running."
    MessageBox MB_ICONSTOP "${APPNAME} could not be set up (code $0).$\r$\n$\r$\nThe details are in C:\ProgramData\ArunaPOS\logs (setup-*.log). For an update, the previous version is running again with its data." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  RMDir /r "$INSTDIR\staging"

  ; Shortcuts open the screens in an app window (Edge) on this PC.
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\tools\Open Aruna POS.cmd" "" "$INSTDIR\tools\aruna.ico" 0 SW_SHOWMINIMIZED
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\tools\Open Aruna POS.cmd" "" "$INSTDIR\tools\aruna.ico" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\tools\aruna.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $1 $2 $3
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $1

  ; The finish page shows the address other PCs use.
  ReadEnvStr $1 COMPUTERNAME
  StrCpy $0 "Other PCs: http://$1:3000"
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\tools\uninstall.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\pgsql"
  RMDir /r "$INSTDIR\service"
  RMDir /r "$INSTDIR\tools"
  RMDir /r "$INSTDIR\redist"
  RMDir /r "$INSTDIR\staging"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  ; The shop's data (database, backups, settings) stays unless the person asks; a silent
  ; uninstall always keeps it.
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete the shop's DATA (all bills, stock, users and backups in C:\ProgramData\ArunaPOS)?$\r$\n$\r$\nChoose No to keep it for a later install." /SD IDNO IDNO keep
    RMDir /r "$APPDATA\ArunaPOS"
  keep:
SectionEnd
