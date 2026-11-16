#!/usr/bin/env node
// Bring fork/main up to the newest stable upstream release. See FORK.md.
//
//   node scripts/fork/sync-upstream.mjs [--tag vX.Y.Z] [--skip-tests]
//
// 1. Requires fork/main checked out with no uncommitted changes.
// 2. Fetches upstream (with tags) and origin, and fast-forwards the local
//    `main` mirror to upstream/main (never commits to it).
//    Regenerated build output (license files, collab-bundle types) is reset to
//    the committed version first; the next build regenerates it.
// 3. Picks upstream's latest stable GitHub release (prereleases are never
//    picked) unless --tag is given, and merges that TAG into fork/main with a
//    merge commit. Never rebases, never merges upstream/main.
// 4. On conflicts: lists the files, leaves the merge in progress for you to
//    resolve (see "Resolving conflicts" in FORK.md), and exits 1.
// 5. Otherwise installs dependencies, runs the fork's own tests and the full
//    typecheck (--skip-tests skips both). Run again
//    after finishing a conflicted merge by hand, it recognises HEAD as that
//    merge and runs the same checks.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GENERATED_PATHS, info, git, capture, dirtyFiles, lowerPriority, parseArgs, pnpm, runMain, step, stop, warn } from './lib/util.mjs';

const USAGE = 'node scripts/fork/sync-upstream.mjs [--tag vX.Y.Z] [--skip-tests]';
const FORK_TESTS = [
  'packages/electron/src/main/services/__tests__/autoUpdater.forkBuild.test.ts',
  'packages/electron/src/main/services/__tests__/forkUpdateStatus.test.ts',
  'packages/electron/src/main/services/__tests__/autoUpdater.channelPolicy.test.ts',
];

async function latestStableTag() {
  const response = await fetch('https://api.github.com/repos/nimbalyst/nimbalyst/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nimbalyst-fork-sync' },
  });
  if (!response.ok) stop(`GitHub answered ${response.status} for the latest upstream release; pass --tag to choose one.`);
  const release = await response.json();
  if (release.prerelease || release.draft) stop(`the latest release ${release.tag_name} is marked prerelease/draft; refusing.`);
  return release.tag_name;
}

const isAncestor = (a, b) => capture('git', ['merge-base', '--is-ancestor', a, b], { allowFailure: true }).status === 0;

/**
 * Install dependencies for the merged tree, run the tests that guard the
 * fork's hooks, and typecheck everything, at below-normal priority.
 */
export function verifyMergedTree({ skipTests = false } = {}) {
  lowerPriority();
  step('Installing dependencies');
  pnpm(['install', '--frozen-lockfile']);
  if (!skipTests) {
    step("Running the fork's tests");
    pnpm(['exec', 'vitest', '--run', ...FORK_TESTS]);
    step('Typechecking');
    pnpm(['typecheck']);
  }
}

/** True when HEAD is the merge of `tag`, e.g. one finished by hand after conflicts. */
function headMerges(tag) {
  const second = capture('git', ['rev-parse', '-q', '--verify', 'HEAD^2'], { allowFailure: true });
  return second.status === 0 && second.stdout === git('rev-parse', `${tag}^{commit}`);
}

export async function syncUpstream({ tag = null, skipTests = false } = {}) {
  step('Checking the checkout');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'fork/main') stop(`check out fork/main first (on '${branch}').`);
  const dirty = dirtyFiles();
  if (dirty.length) stop(`uncommitted changes in ${dirty.join(', ')}. Commit or set them aside first.`);
  const remotes = git('remote').split(/\r?\n/);
  if (!remotes.includes('upstream')) stop('no "upstream" remote. Add it: git remote add upstream https://github.com/nimbalyst/nimbalyst.git');

  step('Fetching');
  git('fetch', 'upstream', '--tags');
  git('fetch', 'origin');
  const ff = capture('git', ['fetch', '.', 'upstream/main:main'], { allowFailure: true });
  if (ff.status === 0) info('main mirror fast-forwarded to upstream/main.');
  else warn(`could not fast-forward the local main mirror (${ff.stderr || 'diverged?'}); leaving it as is.`);

  const target = tag ?? (await latestStableTag());
  if (capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${target}`], { allowFailure: true }).status !== 0) {
    stop(`tag ${target} not found after fetching upstream.`);
  }
  const current = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD');
  info(`fork/main is based on ${current}; newest stable upstream release is ${target}.`);
  if (isAncestor(target, 'HEAD')) {
    if (headMerges(target)) {
      // The merge was finished by hand after conflicts: the dependencies and
      // the hook-guard tests have not run against it yet.
      info(`HEAD is the merge of ${target}; checking it.`);
      verifyMergedTree({ skipTests });
      return { merged: true, tag: target };
    }
    info(`fork/main already contains ${target}. Nothing to merge.`);
    return { merged: false, tag: target };
  }
  if (!isAncestor(current, target)) warn(`${target} does not descend from ${current}; check that this is the release you want.`);

  // Builds and typechecks rewrite these generated files in place. Upstream
  // releases change them too, and git refuses a merge over local changes, so
  // put them back to the committed version; the next build regenerates them.
  const generatedChanged = git('diff', '--name-only', '--', ...GENERATED_PATHS);
  if (generatedChanged) {
    info(`Resetting ${generatedChanged.split(/\r?\n/).length} regenerated build-output file(s) under ${GENERATED_PATHS.join(', ')} to the committed version.`);
    git('restore', '--worktree', '--', ...GENERATED_PATHS);
  }

  step(`Merging ${target} into fork/main`);
  const merge = capture('git', ['merge', '--no-ff', '-m', `Merge upstream release ${target} into fork/main`, target], { allowFailure: true });
  if (merge.status !== 0) {
    const conflicts = capture('git', ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).stdout;
    console.error(`\nThe merge of ${target} stopped with conflicts in:\n${conflicts.split(/\r?\n/).filter(Boolean).map((f) => `  ${f}`).join('\n') || `  (none listed)\n${merge.stdout}\n${merge.stderr}`}`);
    console.error('\nThe merge is left in progress. Resolve each file (see "Resolving conflicts" in FORK.md),');
    console.error('then `git add` them and `git commit --no-edit`, and run this script again. Or undo with `git merge --abort`.');
    stop('merge conflicts need resolving.');
  }
  info(`Merged ${target}.`);
  verifyMergedTree({ skipTests });
  return { merged: true, tag: target };
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  runMain(async () => {
    const args = parseArgs(process.argv.slice(2), {
      tag: { type: 'string', default: null },
      skipTests: { type: 'boolean', default: false },
    });
    if (args.help) { console.log(USAGE); return 0; }
    const result = await syncUpstream(args);
    console.log(result.merged
      ? `\nfork/main now includes ${result.tag}. Next: node scripts/fork/build.mjs (or run update.mjs to build and smoke-test), then push: node scripts/fork/push.mjs`
      : '\nUp to date.');
    return 0;
  });
}
