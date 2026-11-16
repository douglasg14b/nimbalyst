// electron-builder config for fork builds. See FORK.md.
//
// It is packages/electron/package.json "build" unchanged (same appId,
// productName, NSIS options and signing config, so the installer upgrades the
// official per-user install in place), with two additions:
//
// - resources/fork-build.json, the on-disk fork marker that
//   scripts/fork/install.mjs verifies after installing.
// - publish points at the fork instead of nimbalyst/nimbalyst, so the bundled
//   resources/app-update.yml no longer names the official feed. The updater is
//   inert in fork builds anyway (src/main/services/forkInertUpdater.ts); this
//   is a second line of defence.
//
// scripts/fork/build.mjs passes this file with --config and sets the
// environment variables below. Paths in the base config stay relative to
// packages/electron, which is the project directory.
const pkg = require('../../packages/electron/package.json');

const marker = process.env.NIMBALYST_FORK_MARKER_FILE;
if (!marker) {
  throw new Error('NIMBALYST_FORK_MARKER_FILE is not set. Build fork installers with scripts/fork/build.mjs.');
}
const owner = process.env.NIMBALYST_FORK_REPO_OWNER;
const repo = process.env.NIMBALYST_FORK_REPO_NAME;
if (!owner || !repo) {
  throw new Error('NIMBALYST_FORK_REPO_OWNER / NIMBALYST_FORK_REPO_NAME are not set. Use scripts/fork/build.mjs.');
}
if (owner === 'nimbalyst') {
  throw new Error('Fork builds must not publish to the official nimbalyst/nimbalyst feed.');
}

// Output outside the checkout. When the live Nimbalyst has this repo open as a
// workspace, Electron's asar-aware fs keeps release\win-unpacked.tmp\resources\
// default_app.asar open after indexing it, and electron-builder's final rename
// fails with EPERM/EBUSY.
const output = process.env.NIMBALYST_FORK_OUTPUT_DIR;
if (!output) {
  throw new Error('NIMBALYST_FORK_OUTPUT_DIR is not set. Use scripts/fork/build.mjs.');
}

const base = pkg.build;
module.exports = {
  ...base,
  directories: { ...base.directories, output },
  publish: [{ provider: 'github', owner, repo, releaseType: 'release' }],
  extraResources: [...base.extraResources, { from: marker, to: 'fork-build.json' }],
};
