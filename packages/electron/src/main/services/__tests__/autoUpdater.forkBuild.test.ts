// @vitest-environment node
// Fork builds (FORK.md) must never check, download or install from the
// official nimbalyst/nimbalyst feed. The guarantee is that electron-updater's
// lazily constructed real updater is never read at all, so this mocks the
// package with a getter that counts reads and hands back a real-looking
// updater whose every method fails the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getterReads: 0,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('events');
  const forbidden = (name: string) => () => {
    throw new Error(`real electron-updater ${name}() called`);
  };
  const real = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(forbidden('setFeedURL')),
    checkForUpdates: vi.fn(forbidden('checkForUpdates')),
    checkForUpdatesAndNotify: vi.fn(forbidden('checkForUpdatesAndNotify')),
    downloadUpdate: vi.fn(forbidden('downloadUpdate')),
    quitAndInstall: vi.fn(forbidden('quitAndInstall')),
  });
  return {
    get autoUpdater() {
      h.getterReads++;
      return real;
    },
  };
});
vi.mock('../../utils/store', () => ({
  getReleaseChannel: () => 'stable',
  store: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
  safeOn: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.83.0',
    getName: () => '@nimbalyst/electron',
    getPath: () => 'C:\\scratch',
    removeAllListeners: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));
vi.mock('electron-log/main', () => ({
  default: { transports: { file: {} }, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../ipc/SessionStateHandlers', () => ({ hasActiveStreamingSessions: () => false }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: () => () => {} }),
}));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../electronUpdaterPatch', () => ({ installAtomFeedFilter: vi.fn() }));
vi.mock('../windowsSignatureVerifier', () => ({ createWindowsSignatureVerifier: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true), rmSync: vi.fn(), unlinkSync: vi.fn() };
});

async function loadService() {
  vi.resetModules();
  h.getterReads = 0;
  h.handlers.clear();
  return import('../autoUpdater');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('fork build updater', () => {
  it('never constructs the real updater, whatever is triggered', async () => {
    vi.stubEnv('NIMBALYST_FORK_BUILD', 'true');
    vi.stubEnv('NIMBALYST_FORK_COMMIT', 'abc1234');
    const { autoUpdaterService } = await loadService();
    const electron = await import('electron');
    const fs = await import('fs');

    autoUpdaterService.startAutoUpdateCheck(60);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    autoUpdaterService.reconfigureFeedURL();
    await autoUpdaterService.checkForUpdates();
    await autoUpdaterService.checkForUpdatesWithUI();

    for (const [channel, handler] of h.handlers) {
      if (channel.startsWith('test:')) continue;
      await handler({}, '0.84.0');
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect([...h.handlers.keys()]).toEqual(
      expect.arrayContaining([
        'check-for-updates',
        'download-update',
        'quit-and-install',
        'update-toast:download',
        'update-toast:install',
        'update-toast:install-when-idle',
      ]),
    );
    expect(h.getterReads).toBe(0);
    // No quit-and-install teardown and no deletion of the official updater cache.
    expect(electron.app.removeAllListeners).not.toHaveBeenCalled();
    expect(electron.app.exit).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    // "Check for Updates..." explains where fork updates come from.
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const options = vi.mocked(electron.dialog.showMessageBox).mock.calls[0].at(-1) as unknown as { detail: string };
    expect(options.detail).toContain('abc1234');
    expect(options.detail).toContain('scripts/fork/install.ps1');
  });

  it('constructs the real updater when the flag is not set (proves the mock bites)', async () => {
    vi.stubEnv('NIMBALYST_FORK_BUILD', 'false');
    await expect(loadService()).rejects.toThrow(/real electron-updater setFeedURL\(\) called/);
    expect(h.getterReads).toBeGreaterThan(0);
  });
});
