// Shared helpers for the fork scripts (FORK.md). Platform-neutral: anything
// that differs per OS lives in ./platform.mjs and its per-OS modules.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ELECTRON_DIR = path.join(REPO_ROOT, 'packages', 'electron');
export const FORK_STATE_DIR = path.join(REPO_ROOT, 'nimbalyst-local', 'fork-build');
export const LAST_BUILD_FILE = path.join(FORK_STATE_DIR, 'last-build.json');
export const FORK_BUILDER_CONFIG = path.join(REPO_ROOT, 'scripts', 'fork', 'electron-builder.fork.cjs');

// Files that builds and typechecks rewrite in place. They are build output,
// never committed on fork branches (that would conflict with every upstream
// release merge), and do not make the tree "dirty".
export const GENERATED_PATHS = ['packages/electron/resources/generated', 'packages/collab-bundle/types'];

export class StopError extends Error {}

export function step(message) { console.log(`\n==> ${message}`); }
export function info(message) { console.log(`  ${message}`); }
export function warn(message) { console.warn(`  WARNING: ${message}`); }
/** Stop the script with a clear message and exit code 1. */
export function stop(message) { throw new StopError(message); }

/** Run an async main, turning StopError into a clean message and exit code 1. */
export function runMain(fn) {
  fn().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      if (error instanceof StopError) {
        console.error(`\nSTOPPED: ${error.message}`);
      } else {
        console.error(error);
      }
      process.exit(1);
    },
  );
}

/** Minimal --flag / --key value parser. Unknown flags stop the script. */
export function parseArgs(argv, spec) {
  const out = {};
  for (const [name, def] of Object.entries(spec)) out[name] = def.default;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    const name = arg.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const def = spec[name];
    if (!arg.startsWith('--') || !def) stop(`unknown argument ${arg}`);
    if (def.type === 'boolean') out[name] = true;
    else {
      const value = argv[++i];
      if (value === undefined) stop(`${arg} needs a value`);
      out[name] = value;
    }
  }
  return out;
}

/** Lower this process's priority; children inherit it, so builds yield to a running Nimbalyst. */
export function lowerPriority() {
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    warn(`could not lower process priority: ${error.message}`);
  }
}

function quoteForShell(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${String(arg).replace(/"/g, '""')}"` : String(arg);
}

/**
 * Run a command with inherited output; stop on a non-zero exit.
 * `shell` is needed on Windows for .cmd shims such as pnpm; arguments are quoted.
 */
export function run(cmd, args = [], { cwd = REPO_ROOT, env = process.env, shell = false } = {}) {
  const result = shell
    ? spawnSync([cmd, ...args.map(quoteForShell)].join(' '), { cwd, env, stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (result.error) stop(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) stop(`${[cmd, ...args].join(' ')} exited with code ${result.status}`);
}

/** Run a command and return its trimmed stdout; stop on failure unless allowFailure. */
export function capture(cmd, args = [], { cwd = REPO_ROOT, env = process.env, shell = false, allowFailure = false } = {}) {
  const result = shell
    ? spawnSync([cmd, ...args.map(quoteForShell)].join(' '), { cwd, env, encoding: 'utf8', shell: true })
    : spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (result.error) {
    if (allowFailure) return { status: -1, stdout: '', stderr: result.error.message };
    stop(`${cmd} failed to start: ${result.error.message}`);
  }
  if (allowFailure) return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  if (result.status !== 0) stop(`${[cmd, ...args].join(' ')} exited with code ${result.status}: ${(result.stderr ?? '').trim()}`);
  return (result.stdout ?? '').trim();
}

export const git = (...args) => capture('git', args);
export const pnpm = (args, opts = {}) => run('pnpm', args, { ...opts, shell: process.platform === 'win32' });

/** Tracked files with real (not line-ending-only) uncommitted changes, ignoring generated output. */
export function dirtyFiles() {
  const excludes = GENERATED_PATHS.map((p) => `:(exclude)${p}`);
  const out = git('diff', 'HEAD', '--ignore-cr-at-eol', '--name-only', '--', '.', ...excludes);
  return out ? out.split(/\r?\n/) : [];
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function readJsonIfExists(file) {
  return existsSync(file) ? readJson(file) : null;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

/** "0.83.0.0" / "v0.83.0" / "0.83.0+x" -> [0, 83, 0], or null. */
export function plainVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export const formatVersion = (v) => (v ? v.join('.') : '(unknown)');
export const formatGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/** Free bytes on the volume holding `dir` (or its nearest existing parent). */
export function freeBytes(dir) {
  let probe = path.resolve(dir);
  while (!existsSync(probe)) probe = path.dirname(probe);
  const s = statfsSync(probe);
  return Number(s.bavail) * Number(s.bsize);
}

/** @electron/asar from the repo's dependencies, for reading packaged apps. */
export function loadAsar() {
  const require = createRequire(path.join(REPO_ROOT, 'package.json'));
  try {
    return require('@electron/asar');
  } catch {
    return createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar');
  }
}

/** package.json "version" inside a packaged app.asar. */
export function asarAppVersion(asarPath) {
  const asar = loadAsar();
  return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
}

/** True when the raw app.asar bytes contain `needle` (used to prove the fork define was compiled in). */
export function fileContains(file, needle) {
  return readFileSync(file).includes(Buffer.from(needle));
}

/** Parse "github.com[:/]owner/repo(.git)" from a remote URL. */
export function parseGitHubRemote(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
