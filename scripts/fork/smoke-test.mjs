#!/usr/bin/env node
// Boot the freshly built fork app on an EMPTY scratch profile and check its
// startup log. See FORK.md.
//
//   node scripts/fork/smoke-test.mjs [--boot-timeout <s>] [--idle <s>]
//
// Never uses your real data: NIMBALYST_USER_DATA_DIR points at a new, empty
// folder next to the build output, which also lets it run beside a running
// Nimbalyst (the variable skips the single-instance lock). A packaged launch
// re-registers the nimbalyst:// handler to the test exe, so it is saved first
// and restored afterwards. Only processes of the test build's exe are closed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentPlatform } from './lib/platform.mjs';
import { LAST_BUILD_FILE, info, parseArgs, readJsonIfExists, runMain, sleep, step, stop } from './lib/util.mjs';

const USAGE = 'node scripts/fork/smoke-test.mjs [--boot-timeout <seconds>] [--idle <seconds>]';
const SCRUB = ['ELECTRON_RUN_AS_NODE', 'PLAYWRIGHT', 'NODE_ENV', 'OFFICIAL_BUILD', 'RUN_ONE_DEV_MODE', 'ELECTRON_RENDERER_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

function readLogs(dir) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((n) => /^main.*\.log$/.test(n))
    .sort()
    .reverse()
    .map((n) => readFileSync(path.join(dir, n), 'utf8'))
    .join('\n');
}

runMain(async () => {
  const args = parseArgs(process.argv.slice(2), {
    bootTimeout: { type: 'string', default: '120' },
    idle: { type: 'string', default: '30' },
  });
  if (args.help) { console.log(USAGE); return 0; }

  const platform = currentPlatform();
  const lastBuild = readJsonIfExists(LAST_BUILD_FILE);
  if (!lastBuild) stop('no build recorded. Run node scripts/fork/build.mjs first.');
  const exe = platform.unpackedExe(lastBuild.outputDir ?? platform.defaultOutputDir());
  if (!existsSync(exe)) stop(`no unpacked build at ${exe}`);
  const liveData = platform.dataDir();

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const scratchRoot = path.join(path.dirname(path.dirname(exe)), '..', `smoke-${stamp}`);
  const scratch = path.resolve(scratchRoot, 'userdata');
  if (scratch.toLowerCase().startsWith(path.dirname(liveData).toLowerCase())) stop('the scratch profile must not be inside the live data folder.');
  mkdirSync(scratch, { recursive: true });

  step('Saving the nimbalyst:// handler');
  const protocol = platform.saveProtocolHandler(path.resolve(scratchRoot));
  info(`Before: ${protocol.before ?? '(none)'}`);

  let child = null;
  let failure = null;
  try {
    step(`Booting the fork build on an empty profile (${scratch})`);
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.toUpperCase().startsWith('NIMBALYST_') || SCRUB.includes(name.toUpperCase())) delete env[name];
    }
    env.NIMBALYST_USER_DATA_DIR = scratch;
    env.NIMBALYST_DISABLE_ANALYTICS = '1';
    child = spawn(exe, [], { env, stdio: 'ignore', detached: false });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let exited = null;
    child.on('exit', (code) => { exited = code ?? -1; });
    info(`PID ${child.pid}`);

    const logsDir = path.join(scratch, 'logs');
    const deadline = Date.now() + Number(args.bootTimeout) * 1000;
    while (Date.now() < deadline && exited === null && !/App ready/.test(readLogs(logsDir))) await sleep(2000);
    if (exited !== null) throw new Error(`the fork build exited during boot with code ${exited}`);
    if (!/App ready/.test(readLogs(logsDir))) throw new Error(`no "App ready" in ${logsDir} after ${args.bootTimeout} s`);
    info(`App ready. Idling ${args.idle} s (the official updater's first check would fire at 30 s).`);
    await sleep(Number(args.idle) * 1000);
    if (exited !== null) throw new Error(`the fork build exited while idle with code ${exited}`);
  } catch (error) {
    failure = error;
  } finally {
    step('Closing the test instance');
    if (child?.pid) platform.requestClose(child.pid);
    await sleep(8000);
    for (const p of platform.listProcesses().filter((p) => platform.isProcessOf(p, exe))) {
      info(`stopping test process ${p.pid} (${p.path})`);
      platform.forceKill(p.pid);
    }
    step('Restoring the nimbalyst:// handler');
    const restored = platform.restoreProtocolHandler(protocol);
    if (protocol.before === null) info('There was no handler before; the test exe may now own nimbalyst://. Installing fixes it.');
    else if (restored.ok) info(`Restored: ${restored.after}`);
    else console.error(`  PROTOCOL NOT RESTORED: ${restored.after} (expected ${restored.before}). Re-import ${protocol.file}.`);
  }
  if (failure) stop(failure.message);

  step('Checking the startup log');
  const log = readLogs(path.join(scratch, 'logs'));
  const marker = `[fork] Fork build ${lastBuild.commit}: the official updater is disabled`;
  const liveLogs = readLogs(path.join(liveData, 'logs'));
  const checks = [
    ['reached App ready', /App ready/.test(log)],
    ['inert updater bound, with the fork commit', log.includes(marker)],
    ['no official update check', !/Checking for update/.test(log)],
    ['no official feed configured', !/channel updates from GitHub/.test(log)],
    ['SQLite database initialised', /\[Database\] Database system ready/.test(log)],
    ['nothing logged into the live data folder', !liveLogs.includes(marker)],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed++;
    info(`[${ok ? 'ok' : 'FAIL'}] ${name}`);
  }
  info(`Scratch profile and logs: ${path.resolve(scratchRoot)}`);
  if (failed) stop(`${failed} smoke check(s) failed.`);
  console.log('\nSmoke test passed.');
  return 0;
});
