# Nimbalyst fork

This is a personal fork of [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst) (MIT). The fork build replaces the official install on one Windows machine and is updated only from this fork, never by the official updater.

## What differs from upstream

| Area | Change | Where |
| --- | --- | --- |
| Updater | In fork builds the electron-updater singleton is never constructed; an inert stub takes its place, so nothing checks, downloads or installs from `nimbalyst/nimbalyst`. That covers the startup and hourly checks, both "Check for Updates..." menu items, the `check-for-updates` / `download-update` / `quit-and-install` IPC, the `update-toast:*` handlers, `release-channel:set`, install-on-quit, and the cached installer in `%LOCALAPPDATA%\@nimbalystelectron-updater`. | `packages/electron/src/main/services/autoUpdater.ts`, `forkInertUpdater.ts` |
| Check for Updates... | Shows a dialog naming the fork commit and pointing at these scripts. | `autoUpdater.ts` (`checkForUpdatesWithUI`) |
| Settings > Advanced | The Release Channel section is replaced by a "Fork build" section showing the fork commit. | `AdvancedPanel.tsx`, `ForkBuildSection.tsx` |
| Build flag | `NIMBALYST_FORK_BUILD` and `NIMBALYST_FORK_COMMIT` are compiled in with `define`, the same way as `OFFICIAL_BUILD`. Upstream builds compile them to off. | `electron.vite.config.ts`, `src/shared/forkBuild.ts` |
| Packaging | Fork builds add `resources\fork-build.json` (the on-disk marker) and point `publish`, and therefore `resources\app-update.yml`, at this fork. | `scripts/fork/electron-builder.fork.cjs` |
| Windows build fix | `normalize-extra-resources.js` creates a directory junction instead of a symlink on Windows, so the build works without Developer Mode or admin rights. | `packages/electron/build/normalize-extra-resources.js` |

Unchanged on purpose: `appId` `com.nimbalyst.electron`, `productName` `Nimbalyst`, package name `@nimbalyst/electron`, the NSIS options, the AppUserModelId and the version. The fork therefore installs into `%LOCALAPPDATA%\Programs\Nimbalyst`, keeps the shortcuts, the `nimbalyst://` protocol, the `.md` association and the notification identity, and uses the existing data in `%APPDATA%\@nimbalyst\electron`.

The regression test is `packages/electron/src/main/services/__tests__/autoUpdater.forkBuild.test.ts`. It fails if any trigger reaches the real electron-updater while the fork flag is set.

## Version

The fork keeps the upstream version unchanged (for example `0.83.0`). Fork identity lives in the commit SHA, which is compiled in, shown in Settings and the update dialog, and written to `resources\fork-build.json`.

Why not a suffix:

- `0.83.0-fork.1` is a semver prerelease, which sorts *below* `0.83.0`.
- `0.83.0+fork.1` is build metadata: semver ignores it, but it is a different string. The app's settings migrations run whenever `lastKnownVersion !== app.getVersion()` (`runMigrations` in `src/main/utils/store.ts`), so every fork rebuild and every rollback would rewrite `app-settings.json`.
- Changing `"version"` in `packages/electron/package.json` conflicts on every upstream release merge.

With the version unchanged, versions only go up, exactly as upstream releases do, as long as fork/main only ever merges release tags.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Exact mirror of `upstream/main`. Never commit to it. |
| `fork/main` | What gets built and installed. Cut from the `v0.83.0` tag, and only ever merges upstream **release tags** (`v0.83.1`, ...), never `upstream/main`, plus the topic branches below. |
| `fork/self-managed-install` | This file, the fork flag, and the build and install scripts. Fork-only. |
| `fork/worktree-auto-commit` | Setting to auto-approve commits into other worktrees. Kept clean for an upstream PR. |
| `fork/remote-control` | Claude Code Remote Control in SDK sessions. Kept clean for an upstream PR. |

Integrate with merge, never rebase. Commits on the two feature branches carry a DCO sign-off (`git commit -s`).

## Syncing with upstream

```powershell
git fetch upstream --tags
git switch main;  git merge --ff-only upstream/main          # keep the mirror exact
git switch fork/main
git merge --no-ff v0.84.0                                    # a release tag, not upstream/main
# Merge upstream into each topic branch too if it conflicts, then re-merge the topic into fork/main.
pnpm install --frozen-lockfile
pnpm typecheck
```

Only merge a tag whose GitHub release is **not** marked prerelease. Alpha tags such as `v0.84.0` (a prerelease when this was written) can carry migrations that the next stable release changes.

## Building

From a normal PowerShell window in the fork checkout, on `fork/main` with a clean tree:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fork\build-win.ps1
```

The script runs the Windows x64 steps from `.github/workflows/electron-build.yml` (tracker packages, extension-sdk, runtime, the three extensions, then `build:win --publish never`) at below-normal CPU priority. It sets the fork flag, clears `OFFICIAL_BUILD`, `CI` and every signing variable, and leaves the build unsigned. It checks that the installer is newer than the run, that `app.asar` carries the fork commit, that the marker matches HEAD, and that `app-update.yml` no longer names the official feed. Then it prints the installer path and SHA-256 and records them in `nimbalyst-local\fork-build\last-build.json`.

Output goes to `%LOCALAPPDATA%\NimbalystForkBuild\release`, outside the checkout: while Nimbalyst has this repo open it locks `.asar` files under `packages\electron\release`, and electron-builder then fails with EPERM or EBUSY.

Then boot the build once on an empty scratch profile (never your real data):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fork\smoke-test.ps1
```

It can run beside a running Nimbalyst. It checks that the app reaches "App ready", that the log shows the inert updater with the expected commit and no update check, and that SQLite initialises. It saves and restores the `nimbalyst://` registration, which a packaged launch re-points at the test exe, and closes only the test build's processes.

Prerequisites, not all documented upstream:

- Node 24 and pnpm 12.9.1 via corepack. Corepack older than 0.36 fails to start pnpm 12 (`Cannot find module ...\pnpm\12.9.1\bin\pnpm.cjs`); run `npm i -g corepack@latest`, and if the cached `.corepack` file still lists `pnpm.cjs`, delete `%LOCALAPPDATA%\node\corepack\v1\pnpm\12.9.1` and let it download again.
- Node 24.19+ has crashed in native-addon GC on this machine. If the build dies in native code, use 24.18.1.
- No signing setup. `build/sign-windows.js` skips signing when DigiCert is not configured and `CI` is not `true`.

## Installing

Quit Nimbalyst first, including the tray icon. Then, from a normal PowerShell window (not inside Nimbalyst):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fork\install.ps1
```

The script:

1. Refuses to run while any Nimbalyst process exists, and lists them. It never stops them.
2. Refuses if a data-redirecting variable (`NIMBALYST_USER_DATA_DIR`, `NIMBALYST_USER_DATA_PATH`, `RUN_ONE_DEV_MODE`, `PLAYWRIGHT`, `ELECTRON_RUN_AS_NODE`) is set at User, Machine or Process scope.
3. Refuses a downgrade: neither the installed version nor `lastKnownVersion` in `app-settings.json` may be newer than the fork's upstream version. This matters because the official updater can install a pending update the moment the official app quits.
4. Copies `%APPDATA%\@nimbalyst\electron` to `%USERPROFILE%\NimbalystBackups\nimbalyst-<timestamp>\electron` with robocopy, skipping only `Cache`, `Code Cache`, `GPUCache` and `Dawn*`. It checks free space first, prints the size, and verifies the file count and byte total afterwards. The live data is only read.
5. Saves rollback material in the same folder: `rollback-info.json` (installed version, exe path, signer), the signed official installer from the updater cache when it matches the installed version, and registry exports of the `nimbalyst://` handler and the uninstall entry.
6. Runs the fork installer with `/S /currentuser`. This is the NSIS upgrade path an official update uses: the installer runs the previous uninstaller with `/S /KEEP_APP_DATA --updated`, which removes only the program folder, and keeps the shortcuts. App data is deleted only with `--delete-app-data` or `deleteAppDataOnUninstall`, and neither is used.
7. Verifies the installed exe version, the fork marker and commit, the fork flag in `app.asar`, `app-update.yml`, and that no file in the data folder changed size or timestamp during the install.

`-BackupOnly` takes and verifies the backup without installing. `-Interactive` shows the normal installer UI.

## Rolling back

1. Quit Nimbalyst.
2. Run the official installer for the version you had: the copy in the backup folder if the script saved one, otherwise the asset from the [GitHub release](https://github.com/nimbalyst/nimbalyst/releases) (`Nimbalyst-Windows-x64.exe`). It upgrades in place over the fork the same way, and keeps the data.
3. The data does not need restoring. The fork reads and writes it in the same format as the upstream version it is based on, and the version string is unchanged, so not even the settings migrations run. Restore the backup only if something is actually missing: with Nimbalyst closed, copy `<backup>\electron` back over `%APPDATA%\@nimbalyst\electron`.

After a rollback the official updater is active again and will offer newer official releases.

## Updating later

Merge the next stable upstream release tag into `fork/main` (see Syncing), merge or re-merge the topic branches, then run `build-win.ps1` and `install.ps1`.

Pulling updates from GitHub Releases on this fork is not worth it. The Windows updater verifies the installer's Authenticode signature against `NIMBALYST, INC.` (`src/main/services/windowsSignatureVerifier.ts`), and unsigned fork builds fail it. Making that work means either a code-signing certificate or switching signature verification off, which is a security downgrade for an auto-installing updater. It would also need a CI pipeline to publish releases and a re-enabled updater, and the two scripts already do the job.

## Known risks

- **Official builds still work as before.** Running an official installer, by hand or from an old download, replaces the fork. That is the rollback path, not a bug.
- **Analytics.** `OFFICIAL_BUILD` does not gate whether analytics are sent; the "Usage analytics" setting does. It only tags events: non-official builds mark the PostHog person `is_dev_user` (permanently, via `$set_once`) and stamp `build_type: local`. The fork leaves `OFFICIAL_BUILD` unset, so it does not pose as an official build. Nothing else, including sign-in, sync and mobile pairing, reads it. Turn analytics off in Settings if you do not want a fork build reporting to upstream's PostHog.
- **Unsigned binaries.** SmartScreen may warn on first run of the installer, and Windows notifications still use the `com.nimbalyst.electron` identity.
- **Data migrations.** Merging a release brings its schema migrations, which run on first launch of the new build, exactly as with an official update. Rolling back across such a release is as unsafe as with official builds; restore the pre-install backup in that case.
- **Prerelease tags.** Merging an alpha tag can apply migrations that a later stable release changes. Merge stable tags only.
