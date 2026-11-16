<#
.SYNOPSIS
  Boot the freshly built fork app on an EMPTY scratch profile and check its
  startup log. See FORK.md.

.DESCRIPTION
  Never uses your real data: NIMBALYST_USER_DATA_DIR points at a new, empty
  folder under %LOCALAPPDATA%\NimbalystForkBuild, which also lets this run
  beside a running Nimbalyst (the variable skips the single-instance lock).

  A packaged launch re-registers the nimbalyst:// protocol to the test exe, so
  the script exports HKCU\Software\Classes\nimbalyst first and re-imports it
  afterwards, then checks the handler points where it did before.

  It closes only processes whose executable is the test build's Nimbalyst.exe,
  never anything from the installed app.

  Checks: the app reaches "App ready"; the log shows the inert-updater line
  with the expected fork commit; no "Checking for update" line; the SQLite
  database initialises.
#>
[CmdletBinding()]
param(
  [string]$OutputDir = (Join-Path $env:LOCALAPPDATA 'NimbalystForkBuild\release'),
  [int]$BootTimeoutSeconds = 120,
  [int]$IdleSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = [IO.Path]::GetFullPath((Join-Path $OutputDir 'win-unpacked\Nimbalyst.exe'))
if (-not (Test-Path $exe)) { throw "No build at $exe. Run scripts\fork\build-win.ps1 first." }
$lastBuild = Get-Content (Join-Path $RepoRoot 'nimbalyst-local\fork-build\last-build.json') -Raw | ConvertFrom-Json
$liveDataDir = [IO.Path]::GetFullPath((Join-Path $env:APPDATA '@nimbalyst'))

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$scratchRoot = Join-Path $env:LOCALAPPDATA "NimbalystForkBuild\smoke-$stamp"
$scratch = Join-Path $scratchRoot 'userdata'
if ($scratch.StartsWith($liveDataDir, [StringComparison]::OrdinalIgnoreCase)) { throw 'scratch must not be inside the live data folder' }
New-Item -ItemType Directory -Force $scratch | Out-Null

Write-Step 'Saving the nimbalyst:// protocol registration'
$protocolKey = 'HKCU\Software\Classes\nimbalyst'
$protocolBackup = Join-Path $scratchRoot 'protocol-nimbalyst.reg'
$commandPath = 'HKCU:\Software\Classes\nimbalyst\shell\open\command'
$hadProtocol = Test-Path $commandPath
$protocolBefore = if ($hadProtocol) { (Get-Item $commandPath).GetValue('') } else { $null }
if ($hadProtocol) {
  & reg export $protocolKey $protocolBackup /y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'reg export of the protocol key failed; not launching' }
}
Write-Host "  Before: $protocolBefore"

$proc = $null
try {
  Write-Step "Booting the fork build on an empty profile ($scratch)"
  $psi = New-Object Diagnostics.ProcessStartInfo $exe
  $psi.UseShellExecute = $false
  # Start from this process's environment minus anything that changes behaviour.
  foreach ($name in @($psi.EnvironmentVariables.Keys)) {
    if ($name -like 'NIMBALYST_*' -or $name -in @('ELECTRON_RUN_AS_NODE', 'PLAYWRIGHT', 'NODE_ENV', 'OFFICIAL_BUILD', 'RUN_ONE_DEV_MODE', 'ELECTRON_RENDERER_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT')) {
      $psi.EnvironmentVariables.Remove($name)
    }
  }
  $psi.EnvironmentVariables['NIMBALYST_USER_DATA_DIR'] = $scratch
  $psi.EnvironmentVariables['NIMBALYST_DISABLE_ANALYTICS'] = '1'
  $proc = [Diagnostics.Process]::Start($psi)
  $proc.PriorityClass = 'BelowNormal'
  Write-Host "  PID $($proc.Id)"

  $mainLog = Join-Path $scratch 'logs\main.log'
  $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    if ((Test-Path $mainLog) -and (Select-String -Path (Join-Path $scratch 'logs\main*.log') -Pattern 'App ready' -Quiet)) { break }
    Start-Sleep -Seconds 2
  }
  if ($proc.HasExited) { throw "the fork build exited during boot with code $($proc.ExitCode)" }
  if (-not ((Test-Path $mainLog) -and (Select-String -Path (Join-Path $scratch 'logs\main*.log') -Pattern 'App ready' -Quiet))) { throw "no 'App ready' in $mainLog after $BootTimeoutSeconds s" }
  Write-Host "  App ready. Idling $IdleSeconds s (the official updater's first check would fire at 30 s)."
  Start-Sleep -Seconds $IdleSeconds
  if ($proc.HasExited) { throw "the fork build exited while idle with code $($proc.ExitCode)" }
} finally {
  Write-Step 'Closing the test instance'
  $testProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq $exe)
    })
  if ($proc -and -not $proc.HasExited) { [void]$proc.CloseMainWindow() }
  Start-Sleep -Seconds 8
  $testProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq $exe)
    })
  foreach ($p in $testProcs) {
    Write-Host "  stopping test process $($p.Id) ($($p.Path))"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }

  Write-Step 'Restoring the nimbalyst:// protocol registration'
  if ($hadProtocol) {
    & reg import $protocolBackup 2>$null
    $protocolAfter = (Get-Item $commandPath).GetValue('')
    if ($protocolAfter -ne $protocolBefore) {
      Write-Host "  PROTOCOL NOT RESTORED: $protocolAfter (expected $protocolBefore). Re-import $protocolBackup." -ForegroundColor Red
    } else {
      Write-Host "  Restored: $protocolAfter"
    }
  } else {
    Write-Host '  There was no handler before the test; the test exe may now own nimbalyst://. Reinstalling fixes it.' -ForegroundColor Yellow
  }
}

Write-Step 'Checking the startup log'
# electron-log rotates main.log to main.1.log, so read every log file.
$log = (Get-ChildItem (Join-Path $scratch 'logs') -Filter 'main*.log' | Sort-Object Name -Descending | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
$checks = [ordered]@{
  'reached App ready'                           = $log -match 'App ready'
  'inert updater bound, with the fork commit'   = $log.Contains("[fork] Fork build $($lastBuild.commit): the official updater is disabled")
  'no official update check'                    = -not ($log -match 'Checking for update')
  'no official feed configured'                 = -not ($log -match 'channel updates from GitHub')
  'SQLite database initialised'                 = $log -match '\[Database\] Database system ready'
  'nothing logged into the live data folder'    = -not (Select-String -Path (Join-Path $liveDataDir 'electron\logs\main*.log') -SimpleMatch -Pattern "[fork] Fork build $($lastBuild.commit)" -Quiet)
}
$failed = 0
foreach ($k in $checks.Keys) {
  $ok = [bool]$checks[$k]
  if (-not $ok) { $failed++ }
  Write-Host ("  [{0}] {1}" -f ($(if ($ok) { 'ok' } else { 'FAIL' })), $k)
}
Write-Host "`nScratch profile and logs: $scratchRoot"
if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'Smoke test passed.' -ForegroundColor Green
