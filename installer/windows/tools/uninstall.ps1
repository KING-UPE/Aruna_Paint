# Aruna POS: take the services, the updater task and the firewall rule away (run by the
# uninstaller as Administrator). The shop's data in C:\ProgramData\ArunaPOS is left alone here;
# the uninstaller deletes it only if the person says so.
param([Parameter(Mandatory = $true)][string]$InstallDir)
$ErrorActionPreference = 'Continue'

Write-Output 'Stopping the server...'
$server = Join-Path $InstallDir 'service\ArunaPOS-Server.exe'
if (Get-Service -Name 'ArunaPOS-Server' -ErrorAction SilentlyContinue) {
  Stop-Service -Name 'ArunaPOS-Server' -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $server) { & $server uninstall 2>&1 | ForEach-Object { "$_" } }
  else { & sc.exe delete 'ArunaPOS-Server' | Out-Null }
}

Write-Output 'Stopping the database...'
if (Get-Service -Name 'ArunaPOS-DB' -ErrorAction SilentlyContinue) {
  Stop-Service -Name 'ArunaPOS-DB' -Force -ErrorAction SilentlyContinue
  $pgctl = Join-Path $InstallDir 'pgsql\bin\pg_ctl.exe'
  if (Test-Path -LiteralPath $pgctl) { & $pgctl unregister -N 'ArunaPOS-DB' 2>&1 | ForEach-Object { "$_" } }
  else { & sc.exe delete 'ArunaPOS-DB' | Out-Null }
}

Unregister-ScheduledTask -TaskName 'Aruna POS Updater' -Confirm:$false -ErrorAction SilentlyContinue
& netsh.exe advfirewall firewall delete rule name='Aruna POS (shop screens)' | Out-Null
Write-Output 'Services removed.'
exit 0
