import { EventEmitter } from 'events';
import type { AppUpdater } from 'electron-updater';

/**
 * Stand-in for electron-updater's `autoUpdater` in fork builds (FORK.md).
 *
 * electron-updater constructs its real updater lazily, on first read of the
 * `autoUpdater` export. autoUpdater.ts binds this stub instead when
 * isForkBuild() is true, so the real updater never exists. That means no
 * GitHub feed, no download, no auto-install on quit, and no reading of a
 * cached installer in %LOCALAPPDATA%\@nimbalystelectron-updater. The service
 * code above it keeps running unchanged; every call lands here and does
 * nothing. Events are never emitted, so no update toast can appear.
 */
export function createInertUpdater(): AppUpdater {
  const updater = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(updater, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: null,
    logger: null,
    setFeedURL: () => {},
    checkForUpdates: async () => null,
    checkForUpdatesAndNotify: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => {},
  });
  return updater as unknown as AppUpdater;
}
