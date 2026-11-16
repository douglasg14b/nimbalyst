<#
.SYNOPSIS
  Install the fork's Nimbalyst build over the existing per-user install. See FORK.md.

.DESCRIPTION
  Run from a normal PowerShell window, never from inside Nimbalyst:

    powershell -ExecutionPolicy Bypass -File scripts\fork\install.ps1

  1. Refuses to run while any Nimbalyst process is running (it lists them; it
     never stops them).
  2. Refuses a downgrade: the installed version and the data's lastKnownVersion
     must not be newer than the fork's upstream version.
  3. Backs up %APPDATA%\@nimbalyst\electron to a timestamped folder outside
     %APPDATA%\@nimbalyst, skipping only regenerable Chromium caches. The data
     folder is only read, never changed.
  4. Records the installed version and exe path, and keeps a copy of the cached
     official installer when one matching the installed version exists.
  5. Runs the fork's NSIS installer (silent, per-user), which upgrades the
     existing install in place, the same way an official update does.
  6. Verifies the installed exe, the fork marker, the bundled app-update.yml,
     and that the data folder was not touched.

.PARAMETER Installer
  Path to the fork installer. Defaults to the last build recorded by
  scripts/fork/build-win.ps1, whose SHA-256 is checked.

.PARAMETER BackupRoot
  Where the timestamped backup folder is created. Default: %USERPROFILE%\NimbalystBackups.

.PARAMETER Interactive
  Run the installer with its normal UI instead of silently.

.PARAMETER BackupOnly
  Take and verify the backup, then stop without installing.

.PARAMETER IgnoreEnvOverrides
  Continue even if a data-redirecting environment variable is set at User or
  Machine scope.

.PARAMETER DryRun
  Read-only rehearsal: run every check and report what would happen, without
  stopping at a running Nimbalyst, copying anything, or installing.
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [string]$BackupRoot = (Join-Path $env:USERPROFILE 'NimbalystBackups'),
  [switch]$Interactive,
  [switch]$BackupOnly,
  [switch]$IgnoreEnvOverrides,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Stop-Install([string]$Message) { Write-Host "`nSTOPPED: $Message" -ForegroundColor Red; exit 1 }
# In a dry run a failed check is reported and the rehearsal continues.
$script:DryRunFindings = @()
function Stop-Check([string]$Message) {
  if ($DryRun) {
    Write-Host "  WOULD STOP: $Message" -ForegroundColor Yellow
    $script:DryRunFindings += $Message
  } else {
    Stop-Install $Message
  }
}
function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}
function Format-Size([double]$Bytes) { '{0:N2} GB' -f ($Bytes / 1GB) }

function ConvertTo-PlainVersion([string]$Value) {
  # "0.83.0.0" -> 0.83.0 ; "0.83.0+fork" -> 0.83.0
  if ($Value -notmatch '^(\d+)\.(\d+)\.(\d+)') { return $null }
  return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $env:APPDATA '@nimbalyst\electron'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Nimbalyst'
$InstalledExe = Join-Path $InstallDir 'Nimbalyst.exe'
$UpdaterCache = Join-Path $env:LOCALAPPDATA '@nimbalystelectron-updater'
$CacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'DawnCache')

# --- 1. Nimbalyst must not be running ----------------------------------------
Write-Step 'Checking that Nimbalyst is not running'
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq 'Nimbalyst' -or ($_.Path -and $_.Path -like "$InstallDir\*")
  })
if ($running.Count -gt 0) {
  Write-Host 'These Nimbalyst processes are running:' -ForegroundColor Yellow
  $running | Sort-Object Id | Format-Table Id, ProcessName, Path -AutoSize | Out-String | Write-Host
  Stop-Check 'Quit Nimbalyst (File > Quit, and check the system tray), then run this script again. Nothing was changed.'
} else {
  Write-Host '  No Nimbalyst process is running.'
}

# --- Persistent overrides that would point the app at other data -------------
Write-Step 'Checking for data-redirecting environment variables'
$overrideNames = @('NIMBALYST_USER_DATA_DIR', 'NIMBALYST_USER_DATA_PATH', 'RUN_ONE_DEV_MODE', 'PLAYWRIGHT', 'ELECTRON_RUN_AS_NODE')
$overrides = foreach ($scope in 'User', 'Machine', 'Process') {
  foreach ($name in $overrideNames) {
    $value = [Environment]::GetEnvironmentVariable($name, $scope)
    if ($value) { [pscustomobject]@{ Scope = $scope; Name = $name; Value = $value } }
  }
}
if ($overrides) {
  $overrides | Format-Table -AutoSize | Out-String | Write-Host
  if (-not $IgnoreEnvOverrides) {
    Stop-Check 'these variables make Nimbalyst use different data or behave as a test build. Remove them, or pass -IgnoreEnvOverrides.'
  }
  Write-Warning 'Continuing with the overrides above (-IgnoreEnvOverrides).'
} else {
  Write-Host '  None set.'
}

# --- The fork installer ------------------------------------------------------
Write-Step 'Locating the fork installer'
$lastBuildPath = Join-Path $RepoRoot 'nimbalyst-local\fork-build\last-build.json'
$lastBuild = $null
if (Test-Path $lastBuildPath) { $lastBuild = Get-Content $lastBuildPath -Raw | ConvertFrom-Json }
$installerHash = $null
$forkCommit = '(unknown)'
$forkVersion = $null
if (-not $Installer -and $lastBuild) { $Installer = $lastBuild.installer }
if (-not $Installer) {
  Stop-Check "no -Installer given and no $lastBuildPath. Run scripts\fork\build-win.ps1 first."
} elseif (-not (Test-Path $Installer)) {
  Stop-Check "installer not found: $Installer"
} else {
  $Installer = (Resolve-Path $Installer).Path
  $installerHash = (Get-FileHash $Installer -Algorithm SHA256).Hash
  if (-not $lastBuild -or $lastBuild.installer -ne $Installer) {
    Stop-Check 'the installer is not the one recorded by scripts\fork\build-win.ps1, so its fork version is unknown. Rebuild, or point -Installer at the recorded file.'
  } elseif ($lastBuild.sha256 -ne $installerHash) {
    Stop-Check "installer SHA-256 $installerHash does not match the build record $($lastBuild.sha256). Rebuild it."
  } else {
    $forkCommit = $lastBuild.commit
    $forkVersion = ConvertTo-PlainVersion $lastBuild.upstreamVersion
  }
}
if (-not $forkVersion) {
  # Dry run without a usable build record: compare against the checkout's version.
  $forkVersion = ConvertTo-PlainVersion ((Get-Content (Join-Path $RepoRoot 'packages\electron\package.json') -Raw | ConvertFrom-Json).version)
}
Write-Host "  Installer: $Installer"
Write-Host "  SHA-256:   $installerHash"
Write-Host "  Fork commit $forkCommit, upstream version $forkVersion"

# --- Current install, for the record and for rollback ------------------------
Write-Step 'Recording the current install'
if (-not (Test-Path $InstalledExe)) { Stop-Install "no Nimbalyst install at $InstalledExe" }
$installedProductVersion = (Get-Item $InstalledExe).VersionInfo.ProductVersion
$installedVersion = ConvertTo-PlainVersion $installedProductVersion
$installedMarkerPath = Join-Path $InstallDir 'resources\fork-build.json'
$installedMarker = $null
if (Test-Path $installedMarkerPath) { $installedMarker = Get-Content $installedMarkerPath -Raw | ConvertFrom-Json }
$installedSignature = Get-AuthenticodeSignature $InstalledExe
$installedSigner = if ($installedSignature.SignerCertificate) { $installedSignature.SignerCertificate.Subject } else { '(unsigned)' }
$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  Where-Object { "$(Get-Prop (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue) 'DisplayName')" -like 'Nimbalyst*' } |
  Select-Object -First 1
$uninstallInfo = if ($uninstallKey) { Get-ItemProperty $uninstallKey.PSPath } else { $null }

Write-Host "  Exe:       $InstalledExe"
Write-Host "  Version:   $installedProductVersion"
Write-Host "  Signer:    $installedSigner"
if ($installedMarker) { Write-Host "  Fork build: commit $(Get-Prop $installedMarker 'commit')" } else { Write-Host '  Fork build: no (official build)' }
if ($uninstallInfo) {
  Write-Host "  Registered: $(Get-Prop $uninstallInfo 'DisplayName') $(Get-Prop $uninstallInfo 'DisplayVersion') at $(Get-Prop $uninstallInfo 'InstallLocation')"
  Write-Host "  Uninstall key: $($uninstallKey.Name)"
} else {
  Write-Warning 'No Nimbalyst entry under HKCU Uninstall; the installer may not treat this as an upgrade.'
}

# --- No downgrades -----------------------------------------------------------
Write-Step 'Checking versions'
$lastKnownVersion = $null
$appSettingsPath = Join-Path $DataDir 'app-settings.json'
if (Test-Path $appSettingsPath) {
  $lastKnownVersion = ConvertTo-PlainVersion "$(Get-Prop (Get-Content $appSettingsPath -Raw | ConvertFrom-Json) 'lastKnownVersion')"
}
Write-Host "  Installed $installedVersion, data last opened by $lastKnownVersion, fork $forkVersion"
if ($installedVersion -and $installedVersion -gt $forkVersion) {
  Stop-Check "the installed Nimbalyst ($installedVersion) is newer than the fork ($forkVersion). Merge that release into fork/main and rebuild first; installing would be a downgrade."
}
if ($lastKnownVersion -and $lastKnownVersion -gt $forkVersion) {
  Stop-Check "your data was last opened by Nimbalyst $lastKnownVersion, newer than the fork ($forkVersion). Merge that release into fork/main and rebuild first."
}
$pendingInfoPath = Join-Path $UpdaterCache 'pending\update-info.json'
if (Test-Path $pendingInfoPath) {
  $pending = Get-Content $pendingInfoPath -Raw | ConvertFrom-Json
  Write-Host "  Official updater cache holds $(Get-Prop $pending 'fileName'). The fork never reads it."
}

# --- Backup ------------------------------------------------------------------
Write-Step 'Backing up your Nimbalyst data'
if (-not (Test-Path $DataDir)) { Stop-Install "data folder not found: $DataDir" }
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
$nimbalystAppData = [IO.Path]::GetFullPath((Join-Path $env:APPDATA '@nimbalyst'))
if ($BackupRoot.StartsWith($nimbalystAppData, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Install "the backup must live outside $nimbalystAppData"
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $BackupRoot "nimbalyst-$stamp"
$BackupData = Join-Path $BackupDir 'electron'

function Test-IsCachePath([string]$RelativePath) {
  $top = ($RelativePath -split '[\\/]', 2)[0]
  return ($CacheDirs -contains $top) -or ($top -like 'Dawn*')
}

$sourceFiles = @(Get-ChildItem -LiteralPath $DataDir -Recurse -Force -File | Where-Object {
    -not (Test-IsCachePath $_.FullName.Substring($DataDir.Length + 1))
  })
$sourceBytes = ($sourceFiles | Measure-Object Length -Sum).Sum
$drive = [IO.Path]::GetPathRoot($BackupRoot)
$free = (Get-PSDrive -Name $drive.Substring(0, 1)).Free
Write-Host "  Source:  $DataDir"
Write-Host "  Size:    $(Format-Size $sourceBytes) in $($sourceFiles.Count) files (excluding regenerable caches)"
Write-Host "  Target:  $BackupData"
Write-Host "  Free on $drive $(Format-Size $free)"
if ($free -lt ($sourceBytes * 1.1 + 2GB)) { Stop-Check 'not enough free disk space for the backup' }

if ($DryRun) {
  Write-Host "`nDRY RUN complete. Nothing was copied, installed or changed." -ForegroundColor Green
  if ($script:DryRunFindings.Count) {
    Write-Host 'A real run would stop on:' -ForegroundColor Yellow
    $script:DryRunFindings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
  } else {
    Write-Host 'A real run would continue to the backup and install.'
  }
  exit 0
}

New-Item -ItemType Directory -Force $BackupData | Out-Null
# Exclude only the top-level cache folders, by full path; a bare name would also
# exclude same-named folders at any depth (e.g. "Shared Dictionary\cache") and
# break the file-count check below.
$excludeDirs = @(Get-ChildItem -LiteralPath $DataDir -Directory -Force | Where-Object {
    ($CacheDirs -contains $_.Name) -or ($_.Name -like 'Dawn*')
  } | ForEach-Object { $_.FullName })
# robocopy only reads the source. /E all subfolders, /COPY:DAT data+attributes+timestamps,
# /DCOPY:T folder timestamps, /XJ skip junctions, /R:2 /W:2 short retries.
$robocopyArgs = @($DataDir, $BackupData, '/E', '/COPY:DAT', '/DCOPY:T', '/XJ', '/R:2', '/W:2', '/NP', '/NFL', '/NDL')
if ($excludeDirs.Count) { $robocopyArgs += @('/XD') + $excludeDirs }
& robocopy @robocopyArgs | Out-Host
if ($LASTEXITCODE -ge 8) { Stop-Install "robocopy failed with exit code $LASTEXITCODE. The install did not run." }

$backupFiles = @(Get-ChildItem -LiteralPath $BackupData -Recurse -Force -File)
$backupBytes = ($backupFiles | Measure-Object Length -Sum).Sum
if ($backupFiles.Count -ne $sourceFiles.Count -or $backupBytes -ne $sourceBytes) {
  Stop-Install "backup does not match the source ($($backupFiles.Count) files / $backupBytes bytes vs $($sourceFiles.Count) / $sourceBytes). The install did not run."
}
foreach ($critical in @('sqlite-db', 'app-settings.json', 'ai-settings.json', 'workspace-settings.json')) {
  $src = Join-Path $DataDir $critical
  if ((Test-Path $src) -and -not (Test-Path (Join-Path $BackupData $critical))) { Stop-Install "backup is missing $critical" }
}
Get-ChildItem -LiteralPath $DataDir -Filter '*.enc' -File | ForEach-Object {
  if (-not (Test-Path (Join-Path $BackupData $_.Name))) { Stop-Install "backup is missing $($_.Name)" }
}
Write-Host "  Backup verified: $($backupFiles.Count) files, $(Format-Size $backupBytes)." -ForegroundColor Green

# Rollback material: the cached official installer (if it matches what is
# installed), the registry entries the installer owns, and a record.
$rollbackInstaller = $null
$cachedInstaller = Join-Path $UpdaterCache 'installer.exe'
if ((-not $installedMarker) -and (Test-Path $cachedInstaller)) {
  $cachedSig = Get-AuthenticodeSignature $cachedInstaller
  $cachedVersion = ConvertTo-PlainVersion (Get-Item $cachedInstaller).VersionInfo.ProductVersion
  if ($cachedSig.Status -eq 'Valid' -and $cachedSig.SignerCertificate.Subject -like '*NIMBALYST, INC.*' -and $cachedVersion -eq $installedVersion) {
    $rollbackInstaller = Join-Path $BackupDir "Nimbalyst-$installedVersion-official-installer.exe"
    Copy-Item -LiteralPath $cachedInstaller -Destination $rollbackInstaller
    Write-Host "  Kept the signed official $installedVersion installer: $rollbackInstaller"
  }
}
& reg export 'HKCU\Software\Classes\nimbalyst' (Join-Path $BackupDir 'protocol-nimbalyst.reg') /y | Out-Null
if ($uninstallKey) {
  & reg export ($uninstallKey.Name) (Join-Path $BackupDir 'uninstall-entry.reg') /y | Out-Null
}
$rollbackRecord = [ordered]@{
  takenAt             = (Get-Date).ToString('o')
  dataDir             = $DataDir
  backupData          = $BackupData
  installedExe        = $InstalledExe
  installedVersion    = $installedProductVersion
  installedSigner     = $installedSigner
  installedForkCommit = if ($installedMarker) { $installedMarker.commit } else { $null }
  officialInstaller   = $rollbackInstaller
  forkInstaller       = $Installer
  forkInstallerSha256 = $installerHash
  forkCommit          = $lastBuild.commit
}
$rollbackRecord | ConvertTo-Json | Set-Content (Join-Path $BackupDir 'rollback-info.json') -Encoding utf8
Write-Host "  Rollback record: $(Join-Path $BackupDir 'rollback-info.json')"

if ($BackupOnly) {
  Write-Host "`nBackup complete (-BackupOnly). Nothing was installed." -ForegroundColor Green
  exit 0
}

# --- Install -----------------------------------------------------------------
# Snapshot the files the app owns, to prove afterwards the installer left them alone.
$dataSnapshot = @{}
foreach ($f in $sourceFiles) { $dataSnapshot[$f.FullName] = "$($f.Length)|$($f.LastWriteTimeUtc.Ticks)" }

Write-Step 'Running the fork installer'
# /S silent, /currentuser keeps the existing per-user scope (it is also what
# the installer picks for an existing per-user install). The installer runs
# the old uninstaller with /KEEP_APP_DATA, as an official update does.
$installerArgs = if ($Interactive) { @() } else { @('/S', '/currentuser') }
$proc = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  Stop-Install "the installer exited with code $($proc.ExitCode). Your data is untouched and backed up at $BackupData. See the rollback steps in FORK.md."
}

# --- Verify ------------------------------------------------------------------
Write-Step 'Verifying the installed build'
$problems = @()
if (-not (Test-Path $InstalledExe)) { $problems += "no exe at $InstalledExe" }
$newProductVersion = (Get-Item $InstalledExe).VersionInfo.ProductVersion
if ((ConvertTo-PlainVersion $newProductVersion) -ne $forkVersion) { $problems += "installed version $newProductVersion, expected $forkVersion" }
if (-not (Test-Path $installedMarkerPath)) {
  $problems += "fork marker missing at $installedMarkerPath"
} else {
  $newMarker = Get-Content $installedMarkerPath -Raw | ConvertFrom-Json
  if ($newMarker.commit -ne $lastBuild.commit) { $problems += "installed fork commit $($newMarker.commit), expected $($lastBuild.commit)" }
}
$appUpdatePath = Join-Path $InstallDir 'resources\app-update.yml'
if ((Test-Path $appUpdatePath) -and ((Get-Content $appUpdatePath -Raw) -match '(?m)^owner:\s*nimbalyst\s*$')) {
  $problems += 'resources\app-update.yml still names the official nimbalyst feed'
}
$asar = Join-Path $InstallDir 'resources\app.asar'
$asarHasCommit = [IO.File]::ReadAllText($asar, [Text.Encoding]::ASCII).Contains($lastBuild.commit)
if (-not $asarHasCommit) { $problems += 'app.asar does not carry the fork build flag' }

$changed = @()
foreach ($path in $dataSnapshot.Keys) {
  if (-not (Test-Path -LiteralPath $path)) { $changed += "missing: $path"; continue }
  $f = Get-Item -LiteralPath $path -Force
  if ("$($f.Length)|$($f.LastWriteTimeUtc.Ticks)" -ne $dataSnapshot[$path]) { $changed += "changed: $path" }
}
if ($changed) { $problems += "the installer changed $($changed.Count) data file(s): $($changed | Select-Object -First 5)" }

if ($problems) {
  Write-Host "`nINSTALL VERIFICATION FAILED:" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host "`nYour data is backed up at $BackupData. Rollback steps are in FORK.md."
  exit 1
}

Write-Host "`nFork build installed and verified." -ForegroundColor Green
Write-Host "  $InstalledExe $newProductVersion, fork commit $($lastBuild.commit)"
Write-Host "  The official updater is disabled in this build, and app-update.yml no longer names the official feed."
Write-Host "  Data folder untouched: $($dataSnapshot.Count) files unchanged."
Write-Host "  Backup: $BackupDir"
Write-Host @"

Next: start Nimbalyst from the Start menu and check
  - your projects and recent sessions are listed and open
  - you are still signed in, and sync shows connected (if you use it)
  - Settings > Advanced shows "Fork build" with commit $($lastBuild.commit)
  - Help > Check for Updates... says updates come from the fork's scripts

Rollback (back to the official release):
  1. Quit Nimbalyst.
  2. Run the official installer for $installedProductVersion$(if ($rollbackInstaller) { ":`n       $rollbackInstaller" } else { " from https://github.com/nimbalyst/nimbalyst/releases" })
     It upgrades in place over the fork, the same way, and keeps your data.
  3. Your data does not need restoring: the fork build reads and writes it in the
     same format as $forkVersion. Restore $BackupData only if something is missing,
     by copying it back over $DataDir with Nimbalyst closed.
"@
