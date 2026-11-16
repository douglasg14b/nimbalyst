#!/usr/bin/env node
// Install the fork build over the existing Nimbalyst install. See FORK.md.
//
//   node scripts/fork/install.mjs [--dry-run] [--backup-only] [--interactive]
//                                 [--installer <file>] [--backup-root <dir>] [--ignore-env-overrides]
//
// Run it from a normal terminal with Nimbalyst closed, never from inside Nimbalyst.
//  1. Refuses while any Nimbalyst process runs (lists them; never stops them).
//  2. Refuses data-redirecting environment variables and downgrades.
//  3. Backs up the app's data folder (only reads it), skipping regenerable caches.
//  4. Records the current install and keeps rollback material.
//  5. Runs the fork installer through the OS's normal upgrade path.
//  6. Verifies the installed build and that no data file changed.
// --dry-run runs every check and reports, without copying or installing.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { currentPlatform } from './lib/platform.mjs';
import {
  ELECTRON_DIR, LAST_BUILD_FILE, asarAppVersion, compareVersions, fileContains, formatGb, formatVersion,
  freeBytes, info, parseArgs, plainVersion, readJson, readJsonIfExists, runMain, sha256File, step, stop, warn,
} from './lib/util.mjs';

const USAGE = 'node scripts/fork/install.mjs [--dry-run] [--backup-only] [--interactive] [--installer <file>] [--backup-root <dir>] [--ignore-env-overrides]';
const OVERRIDE_VARS = ['NIMBALYST_USER_DATA_DIR', 'NIMBALYST_USER_DATA_PATH', 'RUN_ONE_DEV_MODE', 'PLAYWRIGHT', 'ELECTRON_RUN_AS_NODE'];

/** Every file under `root`, skipping top-level cache folders, with size and mtime. */
function listDataFiles(root, cacheDirNames) {
  const isCache = (name) => cacheDirNames.includes(name) || name.startsWith('Dawn');
  const files = [];
  const walk = (dir, top) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (top && entry.isDirectory() && isCache(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, false);
      else if (entry.isFile()) {
        const s = statSync(full);
        files.push({ path: full, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  walk(root, true);
  return { files, isCache };
}

runMain(async () => {
  const args = parseArgs(process.argv.slice(2), {
    dryRun: { type: 'boolean', default: false },
    backupOnly: { type: 'boolean', default: false },
    interactive: { type: 'boolean', default: false },
    ignoreEnvOverrides: { type: 'boolean', default: false },
    installer: { type: 'string', default: null },
    backupRoot: { type: 'string', default: path.join(homedir(), 'NimbalystBackups') },
  });
  if (args.help) { console.log(USAGE); return 0; }

  const platform = currentPlatform();
  const findings = [];
  // In a dry run a failed check is reported and the rehearsal continues.
  const check = (message) => {
    if (!args.dryRun) stop(message);
    console.log(`  WOULD STOP: ${message}`);
    findings.push(message);
  };
  const dataDir = platform.dataDir();

  step('Checking that Nimbalyst is not running');
  const running = platform.listProcesses().filter((p) => platform.isAppProcess(p));
  if (running.length) {
    for (const p of running) info(`${p.pid}  ${p.name}  ${p.path ?? ''}`);
    check('Nimbalyst is running. Quit it (including the tray icon), then run this again. Nothing was changed.');
  } else {
    info('No Nimbalyst process is running.');
  }

  step('Checking for data-redirecting environment variables');
  const overrides = [
    ...OVERRIDE_VARS.filter((n) => process.env[n]).map((n) => ({ scope: 'Process', name: n, value: process.env[n] })),
    ...platform.persistentEnv(OVERRIDE_VARS),
  ];
  if (overrides.length) {
    for (const o of overrides) info(`${o.scope}: ${o.name}=${o.value}`);
    if (args.ignoreEnvOverrides) warn('continuing with the overrides above (--ignore-env-overrides).');
    else check('these variables make Nimbalyst use different data or behave as a test build. Remove them, or pass --ignore-env-overrides.');
  } else {
    info('None set.');
  }

  step('Locating the fork installer');
  const lastBuild = readJsonIfExists(LAST_BUILD_FILE);
  let installer = args.installer ?? lastBuild?.installer ?? null;
  let installerHash = null;
  let forkCommit = null;
  let forkVersion = null;
  if (!installer) {
    check(`no --installer given and no ${LAST_BUILD_FILE}. Run node scripts/fork/build.mjs first.`);
  } else if (!existsSync(installer)) {
    check(`installer not found: ${installer}`);
  } else {
    installer = path.resolve(installer);
    installerHash = await sha256File(installer);
    if (!lastBuild || path.resolve(lastBuild.installer) !== installer) {
      check('the installer is not the one recorded by build.mjs, so its fork version is unknown. Rebuild, or pass the recorded file.');
    } else if (lastBuild.platform && lastBuild.platform !== platform.id) {
      check(`the last build is for ${lastBuild.platform}, not ${platform.id}.`);
    } else if (lastBuild.sha256 !== installerHash) {
      check(`installer SHA-256 ${installerHash} does not match the build record ${lastBuild.sha256}. Rebuild it.`);
    } else {
      forkCommit = lastBuild.commit;
      forkVersion = plainVersion(lastBuild.upstreamVersion);
    }
  }
  // A dry run without a usable build record compares against the checkout's version.
  forkVersion ??= plainVersion(readJson(path.join(ELECTRON_DIR, 'package.json')).version);
  info(`Installer: ${installer ?? '(none)'}`);
  info(`SHA-256:   ${installerHash ?? '(n/a)'}`);
  info(`Fork commit ${forkCommit ?? '(unknown)'}, upstream version ${formatVersion(forkVersion)}`);

  step('Recording the current install');
  const exe = platform.installedExe();
  if (!existsSync(exe)) stop(`no Nimbalyst install at ${exe}`);
  const resources = platform.installedResources();
  const installedVersion = plainVersion(asarAppVersion(path.join(resources, 'app.asar')));
  const installedMarker = readJsonIfExists(path.join(resources, 'fork-build.json'));
  const installedSigner = platform.signerSubject(exe) ?? '(unsigned)';
  const registration = platform.installedRegistration();
  info(`Exe:        ${exe}`);
  info(`Version:    ${formatVersion(installedVersion)} (file version ${platform.fileVersion(exe)})`);
  info(`Signer:     ${installedSigner}`);
  info(`Fork build: ${installedMarker ? `yes, commit ${installedMarker.commit}` : 'no (official build)'}`);
  if (registration) info(`Registered: ${registration.displayName} (${registration.key})`);
  else warn('no uninstall registration found; the installer may not treat this as an upgrade.');

  step('Checking versions');
  const appSettings = readJsonIfExists(path.join(dataDir, 'app-settings.json'));
  const lastKnownVersion = plainVersion(appSettings?.lastKnownVersion);
  info(`Installed ${formatVersion(installedVersion)}, data last opened by ${formatVersion(lastKnownVersion)}, fork ${formatVersion(forkVersion)}`);
  if (installedVersion && compareVersions(installedVersion, forkVersion) > 0) {
    check(`the installed Nimbalyst (${formatVersion(installedVersion)}) is newer than the fork (${formatVersion(forkVersion)}). Merge that release into fork/main and rebuild; installing would be a downgrade.`);
  }
  if (lastKnownVersion && compareVersions(lastKnownVersion, forkVersion) > 0) {
    check(`your data was last opened by Nimbalyst ${formatVersion(lastKnownVersion)}, newer than the fork (${formatVersion(forkVersion)}). Merge that release into fork/main and rebuild first.`);
  }
  const pending = platform.pendingOfficialUpdate();
  if (pending) info(`The official updater cache holds ${pending}. The fork never reads it.`);

  step('Backing up your Nimbalyst data');
  if (!existsSync(dataDir)) stop(`data folder not found: ${dataDir}`);
  const backupRoot = path.resolve(args.backupRoot);
  const appDataParent = path.dirname(dataDir);
  if (backupRoot.toLowerCase().startsWith(appDataParent.toLowerCase())) stop(`the backup must live outside ${appDataParent}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backupDir = path.join(backupRoot, `nimbalyst-${stamp}`);
  const backupData = path.join(backupDir, path.basename(dataDir));
  const { files: sourceFiles, isCache } = listDataFiles(dataDir, platform.cacheDirNames);
  const sourceBytes = sourceFiles.reduce((n, f) => n + f.size, 0);
  const free = freeBytes(backupRoot);
  info(`Source:  ${dataDir}`);
  info(`Size:    ${formatGb(sourceBytes)} in ${sourceFiles.length} files (excluding regenerable caches)`);
  info(`Target:  ${backupData}`);
  info(`Free:    ${formatGb(free)}`);
  if (free < sourceBytes * 1.1 + 2 * 1024 ** 3) check('not enough free disk space for the backup.');

  if (args.dryRun) {
    console.log('\nDRY RUN complete. Nothing was copied, installed or changed.');
    if (findings.length) {
      console.log('A real run would stop on:');
      for (const f of findings) console.log(`  - ${f}`);
    } else {
      console.log('A real run would continue to the backup and install.');
    }
    return 0;
  }

  mkdirSync(backupData, { recursive: true });
  // Only reads the source. Skips top-level caches and links, keeps timestamps.
  cpSync(dataDir, backupData, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(dataDir, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      return !(parts.length >= 1 && isCache(parts[0]) && statSync(path.join(dataDir, parts[0])).isDirectory());
    },
  });
  const { files: backupFiles } = listDataFiles(backupData, platform.cacheDirNames);
  const backupBytes = backupFiles.reduce((n, f) => n + f.size, 0);
  if (backupFiles.length !== sourceFiles.length || backupBytes !== sourceBytes) {
    stop(`the backup does not match the source (${backupFiles.length} files / ${backupBytes} bytes vs ${sourceFiles.length} / ${sourceBytes}). The install did not run.`);
  }
  const critical = ['sqlite-db', 'app-settings.json', 'ai-settings.json', 'workspace-settings.json',
    ...readdirSync(dataDir).filter((n) => n.endsWith('.enc'))];
  for (const name of critical) {
    if (existsSync(path.join(dataDir, name)) && !existsSync(path.join(backupData, name))) stop(`the backup is missing ${name}.`);
  }
  info(`Backup verified: ${backupFiles.length} files, ${formatGb(backupBytes)}.`);

  // Rollback material: the cached official installer when it matches what is
  // installed, the OS registrations the installer owns, and a record.
  let officialInstaller = null;
  const cachedInstaller = path.join(platform.updaterCacheDir(), 'installer.exe');
  if (!installedMarker && existsSync(cachedInstaller)) {
    const signer = platform.signerSubject(cachedInstaller);
    const version = plainVersion(platform.fileVersion(cachedInstaller));
    if (signer?.includes('NIMBALYST, INC.') && version && installedVersion && compareVersions(version, installedVersion) === 0) {
      officialInstaller = path.join(backupDir, `Nimbalyst-${formatVersion(installedVersion)}-official-installer.exe`);
      copyFileSync(cachedInstaller, officialInstaller);
      info(`Kept the signed official ${formatVersion(installedVersion)} installer: ${officialInstaller}`);
    }
  }
  platform.exportProtocolHandler(path.join(backupDir, 'protocol-nimbalyst.reg'));
  platform.exportRegistration(registration, path.join(backupDir, 'uninstall-entry.reg'));
  writeFileSync(path.join(backupDir, 'rollback-info.json'), JSON.stringify({
    takenAt: new Date().toISOString(), dataDir, backupData, installedExe: exe,
    installedVersion: formatVersion(installedVersion), installedSigner,
    installedForkCommit: installedMarker?.commit ?? null, officialInstaller,
    forkInstaller: installer, forkInstallerSha256: installerHash, forkCommit,
  }, null, 2));
  info(`Rollback record: ${path.join(backupDir, 'rollback-info.json')}`);

  if (args.backupOnly) {
    console.log('\nBackup complete (--backup-only). Nothing was installed.');
    return 0;
  }

  step('Running the fork installer');
  const code = platform.runInstaller(installer, { interactive: args.interactive });
  if (code !== 0) stop(`the installer exited with code ${code}. Your data is untouched and backed up at ${backupData}. See "Rolling back" in FORK.md.`);

  step('Verifying the installed build');
  const problems = [];
  const newVersion = plainVersion(asarAppVersion(path.join(resources, 'app.asar')));
  if (!newVersion || compareVersions(newVersion, forkVersion) !== 0) problems.push(`installed version ${formatVersion(newVersion)}, expected ${formatVersion(forkVersion)}`);
  const newMarker = readJsonIfExists(path.join(resources, 'fork-build.json'));
  if (!newMarker) problems.push('the fork marker resources/fork-build.json is missing');
  else if (newMarker.commit !== forkCommit) problems.push(`installed fork commit ${newMarker.commit}, expected ${forkCommit}`);
  const appUpdate = path.join(resources, 'app-update.yml');
  if (existsSync(appUpdate) && /^owner:\s*nimbalyst\s*$/m.test(readFileSync(appUpdate, 'utf8'))) problems.push('app-update.yml still names the official feed');
  if (!fileContains(path.join(resources, 'app.asar'), forkCommit)) problems.push('app.asar does not carry the fork build flag');
  const changed = sourceFiles.filter((f) => {
    if (!existsSync(f.path)) return true;
    const s = statSync(f.path);
    return s.size !== f.size || s.mtimeMs !== f.mtimeMs;
  });
  if (changed.length) problems.push(`the installer changed ${changed.length} data file(s), e.g. ${changed.slice(0, 3).map((f) => f.path).join(', ')}`);

  if (problems.length) {
    console.error('\nINSTALL VERIFICATION FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nYour data is backed up at ${backupData}. See "Rolling back" in FORK.md.`);
    return 1;
  }

  console.log('\nFork build installed and verified.');
  info(`${exe}: Nimbalyst ${formatVersion(newVersion)}, fork commit ${forkCommit}`);
  info(`Data folder untouched: ${sourceFiles.length} files unchanged.`);
  info(`Backup: ${backupDir}`);
  console.log(`
Next: start Nimbalyst and check
  - your projects and recent sessions are listed and open
  - you are still signed in, and sync shows connected (if you use it)
  - Settings > Advanced shows "Fork build" with commit ${forkCommit}
  - Help > Check for Updates... reports the fork's update status

Rollback (back to the official release):
  1. Quit Nimbalyst.
  2. Run the official ${formatVersion(installedVersion)} installer${officialInstaller ? `:\n       ${officialInstaller}` : ' from https://github.com/nimbalyst/nimbalyst/releases'}
     It upgrades in place over the fork and keeps your data.
  3. Your data does not need restoring. Restore ${backupData} only if something is missing,
     by copying it back over ${dataDir} with Nimbalyst closed.`);
  return 0;
});
