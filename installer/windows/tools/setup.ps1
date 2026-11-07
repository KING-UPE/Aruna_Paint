# Aruna POS: install or update the shop server (run by the installer as Administrator).
#
#   setup.ps1 -InstallDir "C:\Program Files\Aruna POS" -Version 1.2.0
#
# The installer has unpacked the new files to <InstallDir>\staging.
#
# First install: Visual C++ runtime, a PostgreSQL cluster (port 5544, this PC only) run as the
# "ArunaPOS-DB" service, the shop's database with every migration, the server as the
# "ArunaPOS-Server" service on port 3000, a firewall rule for the shop's network, and the
# "Aruna POS Updater" task. The database is left empty: the first-run wizard links the shop to
# the online panel (the owner's account arrives with the first sync) or makes the owner's account.
#
# Update (config.env already there): back up the database, stop the server, swap in the new
# program, take the new migrations, start the server and check it answers with the new version.
# If any step fails, the previous program and the backed-up database go back and the old version
# runs again. The result goes to data\updates\last-result.json for the server to report.
#
# PowerShell 5.1 (every Windows 10 and 11).
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Staging = Join-Path $InstallDir 'staging'
$Base = Join-Path $env:ProgramData 'ArunaPOS'
$DataDir = Join-Path $Base 'data'
$LogDir = Join-Path $Base 'logs'
$PgData = Join-Path $Base 'pgdata'
$BackupDir = Join-Path $DataDir 'backups'
$UpdatesDir = Join-Path $DataDir 'updates'
$Config = Join-Path $Base 'config.env'
$PgPort = 5544
$AppPort = 3000
$DbService = 'ArunaPOS-DB'
$AppService = 'ArunaPOS-Server'
$TaskName = 'Aruna POS Updater'
$FirewallRule = 'ArunaPOS-Screens'

foreach ($d in @($Base, $DataDir, $LogDir, $BackupDir, $UpdatesDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
# The shop's data is for SYSTEM (the services) and Administrators only, not every Windows user.
& icacls.exe $Base /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
$Log = Join-Path $LogDir ("setup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Say([string]$text) {
  $line = "{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  Write-Output $line
  Add-Content -LiteralPath $Log -Value $line
}

function Run([string]$exe, [string[]]$arguments, [hashtable]$envVars = @{}) {
  # Runs a program, logs its output and fails on a non-zero exit code.
  $saved = @{}
  foreach ($k in $envVars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $envVars[$k], 'Process')
  }
  # PowerShell 5.1 turns a program's stderr into errors; only the exit code decides here.
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $eap
    foreach ($k in $envVars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  foreach ($l in $out) { Say "    $l" }
  if ($code -ne 0) {
    # The last real line says why (PowerShell adds RemoteException lines for stderr).
    $why = ($out | Where-Object { $_ -and $_ -notmatch 'RemoteException' } | Select-Object -Last 1)
    throw "$([IO.Path]::GetFileName($exe)) failed (exit code $code): $why"
  }
}

function New-Secret([int]$length) {
  # Letters and digits only: safe in URLs and config lines.
  $chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $bytes = New-Object byte[] $length
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Read-Config {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Config) {
    if ($line -match "^\s*([A-Z_]+)\s*=\s*'?(.*?)'?\s*$") { $values[$Matches[1]] = $Matches[2] }
  }
  $values
}

function Write-Config([hashtable]$values) {
  $order = 'DATABASE_URL', 'ADMIN_DATABASE_URL', 'PIN_SECRET', 'APP_MODE', 'PORT', 'HOST',
    'DATA_DIR', 'PG_BIN_DIR', 'WEB_DIST_DIR', 'ARUNA_INSTALL_DIR', 'NODE_ENV', 'LOG_LEVEL'
  $lines = @('# Aruna POS shop server settings, written by the installer. Keep this file private:',
    '# it holds the database passwords and the PIN secret (losing PIN_SECRET means new PINs).')
  foreach ($k in $order) { if ($values.ContainsKey($k)) { $lines += "$k='$($values[$k])'" } }
  foreach ($k in ($values.Keys | Sort-Object)) {
    if ($order -notcontains $k) { $lines += "$k='$($values[$k])'" }
  }
  Set-Content -LiteralPath $Config -Value $lines -Encoding ASCII
  # Only SYSTEM and Administrators may read it.
  & icacls.exe $Config /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
}

function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      $c.Connect('127.0.0.1', $port)
      $c.Close()
      return $true
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function Wait-Health([string]$expectVersion, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $last = ''
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$AppPort/api/health"
      if ($r.ok -and ($r.version -eq $expectVersion)) { return }
      $last = "answered with version $($r.version)"
    } catch { $last = $_.Exception.Message }
    Start-Sleep -Seconds 2
  }
  throw "The server did not answer as version $expectVersion ($last)."
}

function Parse-DbUrl([string]$url) {
  $u = [Uri]$url
  $userInfo = $u.UserInfo.Split(':')
  @{
    User = [Uri]::UnescapeDataString($userInfo[0])
    Password = [Uri]::UnescapeDataString($userInfo[1])
    Host = $u.Host
    Port = $u.Port
    Database = $u.AbsolutePath.TrimStart('/')
  }
}

function Install-VcRuntime {
  $key = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
  $have = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($have -and $have.Installed -eq 1 -and [int]$have.Major -ge 14 -and [int]$have.Minor -ge 30) {
    Say 'Visual C++ runtime: already there.'
    return
  }
  Say 'Installing the Microsoft Visual C++ runtime...'
  $p = Start-Process -FilePath (Join-Path $Staging 'redist\vc_redist.x64.exe') `
    -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  # 3010: done, restart later; 1638: a newer one is installed.
  if (@(0, 3010, 1638) -notcontains $p.ExitCode) { throw "Visual C++ runtime setup failed ($($p.ExitCode))." }
}

function Write-ServiceXml {
  $xml = @"
<service>
  <id>$AppService</id>
  <name>Aruna POS Server</name>
  <description>Pannala Aruna Paint Center POS: the shop server every PC's screens use.</description>
  <executable>$InstallDir\node\node.exe</executable>
  <arguments>--env-file="$Config" "$InstallDir\app\server.mjs"</arguments>
  <workingdirectory>$InstallDir\app</workingdirectory>
  <startmode>Automatic</startmode>
  <depend>$DbService</depend>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <logpath>$LogDir</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
  Set-Content -LiteralPath (Join-Path $InstallDir 'service\ArunaPOS-Server.xml') -Value $xml -Encoding UTF8
}

function Register-Updater {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $ps `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\tools\updater.ps1`""
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  # No trigger: the server starts it (schtasks /Run) when an update is ready.
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
    -Settings $settings -Force | Out-Null
}

function Set-Firewall {
  & netsh.exe advfirewall firewall delete rule name="$FirewallRule" | Out-Null
  Run 'netsh.exe' @('advfirewall', 'firewall', 'add', 'rule', "name=$FirewallRule", 'dir=in',
    'action=allow', 'protocol=TCP', "localport=$AppPort", 'remoteip=localsubnet', 'profile=any')
}

function Move-Part([string]$name) {
  $from = Join-Path $Staging $name
  $to = Join-Path $InstallDir $name
  if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
  Move-Item -LiteralPath $from -Destination $to
}

function Pg([string]$exe) { Join-Path $InstallDir "pgsql\bin\$exe" }

function Write-Result([bool]$ok, [string]$from, [string]$message) {
  $r = [ordered]@{ version = $Version; from = $from; ok = $ok; message = $message; at = (Get-Date).ToUniversalTime().ToString('o') }
  ($r | ConvertTo-Json -Compress) | Set-Content -LiteralPath (Join-Path $UpdatesDir 'last-result.json') -Encoding UTF8
}

# ---------------------------------------------------------------------------------------------

function Install-Fresh {
  Say "Installing Aruna POS $Version in $InstallDir"
  Install-VcRuntime

  foreach ($part in 'node', 'pgsql', 'app', 'service', 'tools', 'redist') { Move-Part $part }

  $me = $null
  $reuse = (Test-Path -LiteralPath $Config) -and (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))
  if ($reuse) {
    # Uninstalled earlier with the data kept: the same database and settings come back.
    Say "Reusing the shop's data kept in $Base"
    $cfg = Read-Config
    $cfg['PG_BIN_DIR'] = "$InstallDir\pgsql\bin"
    $cfg['WEB_DIST_DIR'] = "$InstallDir\app\web"
    $cfg['ARUNA_INSTALL_DIR'] = $InstallDir
    $cfg['DATA_DIR'] = $DataDir
    Write-Config $cfg
  } else {
    if (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION')) {
      throw "An old database is in $PgData without its settings file. Move that folder away (it holds an earlier shop's data) and run the installer again."
    }
    $pgPassword = New-Secret 32
    $appPassword = New-Secret 32
    $cfg = @{
      DATABASE_URL = "postgresql://aruna:$appPassword@127.0.0.1:$PgPort/aruna_pos?schema=public"
      ADMIN_DATABASE_URL = "postgresql://postgres:$pgPassword@127.0.0.1:$PgPort/postgres"
      # All shops and the online panel share one PIN secret, so PINs set online work. The
      # installer takes it from /PINSECRET= (ARUNA_PIN_SECRET), else makes one.
      PIN_SECRET = $(if ($env:ARUNA_PIN_SECRET) { $env:ARUNA_PIN_SECRET } else { New-Secret 48 })
      APP_MODE = 'shop'
      PORT = "$AppPort"
      HOST = '0.0.0.0'
      DATA_DIR = $DataDir
      PG_BIN_DIR = "$InstallDir\pgsql\bin"
      WEB_DIST_DIR = "$InstallDir\app\web"
      ARUNA_INSTALL_DIR = $InstallDir
      NODE_ENV = 'production'
      LOG_LEVEL = 'info'
    }
    Write-Config $cfg

    Say 'Making the database cluster...'
    if (Test-Path -LiteralPath $PgData) { Remove-Item -LiteralPath $PgData -Recurse -Force }
    # initdb drops administrator rights while it runs (PostgreSQL refuses them), so the folder
    # must be open to this Windows account itself, and to NetworkService that runs the database.
    New-Item -ItemType Directory -Force -Path $PgData | Out-Null
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Run 'icacls.exe' @($PgData, '/grant', "*$($me):(OI)(CI)F", '*S-1-5-20:(OI)(CI)F', '/Q')
    Run 'icacls.exe' @($Base, '/grant', "*$($me):(RX)", '*S-1-5-20:(RX)', '/Q')
    $pwFile = Join-Path $env:TEMP ("aruna-pg-{0}.txt" -f (New-Secret 8))
    Set-Content -LiteralPath $pwFile -Value $pgPassword -Encoding ASCII -NoNewline
    try {
      Run (Pg 'initdb.exe') @('-D', $PgData, '-U', 'postgres', "--pwfile=$pwFile", '-E', 'UTF8',
        '--no-locale', '--auth=scram-sha-256')
    } finally { Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue }
    Add-Content -LiteralPath (Join-Path $PgData 'postgresql.conf') -Value @(
      '', '# Aruna POS', "listen_addresses = 'localhost'", "port = $PgPort", "timezone = 'Asia/Colombo'")
  }
  # The database service runs as NetworkService, which needs the data folder; the installing
  # account's own access is taken off again.
  Run 'icacls.exe' @($PgData, '/grant', '*S-1-5-20:(OI)(CI)F', '/T', '/Q')
  if ($me) {
    & icacls.exe $PgData /remove:g "*$me" /T /Q | Out-Null
    & icacls.exe $Base /remove:g "*$me" /Q | Out-Null
  }

  Say 'Starting the database service...'
  if (-not (Get-Service -Name $DbService -ErrorAction SilentlyContinue)) {
    Run (Pg 'pg_ctl.exe') @('register', '-N', $DbService, '-D', $PgData, '-S', 'auto', '-w')
  }
  Start-Service -Name $DbService
  if (-not (Wait-Port $PgPort 60)) { throw 'The database did not start.' }

  Say 'Making the shop database (empty: the first-run wizard sets up the owner)...'
  Run "$InstallDir\node\node.exe" @("--env-file=$Config", "$InstallDir\app\migrate.mjs", '--create')

  Say 'Starting the server service...'
  Write-ServiceXml
  if (-not (Get-Service -Name $AppService -ErrorAction SilentlyContinue)) {
    Run "$InstallDir\service\ArunaPOS-Server.exe" @('install')
  }
  Start-Service -Name $AppService
  Set-Firewall
  Register-Updater
  Wait-Health $Version 120
  Say "Aruna POS $Version is running: http://localhost:$AppPort"
}

function Update-Existing {
  $cfg = Read-Config
  $from = '?'
  try {
    $from = (Get-Content -LiteralPath (Join-Path $InstallDir 'tools\version.txt') -ErrorAction Stop).Trim()
  } catch { }
  Say "Updating Aruna POS $from to $Version"
  Install-VcRuntime

  # Settings added by newer versions keep their old values otherwise.
  $cfg['PG_BIN_DIR'] = "$InstallDir\pgsql\bin"
  $cfg['WEB_DIST_DIR'] = "$InstallDir\app\web"
  $cfg['ARUNA_INSTALL_DIR'] = $InstallDir
  $cfg['DATA_DIR'] = $DataDir
  Write-Config $cfg

  $db = Parse-DbUrl $cfg['DATABASE_URL']
  $admin = Parse-DbUrl $cfg['ADMIN_DATABASE_URL']
  if ((Get-Service -Name $DbService).Status -ne 'Running') { Start-Service -Name $DbService }
  if (-not (Wait-Port $PgPort 60)) { throw 'The database is not running, so no backup could be made. Nothing was changed.' }

  # 1. Backup, while the old version still runs (nothing is changed yet if this fails).
  $dump = Join-Path $BackupDir ("before-update-{0}-to-{1}-{2}.dump" -f $from, $Version, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Say "Backing up the database to $dump"
  Run (Pg 'pg_dump.exe') @('-h', '127.0.0.1', '-p', "$($db.Port)", '-U', $db.User, '-Fc', '-f', $dump, $db.Database) @{ PGPASSWORD = $db.Password }

  # 2. Swap the program while the server is stopped.
  $parts = 'node', 'app', 'service', 'tools', 'redist'
  $swapPg = $false
  $oldPg = (Get-Content -LiteralPath (Join-Path $PgData 'PG_VERSION')).Trim()
  $newPgVersion = (& (Join-Path $Staging 'pgsql\bin\pg_ctl.exe') --version) -replace '[^0-9.]', ''
  if ($newPgVersion.Split('.')[0] -eq $oldPg) { $swapPg = $true } else {
    Say "PostgreSQL $newPgVersion is a different major version than the data ($oldPg): keeping the current PostgreSQL."
  }
  $migrated = $false
  try {
    Say 'Stopping the server...'
    Stop-Service -Name $AppService -Force -ErrorAction SilentlyContinue
    (Get-Service -Name $AppService).WaitForStatus('Stopped', (New-TimeSpan -Seconds 60))
    foreach ($p in $parts) {
      $cur = Join-Path $InstallDir $p
      $prev = "$cur.prev"
      if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Recurse -Force }
      if (Test-Path -LiteralPath $cur) { Move-Item -LiteralPath $cur -Destination $prev }
      Move-Item -LiteralPath (Join-Path $Staging $p) -Destination $cur
    }
    if ($swapPg) {
      Say 'Updating PostgreSQL (same major version)...'
      Stop-Service -Name $DbService -Force
      (Get-Service -Name $DbService).WaitForStatus('Stopped', (New-TimeSpan -Seconds 60))
      $cur = Join-Path $InstallDir 'pgsql'
      if (Test-Path -LiteralPath "$cur.prev") { Remove-Item -LiteralPath "$cur.prev" -Recurse -Force }
      Move-Item -LiteralPath $cur -Destination "$cur.prev"
      Move-Item -LiteralPath (Join-Path $Staging 'pgsql') -Destination $cur
      Start-Service -Name $DbService
      if (-not (Wait-Port $PgPort 60)) { throw 'The database did not start after the update.' }
    }

    # 3. New migrations (the backup above is what undoes them).
    Say 'Updating the database...'
    $migrated = $true
    try {
      Run "$InstallDir\node\node.exe" @("--env-file=$Config", "$InstallDir\app\migrate.mjs")
    } catch {
      throw "The database change in this update failed: $($_.Exception.Message -replace '^node\.exe failed \(exit code \d+\): ', '')"
    }

    # 4. Start and check it answers as the new version.
    Write-ServiceXml
    Register-Updater
    Set-Firewall
    Say 'Starting the server...'
    try { Start-Service -Name $AppService } catch { throw "The new version's server did not start." }
    Wait-Health $Version 120
  } catch {
    $why = $_.Exception.Message
    Say "UPDATE FAILED: $why"
    # Written before the old version starts again, so that start reports it (audit log, alert).
    Write-Result $false $from $why
    Say 'Putting the previous version back...'
    try {
      Stop-Service -Name $AppService -Force -ErrorAction SilentlyContinue
      foreach ($p in $parts + @('pgsql')) {
        $cur = Join-Path $InstallDir $p
        if (Test-Path -LiteralPath "$cur.prev") {
          if ($p -eq 'pgsql') {
            Stop-Service -Name $DbService -Force -ErrorAction SilentlyContinue
            (Get-Service -Name $DbService).WaitForStatus('Stopped', (New-TimeSpan -Seconds 60))
          }
          if (Test-Path -LiteralPath $cur) { Remove-Item -LiteralPath $cur -Recurse -Force }
          Move-Item -LiteralPath "$cur.prev" -Destination $cur
        }
      }
      if ((Get-Service -Name $DbService).Status -ne 'Running') { Start-Service -Name $DbService }
      [void](Wait-Port $PgPort 60)
      if ($migrated) {
        Say 'Restoring the database from the backup...'
        $q = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$($db.Database)' AND pid <> pg_backend_pid()"
        $env:PGPASSWORD = $admin.Password
        & (Pg 'psql.exe') -h 127.0.0.1 -p $admin.Port -U $admin.User -d postgres -v ON_ERROR_STOP=1 -c $q | Out-Null
        Run (Pg 'psql.exe') @('-h', '127.0.0.1', '-p', "$($admin.Port)", '-U', $admin.User, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "DROP DATABASE IF EXISTS `"$($db.Database)`"") @{ PGPASSWORD = $admin.Password }
        Run (Pg 'psql.exe') @('-h', '127.0.0.1', '-p', "$($admin.Port)", '-U', $admin.User, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE DATABASE `"$($db.Database)`" OWNER `"$($db.User)`" ENCODING 'UTF8' TEMPLATE template0") @{ PGPASSWORD = $admin.Password }
        Run (Pg 'pg_restore.exe') @('-h', '127.0.0.1', '-p', "$($db.Port)", '-U', $db.User, '-d', $db.Database, '--no-owner', $dump) @{ PGPASSWORD = $db.Password }
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
      }
      Start-Service -Name $AppService
      Say 'The previous version is running again.'
    } catch {
      Say "Putting the previous version back also failed: $($_.Exception.Message). The backup is $dump"
      Write-Result $false $from "$why Putting the previous version back also failed: $($_.Exception.Message). The backup is $dump"
    }
    throw
  }
  foreach ($p in $parts + @('pgsql')) {
    $prev = Join-Path $InstallDir "$p.prev"
    if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Result $true $from "Updated from $from to $Version."
  Say "Aruna POS $Version is running."
}

try {
  if ((Test-Path -LiteralPath $Config) -and (Test-Path -LiteralPath (Join-Path $InstallDir 'app\server.mjs'))) {
    Update-Existing
  } else {
    Install-Fresh
  }
  exit 0
} catch {
  Say "ERROR: $($_.Exception.Message)"
  Say "Log: $Log"
  exit 1
}
