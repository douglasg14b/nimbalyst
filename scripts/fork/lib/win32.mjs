// Windows implementation for the fork scripts. See ./platform.mjs for the contract.
//
// The app is the per-user NSIS install electron-builder produces for appId
// com.nimbalyst.electron: %LOCALAPPDATA%\Programs\Nimbalyst, data in
// %APPDATA%\@nimbalyst\electron. A few Windows facts (process paths, file
// versions, Authenticode signers, user/machine environment variables) are
// read through PowerShell cmdlets, which ship with every Windows install.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const id = 'win32';
export const displayName = 'Windows x64';
export const builderScript = 'build:win';
export const cacheDirNames = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];

const localAppData = () => process.env.LOCALAPPDATA;
const appData = () => process.env.APPDATA;

export const defaultOutputDir = () => path.join(localAppData(), 'NimbalystForkBuild', 'release');
export const installerPath = (out) => path.join(out, 'Nimbalyst-Windows-x64.exe');
export const unpackedExe = (out) => path.join(out, 'win-unpacked', 'Nimbalyst.exe');
export const unpackedResources = (out) => path.join(out, 'win-unpacked', 'resources');
export const installDir = () => path.join(localAppData(), 'Programs', 'Nimbalyst');
export const installedExe = () => path.join(installDir(), 'Nimbalyst.exe');
export const installedResources = () => path.join(installDir(), 'resources');
export const dataDir = () => path.join(appData(), '@nimbalyst', 'electron');
export const updaterCacheDir = () => path.join(localAppData(), '@nimbalystelectron-updater');

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function powershell(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return (r.stdout ?? '').trim();
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isUnder = (file, dir) => path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);

export function listProcesses() {
  const json = powershell(
    'Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="name";e={$_.Name}},@{n="path";e={$_.ExecutablePath}} | ConvertTo-Json -Compress',
  );
  if (!json) return [];
  const list = JSON.parse(json);
  return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.pid, name: p.name, path: p.path ?? null }));
}

export function isAppProcess(proc) {
  return proc.name?.toLowerCase() === 'nimbalyst.exe' || (proc.path && isUnder(proc.path, installDir()));
}

export function isProcessOf(proc, exe) {
  return !!proc.path && samePath(proc.path, exe);
}

export function persistentEnv(names) {
  const out = [];
  for (const scope of ['User', 'Machine']) {
    for (const name of names) {
      const value = powershell(`[Environment]::GetEnvironmentVariable(${psQuote(name)}, ${psQuote(scope)})`);
      if (value) out.push({ scope, name, value });
    }
  }
  return out;
}

export function fileVersion(file) {
  return powershell(`(Get-Item -LiteralPath ${psQuote(file)}).VersionInfo.ProductVersion`) || null;
}

/** Subject of a VALID Authenticode signature, or null when unsigned or invalid. */
export function signerSubject(file) {
  return (
    powershell(
      `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; if ($s.Status -eq 'Valid') { $s.SignerCertificate.Subject }`,
    ) || null
  );
}

/** The per-user uninstall entry NSIS registered, or null. */
export function installedRegistration() {
  const json = powershell(
    "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | " +
      "ForEach-Object { $p = Get-ItemProperty $_.PSPath; if (\"$($p.DisplayName)\" -like 'Nimbalyst*') { [pscustomobject]@{ key = $_.Name; displayName = $p.DisplayName; displayVersion = $p.DisplayVersion } } } | " +
      'Select-Object -First 1 | ConvertTo-Json -Compress',
  );
  return json ? JSON.parse(json) : null;
}

/** Export the uninstall entry for the rollback record. */
export function exportRegistration(registration, file) {
  if (!registration) return false;
  return spawnSync('reg', ['export', registration.key, file, '/y'], { stdio: 'ignore' }).status === 0;
}

/**
 * Run the NSIS installer. Silent mode with /currentuser keeps the existing
 * per-user scope; NSIS runs the previous uninstaller with
 * /S /KEEP_APP_DATA --updated, which removes only the program folder.
 */
export function runInstaller(installer, { interactive = false } = {}) {
  const r = spawnSync(installer, interactive ? [] : ['/S', '/currentuser'], { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status;
}

const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\nimbalyst';
const PROTOCOL_COMMAND_KEY = `${PROTOCOL_KEY}\\shell\\open\\command`;

function readProtocolCommand() {
  const r = spawnSync('reg', ['query', PROTOCOL_COMMAND_KEY, '/ve'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => /REG_(EXPAND_)?SZ/.test(l));
  return line ? line.replace(/^.*?REG_(EXPAND_)?SZ\s+/, '').trim() : null;
}

/** Save the nimbalyst:// handler before a packaged test launch re-registers it. */
export function saveProtocolHandler(dir) {
  const before = readProtocolCommand();
  const file = path.join(dir, 'protocol-nimbalyst.reg');
  if (before !== null && spawnSync('reg', ['export', PROTOCOL_KEY, file, '/y'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('reg export of the nimbalyst:// handler failed');
  }
  return { before, file };
}

export function restoreProtocolHandler(token) {
  if (token.before === null) return { ok: false, before: null, after: readProtocolCommand() };
  spawnSync('reg', ['import', token.file], { stdio: 'ignore' });
  const after = readProtocolCommand();
  return { ok: after === token.before, before: token.before, after };
}

export const exportProtocolHandler = (file) =>
  spawnSync('reg', ['export', PROTOCOL_KEY, file, '/y'], { stdio: 'ignore' }).status === 0;

/** Ask a process to close its windows (WM_CLOSE), like clicking the close button. */
export function requestClose(pid) {
  spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
}

export function forceKill(pid) {
  spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
}

/** The official updater's pending download, for information only. */
export function pendingOfficialUpdate() {
  const file = path.join(updaterCacheDir(), 'pending', 'update-info.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).fileName ?? null;
  } catch {
    return null;
  }
}
