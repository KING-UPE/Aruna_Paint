# Aruna POS updater: the "Aruna POS Updater" scheduled task runs this as SYSTEM when the server
# asks for it (schtasks /Run), outside the server's own service so it may stop the server.
#
# The server has downloaded the installer and checked its SHA-256, then written
# data\updates\pending.json ({ version, from, installer, sha256 }). This checks the file once more
# and runs the installer silently; the installer (tools\setup.ps1) backs up, updates, checks the
# server answers and rolls back on failure, and writes last-result.json.
$ErrorActionPreference = 'Stop'
$Updates = Join-Path $env:ProgramData 'ArunaPOS\data\updates'
$Pending = Join-Path $Updates 'pending.json'
$Log = Join-Path $env:ProgramData ("ArunaPOS\logs\updater-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Say([string]$text) {
  Add-Content -LiteralPath $Log -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $text)
}

function Fail([object]$job, [string]$message) {
  Say "FAILED: $message"
  $r = [ordered]@{ version = $job.version; from = $job.from; ok = $false; message = $message; at = (Get-Date).ToUniversalTime().ToString('o') }
  # UTF-8 without a byte-order mark: the server reads it as JSON.
  [IO.File]::WriteAllText((Join-Path $Updates 'last-result.json'), ($r | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  exit 1
}

if (-not (Test-Path -LiteralPath $Pending)) { exit 0 }
$job = Get-Content -LiteralPath $Pending -Raw | ConvertFrom-Json
# Taken off first, so a failing installer is never started again and again.
Remove-Item -LiteralPath $Pending -Force
Say "Update to $($job.version) asked for (now $($job.from))."

$installer = [string]$job.installer
if (-not $installer.StartsWith($Updates, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $installer)) {
  Fail $job "The installer is not in the updates folder: $installer"
}
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne ([string]$job.sha256).ToLowerInvariant()) {
  Fail $job 'The downloaded installer does not match its checksum; it was not run.'
}

Say "Running $installer /S"
$p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Say "Installer finished with code $($p.ExitCode)."
if ($p.ExitCode -ne 0) {
  $result = Join-Path $Updates 'last-result.json'
  # setup.ps1 writes the reason when it got that far; otherwise say what happened here.
  if (-not (Test-Path -LiteralPath $result) -or (Get-Item -LiteralPath $result).LastWriteTime -lt (Get-Date).AddMinutes(-30)) {
    Fail $job "The installer stopped with code $($p.ExitCode). See C:\ProgramData\ArunaPOS\logs."
  }
  exit 1
}
exit 0
