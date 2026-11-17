---
description: Fork only. Merge a new stable upstream Nimbalyst release into fork/main, then build, test, push and publish a fork release
---
**Arguments**: `{{arg1}}` (all optional, any order)
- `vX.Y.Z`: merge this upstream release tag instead of the newest stable one.
- `force`: publish the current `fork/main` even when upstream has no new release (for example, after merging a fork topic branch).
- `no-release`: stop after pushing; publish no GitHub Release.

This repository is a personal fork of `nimbalyst/nimbalyst`. Your job is to bring `fork/main` up to upstream's newest **stable** release and mint a fork release from it. If there is no new upstream release, there is nothing to do. Read [FORK.md](../../FORK.md) first. It is the reference for every script named here, and this command does not repeat it.

## Hard rules

You are almost certainly running inside the very Nimbalyst install this fork replaces. Running sessions, the user's included, depend on it.

- **Never install, and never stop the app.**
  - Never run `scripts/fork/install.mjs` except with `--dry-run`.
  - Never run a Nimbalyst installer.
  - Never stop, kill or restart any Nimbalyst process. `smoke-test.mjs` closes only its own test executable, which is fine.
  - Never write to the live data folder (`%APPDATA%\@nimbalyst\electron` on Windows).
  - Installing is the user's step, with Nimbalyst closed.
- **Run one heavy job at a time, in the foreground.**
  - The heavy jobs are `pnpm install`, typecheck, `build.mjs`, `smoke-test.mjs` and pushes (the pre-push hook typechecks).
  - Never run two at once, in parallel tool calls, or in background agents. The scripts lower their own priority.
  - Running them in parallel has crashed the live app before.
- **Upstream is read-only.**
  - Write to `origin` only, through `scripts/fork/push.mjs` and `scripts/fork/release.mjs`. They authenticate as the fork's owner for that one command.
  - Never push to `upstream`. Never open, comment on or review PRs or issues upstream. Never run `gh auth switch`.
- **Use only merges.**
  - Merge only upstream **release tags**, never `upstream/main` and never a prerelease. Never rebase.
  - Never commit to `main`, the mirror of `upstream/main`.
- **Leave the safety checks on.**
  - Never use `--no-verify`, force-push, `git reset`, `git stash` or `git add -A`.
  - If a hook or script refuses, stop and report. Do not work around it.
- **Commit no generated or local files.**
  - Never commit regenerated output (`packages/electron/resources/generated`, `packages/collab-bundle/types`) or anything under `nimbalyst-local/`.
  - Never edit `CHANGELOG.md` or `docs/FEATURE_INVENTORY.md`.

## 1. Check the checkout

- `git status` must show `fork/main` and no uncommitted changes except regenerated output.
- If another branch is checked out with a clean tree, `git checkout fork/main`.
- If there are real uncommitted changes, stop and report them. They may be another session's work.
- If a merge is already in progress (`git status` says "You have unmerged paths" or "All conflicts fixed"), continue at step 3.

## 2. Merge the release

Run `node scripts/fork/sync-upstream.mjs`, adding `--tag vX.Y.Z` if one was given. It fetches, fast-forwards `main`, picks the newest stable release and merges it. It then runs `pnpm install`, the fork's tests and the full typecheck.

- **"Up to date."**
  - Without `force`, stop here and report: no new upstream release, the version `fork/main` is on, and the newest upstream prereleases (`gh release list -R nimbalyst/nimbalyst --limit 5`).
  - If `git tag --points-at HEAD --list "fork-v*"` is empty, also say that `fork/main` has unreleased fork commits, and that `/fork-update force` would publish them.
  - With `force`, go to step 4.
- **Merge conflicts:** go to step 3.
- **Tests or typecheck failed after a clean merge:**
  - Upstream changed something a fork hook relies on.
  - Fix it only inside the files in FORK.md's "What differs from upstream" table and the fork-only files it lists. Commit the fix on `fork/main` with a one-sentence message, then re-run the script.
  - If the fix would need changes anywhere else, stop and report.
- **Anything else:** stop and report the output.

## 3. Resolve conflicts

List the conflicted files: `git diff --name-only --diff-filter=U`. Then sort them.

**Files you may resolve:** only those in the tables in FORK.md's "What differs from upstream" section. Those are the fork's known changes.

For each of these files:
1. See exactly what the fork added: `git diff <previous upstream tag> <branch> -- <file>`, where `<branch>` is the branch the table names for that file (`fork/self-managed-install` for the first table). The previous tag is the base that `sync-upstream.mjs` printed ("fork/main is based on ..."). A file can be in more than one branch; re-apply each branch's change.
2. Take upstream's version: `git checkout --theirs -- <file>`.
3. Re-apply the fork's lines to it with the Edit tool. Keep upstream's code everywhere else. Keep each hook's behaviour: with the fork flag set, nothing may reach the official updater.
4. Check that no conflict markers remain, then `git add <file>`.

**Stop and report instead of resolving** in any of these cases. Leave the merge in progress, and tell the user that `git merge --abort` undoes it:
- a conflict in any other file (lockfiles, migrations, the rest of upstream's code);
- upstream deleted or renamed a hooked file;
- the code a hook attaches to is gone or restructured, so the right place for it is not obvious;
- you are unsure in any other way.

When every conflict is resolved:
- `git commit --no-edit`. The pre-commit hook runs; let it.
- Re-run `node scripts/fork/sync-upstream.mjs`. It recognises the hand-finished merge and runs install, the fork's tests and the typecheck on it.
- If these fail, treat them as in step 2.

## 4. Build and smoke-test

After a merge, run these one at a time:

1. `node scripts/fork/build.mjs --skip-install`.
2. `node scripts/fork/smoke-test.mjs`. It boots the build on an empty scratch profile and records the pass that `release.mjs` requires.

On the `force` path (nothing merged), run `node scripts/fork/update.mjs` instead. It runs install, the fork's tests and the typecheck, then builds and smoke-tests. It skips the build if the last build is already of HEAD.

If either fails, stop and report the failing step and its output. Do not retry the build in a loop.

## 5. Push

Run `node scripts/fork/push.mjs`. It pushes `main` and `fork/main` to `origin`, and the pre-push hook typechecks them.
- If the hook refuses, stop and report its message.
- If it refuses for commit size, `NIMBALYST_LARGE_COMMIT=1` lifts that one check, but only with the user's go-ahead.
- If `push.mjs` says `gh` has no login for the fork owner, stop and tell the user to run `gh auth login` for that account.

## 6. Publish the release

Skip this step with `no-release`.

1. Write release notes to `nimbalyst-local/fork-build/release-notes.md`. Cover:
   - which upstream release was merged, with a link to its upstream release page;
   - which files had conflicts and how each was resolved (or "no conflicts");
   - any hook fix made after the merge.
   The script adds the fork commit, the installer SHA-256, the install instructions and the history.
2. `node scripts/fork/release.mjs --notes-file nimbalyst-local/fork-build/release-notes.md --dry-run`. Check the tag (`fork-v<version>-<n>`), the repository (the fork, never `nimbalyst/nimbalyst`) and the notes.
3. Run the same command without `--dry-run`. It tags, pushes the tag, creates the release and uploads the installer (about 450 MB), `SHA256SUMS.txt` and `fork-build.json`.
4. If an upload fails, re-run the same command. It reuses the tag and uploads only the missing assets.

## 7. Report

End with:
- the upstream release merged, or "no new upstream release";
- conflicts, and how each was resolved, or why you stopped;
- the results of the fork's tests, the typecheck, the build and the smoke test;
- the fork commit, the installer path and SHA-256 (from `nimbalyst-local/fork-build/last-build.json`), and the release URL;
- the user's install step, verbatim:
  > Quit Nimbalyst, including the tray icon. Then, from a normal terminal in this checkout (not inside Nimbalyst): `node scripts/fork/install.mjs`
