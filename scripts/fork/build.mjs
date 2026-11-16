#!/usr/bin/env node
// Build the fork's installer. See FORK.md.
//
//   node scripts/fork/build.mjs [--skip-install] [--allow-dirty] [--output-dir <dir>]
//
// Runs the prebuild steps from .github/workflows/electron-build.yml, then the
// platform's electron-builder script with the fork flag always set,
// OFFICIAL_BUILD unset and signing off, at below-normal CPU priority. Stops on
// the first failing step. The output is checked for freshness and for the fork
// marker before it is reported, then recorded in
// nimbalyst-local/fork-build/last-build.json for install.mjs.
import { mkdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { currentPlatform } from './lib/platform.mjs';
import {
  ELECTRON_DIR, FORK_BUILDER_CONFIG, FORK_STATE_DIR, LAST_BUILD_FILE, REPO_ROOT,
  capture, dirtyFiles, fileContains, git, info, lowerPriority, parseArgs, parseGitHubRemote,
  pnpm, readJson, runMain, sha256File, step, stop, warn,
} from './lib/util.mjs';

const USAGE = 'node scripts/fork/build.mjs [--skip-install] [--allow-dirty] [--output-dir <dir>]';

// Variables that would change what gets built or signed. This shell may be a
// child of Nimbalyst or a dev session, so they are removed before building.
const SCRUB = [
  'OFFICIAL_BUILD', 'CI', 'ELECTRON_RUN_AS_NODE', 'PLAYWRIGHT', 'RUN_ONE_DEV_MODE',
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'DIGICERT_KEYPAIR_ALIAS', 'SM_HOST', 'SM_API_KEY', 'SM_CLIENT_CERT_FILE', 'SM_CLIENT_CERT_PASSWORD',
  'GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_RENDERER_URL', 'REQUIRE_NOTARIZE', 'ALLOW_UNSIGNED_WINDOWS_BUILD',
  'BUILD_ARCH', 'NODE_OPTIONS',
];

runMain(async () => {
  const args = parseArgs(process.argv.slice(2), {
    skipInstall: { type: 'boolean', default: false },
    allowDirty: { type: 'boolean', default: false },
    outputDir: { type: 'string', default: null },
  });
  if (args.help) { console.log(USAGE); return 0; }

  const platform = currentPlatform();
  lowerPriority();
  const outputDir = path.resolve(args.outputDir ?? platform.defaultOutputDir());
  if (outputDir.toLowerCase().startsWith(REPO_ROOT.toLowerCase())) {
    warn('the output folder is inside the checkout; a running Nimbalyst with this repo open can lock files there.');
  }

  step('Checking the checkout and toolchain');
  const sha = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = dirtyFiles();
  if (dirty.length && !args.allowDirty) {
    stop(`uncommitted changes in ${dirty.join(', ')}. Commit them, or pass --allow-dirty for a throwaway build.`);
  }
  const forkCommit = dirty.length ? `${sha}-dirty` : sha;
  if (branch !== 'fork/main') warn(`building from '${branch}', not fork/main.`);

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24) stop(`Node 24 is required (found ${process.version}).`);
  if (minor >= 19) warn(`Node ${process.version}: 24.19+ has crashed in native-addon GC on one machine; if the build dies in native code, use 24.18.1.`);
  const pnpmVersion = capture('pnpm', ['--version'], { shell: process.platform === 'win32' });

  const upstreamVersion = readJson(path.join(ELECTRON_DIR, 'package.json')).version;
  const baseTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD');
  const remote = parseGitHubRemote(git('remote', 'get-url', 'origin'));
  if (!remote) stop('cannot parse the origin remote as a GitHub repository.');
  if (remote.owner === 'nimbalyst') stop('origin points at nimbalyst/nimbalyst; fork builds must come from the fork checkout.');

  info(`platform: ${platform.displayName}`);
  info(`commit:   ${forkCommit} (${branch})`);
  info(`version:  ${upstreamVersion} (base tag ${baseTag})`);
  info(`node:     ${process.version}, pnpm ${pnpmVersion}`);
  info(`fork:     ${remote.owner}/${remote.repo}`);
  info(`output:   ${outputDir}`);

  step('Preparing the build environment');
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (SCRUB.includes(name.toUpperCase()) || name.toUpperCase().startsWith('NIMBALYST_')) delete env[name];
  }
  mkdirSync(FORK_STATE_DIR, { recursive: true });
  const markerFile = path.join(FORK_STATE_DIR, 'fork-build.json');
  const builtAt = new Date().toISOString();
  writeFileSync(markerFile, JSON.stringify({
    fork: true, commit: forkCommit, branch, upstreamVersion, baseTag,
    forkRepo: `${remote.owner}/${remote.repo}`, platform: platform.id, builtAt,
  }, null, 2));
  Object.assign(env, {
    NODE_ENV: 'production',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    NIMBALYST_FORK_BUILD: 'true',
    NIMBALYST_FORK_COMMIT: forkCommit,
    NIMBALYST_FORK_REPO: `${remote.owner}/${remote.repo}`,
    NIMBALYST_FORK_REPO_OWNER: remote.owner,
    NIMBALYST_FORK_REPO_NAME: remote.repo,
    NIMBALYST_FORK_MARKER_FILE: markerFile,
    NIMBALYST_FORK_OUTPUT_DIR: outputDir,
  });

  const startedAt = Date.now();
  const steps = [
    ...(args.skipInstall ? [] : [['pnpm install --frozen-lockfile', ['install', '--frozen-lockfile'], {}]]),
    ['Build tracker packages', ['run', 'build:tracker-packages'], {}],
    ['Build extension-sdk', ['--dir', 'packages/extension-sdk', 'run', 'build'], {}],
    ['Build runtime', ['--dir', 'packages/runtime', 'run', 'build'], { NODE_OPTIONS: '--max-old-space-size=8192' }],
    ['Build datamodellm extension', ['--dir', 'packages/extensions/datamodellm', 'run', 'build'], {}],
    ['Build pdf-viewer extension', ['--dir', 'packages/extensions/pdf-viewer', 'run', 'build'], {}],
    ['Build csv-spreadsheet extension', ['--dir', 'packages/extensions/csv-spreadsheet', 'run', 'build'], {}],
  ];
  for (const [name, pnpmArgs, extraEnv] of steps) {
    step(name);
    pnpm(pnpmArgs, { env: { ...env, ...extraEnv } });
  }
  // pnpm appends these arguments to the script's last command, electron-builder.
  step(`${platform.builderScript} (electron-vite, extensions, validation, electron-builder)`);
  pnpm(['run', platform.builderScript, '--publish', 'never', '--config', FORK_BUILDER_CONFIG], { cwd: ELECTRON_DIR, env });

  step('Verifying the output');
  const installer = platform.installerPath(outputDir);
  if (!existsSync(installer)) stop(`installer not found at ${installer}`);
  if (statSync(installer).mtimeMs < startedAt) stop(`installer at ${installer} predates this build; electron-builder did not replace it.`);
  const resources = platform.unpackedResources(outputDir);
  const builtMarkerFile = path.join(resources, 'fork-build.json');
  if (!existsSync(builtMarkerFile)) stop(`fork marker missing from ${resources}`);
  if (readJson(builtMarkerFile).commit !== forkCommit) stop('the packaged fork marker does not match this commit.');
  const appUpdate = path.join(resources, 'app-update.yml');
  if (existsSync(appUpdate) && /^owner:\s*nimbalyst\s*$/m.test(readFileSync(appUpdate, 'utf8'))) {
    stop('app-update.yml still names the official nimbalyst feed.');
  }
  // The commit string is only in app.asar when the NIMBALYST_FORK_* define was applied.
  if (!fileContains(path.join(resources, 'app.asar'), forkCommit)) stop('app.asar does not carry the fork commit; the fork define was not applied.');

  const sha256 = await sha256File(installer);
  const record = {
    platform: platform.id,
    installer,
    sha256,
    sizeBytes: statSync(installer).size,
    commit: forkCommit,
    upstreamVersion,
    exeVersion: platform.fileVersion(platform.unpackedExe(outputDir)),
    outputDir,
    builtAt,
  };
  writeFileSync(LAST_BUILD_FILE, JSON.stringify(record, null, 2));

  console.log('\nFork installer built.');
  info(`Installer: ${installer}`);
  info(`SHA-256:   ${sha256}`);
  info(`Size:      ${Math.round(record.sizeBytes / 1024 ** 2)} MB`);
  info(`Version:   ${upstreamVersion}, fork commit ${forkCommit}`);
  console.log('\nNext: node scripts/fork/smoke-test.mjs, then quit Nimbalyst and run node scripts/fork/install.mjs');
  return 0;
});
