// Picks the per-OS implementation for the fork scripts (FORK.md).
//
// Only Windows is implemented today. To add an OS, create a sibling module
// (e.g. ./linux.mjs, ./darwin.mjs) exporting the same members as ./win32.mjs
// and register it below. The platform-neutral scripts call only these members:
//
//   id, displayName
//   builderScript                 packages/electron script that builds and packages
//   defaultOutputDir()            electron-builder output folder (outside the checkout)
//   installerPath(outputDir)      the artifact install.mjs runs
//   unpackedExe(outputDir), unpackedResources(outputDir)
//   installDir(), installedExe(), installedResources()
//   dataDir()                     the app's live userData folder
//   updaterCacheDir()             the official updater's download cache
//   cacheDirNames                 top-level userData folders that are safe to skip in backups
//   listProcesses()               [{ pid, name, path }]
//   isAppProcess(proc)            true for the installed app's processes
//   isProcessOf(proc, exe)        true when proc runs exactly that executable
//   persistentEnv(names)          [{ scope, name, value }] set outside this process
//   fileVersion(file), signerSubject(file)
//   installedRegistration(), exportRegistration(reg, file)   the OS's record of the install
//   exportProtocolHandler(file)   back up the nimbalyst:// registration
//   pendingOfficialUpdate()       informational: the official updater's pending download
//   runInstaller(installer, { interactive }) -> exit code
//   saveProtocolHandler(dir) -> token, restoreProtocolHandler(token) -> { ok, before, after }
//   requestClose(pid), forceKill(pid)
import { stop } from './util.mjs';
import * as win32 from './win32.mjs';

const PLATFORMS = { win32 };

export function currentPlatform() {
  const platform = PLATFORMS[process.platform];
  if (!platform) {
    stop(`${process.platform} is not supported by the fork scripts yet; only Windows is implemented. See "Other operating systems" in FORK.md.`);
  }
  return platform;
}
