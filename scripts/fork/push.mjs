#!/usr/bin/env node
// Push the fork's branches to origin (your fork) as the account that owns it.
// See FORK.md.
//
//   node scripts/fork/push.mjs [--refs "main fork/main"] [--gh-user <login>] [--dry-run]
//
// - Only ever pushes to `origin`, and refuses if origin is the upstream repo.
// - Authenticates with the fork owner's gh token for this one command
//   (gh auth token --user <owner>), without switching the active gh account.
// - Runs at below-normal priority: the repo's pre-push hook runs the full
//   typecheck, a heavy job that must not starve a running Nimbalyst.
// - Never bypasses the hook. If it refuses, the push stops and nothing is sent.
import { GIT_GH_AUTH, capture, forkOwnerEnv, git, info, lowerPriority, originRepo, parseArgs, run, runMain, step, stop } from './lib/util.mjs';

const USAGE = 'node scripts/fork/push.mjs [--refs "main fork/main"] [--gh-user <login>] [--dry-run]';

runMain(async () => {
  const args = parseArgs(process.argv.slice(2), {
    refs: { type: 'string', default: 'main fork/main' },
    ghUser: { type: 'string', default: null },
    dryRun: { type: 'boolean', default: false },
  });
  if (args.help) { console.log(USAGE); return 0; }

  const { owner, repo } = originRepo();
  const refs = args.refs.split(/\s+/).filter(Boolean);
  for (const ref of refs) {
    if (capture('git', ['rev-parse', '-q', '--verify', `refs/heads/${ref}`], { allowFailure: true }).status !== 0) {
      stop(`${ref} is not a local branch.`);
    }
  }
  step(`Pushing ${refs.join(', ')} to ${owner}/${repo}`);
  const env = forkOwnerEnv(args.ghUser ?? owner);
  if (args.dryRun) {
    run('git', [...GIT_GH_AUTH, 'fetch', 'origin'], { env });
    for (const ref of refs) {
      const remote = capture('git', ['rev-parse', '-q', '--verify', `refs/remotes/origin/${ref}`], { allowFailure: true });
      const ahead = remote.status === 0 ? git('rev-list', '--count', `origin/${ref}..${ref}`) : 'all (new branch)';
      info(`${ref}: ${ahead} commit(s) to push`);
    }
    info('Dry run: nothing was pushed.');
    return 0;
  }
  lowerPriority();
  run('git', [...GIT_GH_AUTH, 'push', 'origin', ...refs], { env });
  console.log('\nPushed.');
  return 0;
});
