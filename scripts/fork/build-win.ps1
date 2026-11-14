<#
.SYNOPSIS
  Build the fork's Windows x64 NSIS installer. See FORK.md.

.DESCRIPTION
  Runs the same prebuild steps as .github/workflows/electron-build.yml (Windows
  x64), then `build:win --publish never` with the fork build flag always set,
  OFFICIAL_BUILD unset and signing off. Ends by printing the installer path and
  its SHA-256, and writes nimbalyst-local/fork-build/last-build.json, which
  scripts/fork/install.ps1 reads.

  Re-runnable. Any failing step stops the script with a non-zero exit code, and
  the output is checked for freshness and for the fork marker before it is
  reported, so a stale or half-built installer is never handed on.

.PARAMETER SkipInstall
  Skip `pnpm install --frozen-lockfile`.

.PARAMETER AllowDirty
  Build from a working tree with uncommitted changes. The fork commit is then
  recorded as <sha>-dirty.

.PARAMETER OutputDir
  electron-builder output folder. Default: %LOCALAPPDATA%\NimbalystForkBuild\release.
  It is outside the checkout on purpose: a running Nimbalyst with this repo
  open keeps .asar files under packages\electron\release locked.
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$AllowDirty,
  [string]$OutputDir = (Join-Path $env:LOCALAPPDATA 'NimbalystForkBuild\release')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "`nBUILD FAILED: $Message" -ForegroundColor Red; exit 1 }

function Invoke-Native {
  param([string]$Name, [scriptblock]$Command)
  Write-Step $Name
  & $Command
  if ($LASTEXITCODE -ne 0) { Fail "$Name exited with code $LASTEXITCODE" }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ElectronDir = Join-Path $RepoRoot 'packages\electron'
$OutDir = Join-Path $RepoRoot 'nimbalyst-local\fork-build'
$ReleaseDir = [IO.Path]::GetFullPath($OutputDir)
if ($ReleaseDir.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
  Write-Warning 'OutputDir is inside the checkout; a running Nimbalyst with this repo open can lock files there.'
}
$InstallerPath = Join-Path $ReleaseDir 'Nimbalyst-Windows-x64.exe'
$UnpackedResources = Join-Path $ReleaseDir 'win-unpacked\resources'
$ForkConfig = Join-Path $PSScriptRoot 'electron-builder.fork.cjs'

Set-Location $RepoRoot

# Child processes inherit a BelowNormal priority class, so the whole build
# yields CPU to a running Nimbalyst and its agent sessions.
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'

# --- Preconditions -----------------------------------------------------------
Write-Step 'Checking the checkout and toolchain'
$sha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Fail 'git rev-parse failed; run from the fork checkout' }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
# build:win regenerates the third-party license files under resources/generated
# from the installed tree, so a previous build leaves them modified. They are
# build output, not source, and are left uncommitted (committing them would
# conflict with every upstream release merge).
$dirty = [bool](git status --porcelain --untracked-files=no -- . ':(exclude)packages/electron/resources/generated')
if ($dirty -and -not $AllowDirty) {
  Fail 'the working tree has uncommitted changes. Commit them, or pass -AllowDirty for a throwaway build.'
}
$forkCommit = if ($dirty) { "$sha-dirty" } else { $sha }
if ($branch -ne 'fork/main') {
  Write-Warning "Building from '$branch', not fork/main."
}

$nodeVersion = (node --version).Trim()
if ($LASTEXITCODE -ne 0) { Fail 'node is not on PATH' }
$nodeParsed = [version]($nodeVersion.TrimStart('v'))
if ($nodeParsed.Major -ne 24) { Fail "Node 24 is required (found $nodeVersion)" }
if ($nodeParsed.Minor -ge 19) {
  Write-Warning "Node $nodeVersion: 24.19+ has crashed in native-addon GC on this machine. If the build dies in native code, use 24.18.1."
}
$pnpmVersion = (pnpm --version).Trim()
if ($LASTEXITCODE -ne 0) { Fail 'pnpm is not runnable (corepack enable; see FORK.md)' }

$upstreamVersion = (Get-Content (Join-Path $ElectronDir 'package.json') -Raw | ConvertFrom-Json).version
$baseTag = (git describe --tags --abbrev=0 --match 'v*' HEAD).Trim()

# Fork repo for the bundled app-update.yml, from the origin remote.
$originUrl = (git remote get-url origin).Trim()
if ($originUrl -notmatch 'github\.com[:/]([^/]+)/([^/.]+?)(\.git)?$') { Fail "cannot parse the origin remote '$originUrl'" }
$forkOwner = $Matches[1]
$forkRepo = $Matches[2]
if ($forkOwner -eq 'nimbalyst') { Fail 'origin points at nimbalyst/nimbalyst; fork builds must come from the fork checkout' }

Write-Host "  commit:   $forkCommit ($branch)"
Write-Host "  version:  $upstreamVersion (base tag $baseTag)"
Write-Host "  node:     $nodeVersion, pnpm $pnpmVersion"
Write-Host "  fork:     $forkOwner/$forkRepo"

# --- Environment -------------------------------------------------------------
# This shell may be a child of Nimbalyst or a dev session. Clear every variable
# that would change what gets built or signed, then set the fork's own.
Write-Step 'Preparing the build environment'
$scrub = @(
  'OFFICIAL_BUILD', 'CI', 'ELECTRON_RUN_AS_NODE', 'PLAYWRIGHT', 'RUN_ONE_DEV_MODE',
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'DIGICERT_KEYPAIR_ALIAS', 'SM_HOST', 'SM_API_KEY', 'SM_CLIENT_CERT_FILE', 'SM_CLIENT_CERT_PASSWORD',
  'GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_RENDERER_URL', 'NIMBALYST_EXTERNAL_RENDERER',
  'REQUIRE_NOTARIZE', 'ALLOW_UNSIGNED_WINDOWS_BUILD', 'BUILD_ARCH'
)
foreach ($name in $scrub) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
Get-ChildItem Env: | Where-Object { $_.Name -like 'NIMBALYST_*' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }

$env:NODE_ENV = 'production'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:BUILD_ARCH = 'x64'
$env:NIMBALYST_FORK_BUILD = 'true'
$env:NIMBALYST_FORK_COMMIT = $forkCommit
$env:NIMBALYST_FORK_REPO_OWNER = $forkOwner
$env:NIMBALYST_FORK_REPO_NAME = $forkRepo
$env:NIMBALYST_FORK_OUTPUT_DIR = $ReleaseDir

New-Item -ItemType Directory -Force $OutDir | Out-Null
$markerPath = Join-Path $OutDir 'fork-build.json'
[ordered]@{
  fork            = $true
  commit          = $forkCommit
  branch          = $branch
  upstreamVersion = $upstreamVersion
  baseTag         = $baseTag
  forkRepo        = "$forkOwner/$forkRepo"
  builtAt         = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -Path $markerPath -Encoding ascii
$env:NIMBALYST_FORK_MARKER_FILE = $markerPath

# --- Build -------------------------------------------------------------------
$startedAt = Get-Date

if (-not $SkipInstall) {
  Invoke-Native 'pnpm install --frozen-lockfile' { pnpm install --frozen-lockfile }
}
Invoke-Native 'Build tracker packages' { pnpm run build:tracker-packages }
Invoke-Native 'Build extension-sdk' { pnpm --dir packages/extension-sdk run build }
$env:NODE_OPTIONS = '--max-old-space-size=8192'
Invoke-Native 'Build runtime' { pnpm --dir packages/runtime run build }
Remove-Item Env:NODE_OPTIONS
Invoke-Native 'Build datamodellm extension' { pnpm --dir packages/extensions/datamodellm run build }
Invoke-Native 'Build pdf-viewer extension' { pnpm --dir packages/extensions/pdf-viewer run build }
Invoke-Native 'Build csv-spreadsheet extension' { pnpm --dir packages/extensions/csv-spreadsheet run build }

Push-Location $ElectronDir
try {
  # pnpm appends these arguments to the last command of build:win, electron-builder.
  Invoke-Native 'build:win (electron-vite, extensions, validation, electron-builder)' {
    pnpm run build:win --publish never --config $ForkConfig
  }
} finally {
  Pop-Location
}

# --- Verify the output -------------------------------------------------------
Write-Step 'Verifying the installer'
if (-not (Test-Path $InstallerPath)) { Fail "installer not found at $InstallerPath" }
$installer = Get-Item $InstallerPath
if ($installer.LastWriteTime -lt $startedAt) { Fail "installer at $InstallerPath predates this build; electron-builder did not replace it" }

$builtMarkerPath = Join-Path $UnpackedResources 'fork-build.json'
if (-not (Test-Path $builtMarkerPath)) { Fail "fork marker missing from $UnpackedResources" }
$builtMarker = Get-Content $builtMarkerPath -Raw | ConvertFrom-Json
if ($builtMarker.commit -ne $forkCommit) { Fail "fork marker commit '$($builtMarker.commit)' does not match '$forkCommit'" }

$appUpdate = Get-Content (Join-Path $UnpackedResources 'app-update.yml') -Raw
if ($appUpdate -match '(?m)^owner:\s*nimbalyst\s*$') { Fail 'app-update.yml still names the official nimbalyst feed' }

# The compiled main bundle must carry the fork flag: the commit string only
# appears in app.asar when the define was applied.
$asarPath = Join-Path $UnpackedResources 'app.asar'
$found = node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);process.stdout.write(String(b.indexOf(Buffer.from(process.argv[2]))>=0))" $asarPath $forkCommit
if ($found -ne 'true') { Fail "app.asar does not contain the fork commit; the NIMBALYST_FORK_* define was not applied" }

$exeVersion = (Get-Item (Join-Path $ReleaseDir 'win-unpacked\Nimbalyst.exe')).VersionInfo.ProductVersion
$hash = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash

$lastBuild = [ordered]@{
  installer       = $InstallerPath
  sha256          = $hash
  sizeBytes       = $installer.Length
  commit          = $forkCommit
  upstreamVersion = $upstreamVersion
  exeVersion      = $exeVersion
  builtAt         = $builtMarker.builtAt
}
$lastBuild | ConvertTo-Json | Set-Content -Path (Join-Path $OutDir 'last-build.json') -Encoding ascii

Write-Host "`nFork installer built." -ForegroundColor Green
Write-Host "  Installer: $InstallerPath"
Write-Host "  SHA-256:   $hash"
Write-Host "  Size:      $([math]::Round($installer.Length / 1MB)) MB"
Write-Host "  Version:   $upstreamVersion (exe $exeVersion), fork commit $forkCommit"
Write-Host "`nInstall it from a normal PowerShell window with Nimbalyst closed:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$RepoRoot\scripts\fork\install.ps1`""
