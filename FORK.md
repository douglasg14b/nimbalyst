# Nimbalyst fork

This is a personal fork of [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst) (MIT). The fork build replaces the official install and is updated only from this fork, never by the official updater. The scripts are Node, so nothing ties them to one OS; only Windows is implemented so far (see [Other operating systems](#other-operating-systems)).

## Day-to-day commands

All from the fork checkout, on `fork/main`:

| Task | Command |
| --- | --- |
| Update to the newest stable upstream release, build, smoke-test | `node scripts/fork/update.mjs` |
| Only merge the newest upstream release | `node scripts/fork/sync-upstream.mjs` |
| Build the installer | `node scripts/fork/build.mjs` |
| Boot the build on an empty scratch profile | `node scripts/fork/smoke-test.mjs` |
| Rehearse the install (read-only, safe while Nimbalyst runs) | `node scripts/fork/install.mjs --dry-run` |
| Install (Nimbalyst closed, normal terminal) | `node scripts/fork/install.mjs` |
| Push `main` and `fork/main` to your fork | `node scripts/fork/push.mjs` |
| Publish the smoke-tested build as a GitHub Release on your fork | `node scripts/fork/release.mjs` |
| Have an agent do the whole update and publish | `/fork-update` in a Claude Code or Nimbalyst session |

Every script takes `--help`.

## How you learn about updates

The installed fork build never downloads or installs anything. Twice a day (first check one minute after launch) it asks GitHub two questions:

- Has upstream published a **stable** release newer than the version this build is based on?
- Does this fork's `fork/main` have commits the installed build does not contain (for example, changes you pushed from another machine)?

If either answer is yes, it shows one Windows notification per new state ("Nimbalyst fork: update available"); clicking it opens the details. **Help > Check for Updates...** shows the same status on demand, plus the fork commit and the commands. Nothing happens to the app until you run `update.mjs` and `install.mjs`.

Pulling or fetching in the checkout changes nothing in the installed app either; only `build.mjs` + `install.mjs` do.

## What differs from upstream

The fork's footprint in upstream files is kept to a few one-line hooks. Everything else is in new files, which cannot conflict.

| Upstream file touched | Change |
| --- | --- |
| `packages/electron/src/main/services/autoUpdater.ts` | Binds an inert stub instead of electron-updater's lazily created singleton when the fork flag is set, and short-circuits the feed setup, polling, cache cleanup, quit-and-install and "Check for Updates..." paths. |
| `packages/electron/electron.vite.config.ts` | Compiles in `NIMBALYST_FORK_BUILD`, `NIMBALYST_FORK_COMMIT` and `NIMBALYST_FORK_REPO` next to `OFFICIAL_BUILD`. Upstream builds compile them to off. |
| `packages/electron/src/renderer/components/GlobalSettings/panels/AdvancedPanel.tsx` | Shows a "Fork build" section (with the commit) instead of the Release Channel section. |
| `packages/electron/build/normalize-extra-resources.js` | Windows build fix: a directory junction instead of a symlink, so the build works without Developer Mode or admin. Worth offering upstream. |

New, fork-only files: `src/shared/forkBuild.ts`, `src/main/services/forkInertUpdater.ts`, `forkUpdateNotice.ts`, `forkUpdateStatus.ts`, `ForkBuildSection.tsx`, their tests, `scripts/fork/`, `.claude/commands/fork-update.md`, and this file.

With the flag set, nothing can check, download or install from `nimbalyst/nimbalyst`: the startup and hourly checks, both "Check for Updates..." menu items, the `check-for-updates` / `download-update` / `quit-and-install` IPC, the `update-toast:*` handlers, `release-channel:set`, install-on-quit, and the cached installer in the official updater's cache folder all land on the stub. `resources/app-update.yml` names this fork instead of the official feed as a second line of defence.

Unchanged on purpose: `appId` `com.nimbalyst.electron`, `productName` `Nimbalyst`, package name `@nimbalyst/electron`, the installer options, the AppUserModelId and the version. So the fork installs over the official app in place and uses the same data folder (`%APPDATA%\@nimbalyst\electron` on Windows).

Tests that guard the fork: `autoUpdater.forkBuild.test.ts` (fails if any trigger reaches the real updater with the flag set) and `forkUpdateStatus.test.ts` (the notice's decisions). `sync-upstream.mjs` runs both, plus the full typecheck, after every merge, including a merge finished by hand after conflicts. `update.mjs` runs them before any other build.

## Version

The fork keeps the upstream version unchanged (for example `0.83.0`). Fork identity is the commit SHA: compiled in, shown in Settings and the update dialog, and written to `resources/fork-build.json`.

Why not a suffix:

- `0.83.0-fork.1` is a semver prerelease, which sorts *below* `0.83.0`.
- `0.83.0+fork.1` is build metadata: semver ignores it, but it is a different string. The app's settings migrations run whenever `lastKnownVersion !== app.getVersion()` (`runMigrations` in `src/main/utils/store.ts`), so every rebuild and every rollback would rewrite `app-settings.json`.
- Changing `"version"` in `packages/electron/package.json` conflicts on every upstream release merge.

Merging only release tags keeps versions moving forward exactly as upstream's do.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Exact mirror of `upstream/main`. Never commit to it; `sync-upstream.mjs` fast-forwards it. |
| `fork/main` | What gets built and installed. Cut from the `v0.83.0` tag. Takes upstream **release tags** only (never `upstream/main`), plus the topic branches below. |
| `fork/self-managed-install` | The fork flag, update notice, scripts and this file. Fork-only. |
| `fork/worktree-auto-commit` | Setting to auto-approve commits into other worktrees. Kept clean for an upstream PR. |
| `fork/remote-control` | Claude Code Remote Control in SDK sessions. Kept clean for an upstream PR. |

Integrate with merge, never rebase. Feature-branch commits carry a DCO sign-off (`git commit -s`).

## Updating to a new upstream release

```
node scripts/fork/update.mjs
```

It runs `sync-upstream.mjs` (fetch, fast-forward `main`, merge the newest stable release tag into `fork/main`, `pnpm install`, the fork's tests, the typecheck), then `build.mjs` and `smoke-test.mjs`, and finally tells you to push, publish if you want, quit Nimbalyst and run `install.mjs`. Prerelease tags (alpha builds such as `v0.84.0` when this was written) are never picked; `--tag vX.Y.Z` overrides the choice.

### With an agent

`/fork-update` ([.claude/commands/fork-update.md](.claude/commands/fork-update.md)) has an agent do the same, end to end. It merges, resolves conflicts in the hooked files listed above (and stops on any other conflict), builds, smoke-tests, pushes with `push.mjs`, publishes with `release.mjs`, and reports. If there is no new stable upstream release, it stops at once. `/fork-update force` publishes the current `fork/main` anyway, and `no-release` skips publishing. The agent never installs and never stops Nimbalyst, so it can run inside Nimbalyst; installing stays your step.

### Resolving conflicts

If the merge stops, the script lists the conflicted files and leaves the merge in progress. Conflicts from the fork can only be in the upstream files in the table above. For each one:

1. Take upstream's version of the code (`git checkout --theirs -- <file>` takes it wholesale).
2. Re-apply the fork's hook. `git diff <previous upstream tag> fork/self-managed-install -- <file>` shows exactly what the fork added. In `autoUpdater.ts` that is the `const autoUpdater = isForkBuild() ? createInertUpdater() : electronAutoUpdater;` binding, the imports, and each `if (isForkBuild())` early return; in the other files, a few marked lines.
3. `git add <file>`, then `git commit --no-edit` to finish the merge, and re-run `node scripts/fork/update.mjs`. It recognises the hand-finished merge and runs the fork's tests and the typecheck, which fail if a hook was lost.

`git merge --abort` undoes the attempt.

Regenerated build output (third-party license files, `packages/collab-bundle/types`) is reset to the committed version before merging, never committed on fork branches, and does not count as an uncommitted change.

## Building

`node scripts/fork/build.mjs` runs the steps from `.github/workflows/electron-build.yml` for the platform (tracker packages, extension-sdk, runtime, the three extensions, then the electron-builder script with `--publish never`) at below-normal CPU priority. It sets the fork flag, clears `OFFICIAL_BUILD`, `CI` and every signing variable, and leaves the build unsigned. It stops on the first failing step, then checks that the installer is newer than the run, that `app.asar` carries the fork commit, that the marker matches HEAD and that `app-update.yml` no longer names the official feed. The result (path, SHA-256, commit) goes to `nimbalyst-local/fork-build/last-build.json`, which the other scripts read.

Output goes outside the checkout (`%LOCALAPPDATA%\NimbalystForkBuild\release` on Windows): while Nimbalyst has this repo open it locks `.asar` files under `packages/electron/release`, and electron-builder then fails with EPERM or EBUSY.

`node scripts/fork/smoke-test.mjs` then boots the build on a new, empty profile (never your data), even beside a running Nimbalyst. It checks "App ready", the inert-updater log line with the expected commit, no official update check, SQLite initialisation, and that nothing was logged into your real data folder. It saves and restores the `nimbalyst://` registration, which a packaged launch re-points at the test exe, and closes only the test build's processes.

Prerequisites, not all documented upstream:

- Node 24 and pnpm 12.9.1 via corepack. Corepack older than 0.36 fails to start pnpm 12 (`Cannot find module ...\pnpm\12.9.1\bin\pnpm.cjs`); run `npm i -g corepack@latest`, and if the cached `.corepack` file still lists `pnpm.cjs`, delete the cached `pnpm\12.9.1` folder and let it download again.
- Node 24.19+ has crashed in native-addon GC on one machine. If the build dies in native code, use 24.18.1.
- No signing setup. `build/sign-windows.js` skips signing when DigiCert is not configured and `CI` is not `true`.

## Installing

Quit Nimbalyst first, including the tray icon; running sessions stop, and their history stays in the database. Then, from a normal terminal (not inside Nimbalyst):

```
node scripts/fork/install.mjs
```

It:

1. Refuses while any Nimbalyst process exists, and lists them. It never stops them.
2. Refuses if a data-redirecting variable (`NIMBALYST_USER_DATA_DIR`, `NIMBALYST_USER_DATA_PATH`, `RUN_ONE_DEV_MODE`, `PLAYWRIGHT`, `ELECTRON_RUN_AS_NODE`) is set for the process, the user or the machine.
3. Refuses a downgrade: neither the installed version nor `lastKnownVersion` in `app-settings.json` may be newer than the fork's upstream version. (The official updater can install a pending update the moment the official app quits.)
4. Copies the data folder to `~/NimbalystBackups/nimbalyst-<timestamp>/`, skipping only `Cache`, `Code Cache`, `GPUCache` and `Dawn*`. It checks free space first, prints the size, and verifies the file count and byte total afterwards. The live data is only read.
5. Saves rollback material in the same folder: `rollback-info.json`, the signed official installer from the updater cache when it matches the installed version, and exports of the `nimbalyst://` handler and the uninstall entry.
6. Runs the fork installer silently in per-user mode (`/S /currentuser`). This is the upgrade path an official update uses: the installer runs the previous uninstaller with `/S /KEEP_APP_DATA --updated`, which removes only the program folder and keeps the shortcuts. App data is deleted only with `--delete-app-data` or `deleteAppDataOnUninstall`, and neither is used.
7. Verifies the installed version, the fork marker and commit, the fork flag in `app.asar`, `app-update.yml`, and that no data file changed size or timestamp during the install.

`--dry-run` runs every check and reports what a real run would stop on, without copying or installing; it is safe while Nimbalyst runs. `--backup-only` takes and verifies the backup without installing. `--interactive` shows the normal installer UI.

## Pushing and publishing

`node scripts/fork/push.mjs` pushes `main` and `fork/main` (`--refs "..."` for others) to `origin`. It authenticates with the token of the GitHub account that owns the fork (`gh auth token --user <owner>`) for that one command only, without switching the active `gh` account, and never falls back to it. It refuses if `origin` is the upstream repository. The repo's pre-push hook runs as usual (it typechecks), at below-normal priority.

`node scripts/fork/release.mjs` publishes a GitHub Release on the fork, for downloads and a record of what was built:

- **What it publishes.** Only the build of `fork/main`'s HEAD, with a clean tree. That build must have passed `smoke-test.mjs`, its installer must still have the recorded SHA-256, and HEAD must already be on `origin/fork/main`.
- **The tag.** It tags the commit `fork-v<upstream version>-<n>`, for example `fork-v0.84.1-1`. It never uses a `v*` tag; those belong to upstream.
- **The assets.** The installer, `SHA256SUMS.txt` and `fork-build.json`. Never `latest.yml` or blockmaps, which would make the fork's releases a live update feed for the official updater.
- **The notes.** Generated, plus anything passed with `--notes-file`. `--dry-run` shows the tag and notes without publishing.
- **Re-running.** If an upload fails, run it again. It reuses the tag and uploads only what is missing.

A downloaded release installer cannot be installed through `install.mjs` yet, because it only trusts installers recorded by `build.mjs` on the same machine. On another machine, build there.

## Rolling back

1. Quit Nimbalyst.
2. Run the official installer for the version you had: the copy in the backup folder if one was saved, otherwise the asset from the [GitHub release](https://github.com/nimbalyst/nimbalyst/releases). It upgrades in place over the fork and keeps the data.
3. The data does not need restoring. The fork reads and writes it in the same format as the upstream version it is based on, and the version string is unchanged, so not even the settings migrations run. Restore the backup only if something is actually missing: with Nimbalyst closed, copy the backed-up `electron` folder back over the data folder.

After a rollback the official updater is active again and will offer newer official releases.

## Why not real auto-update from this fork

The Windows updater verifies the installer's Authenticode signature against `NIMBALYST, INC.` (`src/main/services/windowsSignatureVerifier.ts`), and unsigned fork builds fail it. Making that work means either a code-signing certificate or accepting unsigned installers verified only by the hash in the release metadata, which lets anyone who controls the GitHub account push a self-installing update. It would also need a CI pipeline publishing releases and much more fork code in the updater. The notice plus `update.mjs` gives the same awareness with none of that.

## Other operating systems

The scripts are platform-neutral; everything OS-specific (install and data paths, process listing, installer invocation, the `nimbalyst://` registration, signature checks) is in `scripts/fork/lib/win32.mjs`, behind the contract documented in `scripts/fork/lib/platform.mjs`. To add Linux (AppImage) or macOS, write a sibling `linux.mjs` / `darwin.mjs` with the same members and register it in `platform.mjs`; on an unsupported OS every script stops with "not supported yet". The app-side code (flag, inert updater, notice) is already OS-neutral, though the notice's wording and the electron-builder targets (`build:linux`, `build:mac:local`) need checking per platform.

## Known risks

- **Official installers still work.** Running an official installer, by hand or from an old download, replaces the fork. That is the rollback path, not a bug.
- **Analytics.** `OFFICIAL_BUILD` does not gate whether analytics are sent; the "Usage analytics" setting does. It only tags events: non-official builds mark the analytics person `is_dev_user` (permanently) and stamp `build_type: local`. The fork leaves `OFFICIAL_BUILD` unset, so it does not pose as an official build. Nothing else, including sign-in, sync and mobile pairing, reads it. Turn analytics off in Settings if you do not want a fork build reporting to upstream.
- **Unsigned binaries.** SmartScreen may warn the first time the installer runs.
- **Data migrations.** Merging a release brings its schema migrations, which run on first launch of the new build, exactly as with an official update. Rolling back across such a release is as unsafe as with official builds; restore the pre-install backup in that case.
- **Prerelease tags.** Merging an alpha tag can apply migrations that a later stable release changes. `sync-upstream.mjs` only picks stable releases.
- **Scratch-profile isolation (upstream behaviour).** With `NIMBALYST_USER_DATA_DIR` set, a few early startup log lines still go to the real `logs/main.log`, and the analytics service reads the real `analytics-settings.json` before the redirect applies. Read-only, but worth knowing when running test instances.
