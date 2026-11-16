#!/usr/bin/env node
// One command to update the fork build. See FORK.md.
//
//   node scripts/fork/update.mjs [--tag vX.Y.Z] [--force-build]
//
// 1. sync-upstream: merge the newest stable upstream release into fork/main
//    (stops on conflicts).
// 2. build: if anything was merged, or the last build is not of the current
//    commit, or --force-build.
// 3. smoke-test: boot the new build on an empty scratch profile.
// 4. Tells you to quit Nimbalyst and run install.mjs. It never installs by
//    itself, because installing needs Nimbalyst closed and this may be running
//    inside it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAST_BUILD_FILE, git, info, parseArgs, readJsonIfExists, runMain, step, stop } from './lib/util.mjs';
import { syncUpstream } from './sync-upstream.mjs';

const USAGE = 'node scripts/fork/update.mjs [--tag vX.Y.Z] [--force-build]';
const here = path.dirname(fileURLToPath(import.meta.url));

function runScript(name, args = []) {
  const r = spawnSync(process.execPath, [path.join(here, name), ...args], { stdio: 'inherit' });
  if (r.status !== 0) stop(`${name} failed (exit code ${r.status}).`);
}

runMain(async () => {
  const args = parseArgs(process.argv.slice(2), {
    tag: { type: 'string', default: null },
    forceBuild: { type: 'boolean', default: false },
  });
  if (args.help) { console.log(USAGE); return 0; }

  const sync = await syncUpstream({ tag: args.tag });
  const head = git('rev-parse', 'HEAD');
  const lastBuild = readJsonIfExists(LAST_BUILD_FILE);
  const needsBuild = args.forceBuild || sync.merged || lastBuild?.commit !== head;
  if (!needsBuild) {
    step('Build');
    info(`The last build (${lastBuild.installer}) is already of ${head}.`);
  } else {
    runScript('build.mjs', ['--skip-install']);
  }
  runScript('smoke-test.mjs');
  console.log(`
Ready to install fork commit ${head}${sync.merged ? ` (now including upstream ${sync.tag})` : ''}.
  1. Push the branches:   git push origin main fork/main
  2. Quit Nimbalyst (including the tray icon).
  3. From a normal terminal: node scripts/fork/install.mjs`);
  return 0;
});
