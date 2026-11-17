// @vitest-environment node
/**
 * A prompt sent through Remote Control while the session is idle must run as
 * an ordinary turn (GH #1480). The guard is the inverse of the teammate wake:
 * an ended session is the normal case, and an active one means a turn already
 * reads the stream.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteControlWakeListener,
  runStrandedRemoteControlTurn,
  type RemoteControlWakeDeps,
  type StrandedRemoteTurnDeps,
} from '../remoteControlWake';

function setup(overrides: Partial<RemoteControlWakeDeps> = {}) {
  const window = { isDestroyed: () => false };
  const deps: RemoteControlWakeDeps = {
    isSessionActive: () => false,
    hasPendingRemoteTurn: () => true,
    startSession: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    turnWorkspacePath: () => '/repo_worktrees/feature',
    resolveOwnerWorkspacePath: async () => '/repo',
    findWindow: () => window,
    sendMessage: vi.fn(async () => {}),
    defer: (fn) => fn(),
    delay: async () => {},
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
    ...overrides,
  };
  return { deps, wake: createRemoteControlWakeListener(deps) };
}

describe('Remote Control wake', () => {
  it('runs the remote prompt as a turn on an idle session, flagged as a remote turn', async () => {
    const { deps, wake } = setup();
    await wake({ sessionId: 's1', text: 'from phone' });

    expect(deps.startSession).toHaveBeenCalledWith({ sessionId: 's1', workspacePath: '/repo' });
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.anything(), 'from phone', 's1', '/repo', { promptOrigin: 'remote_control' });
  });

  it('waits for a just-finished turn to settle before waking', async () => {
    let checks = 0;
    const { deps, wake } = setup({ isSessionActive: () => ++checks < 3 });
    await wake({ sessionId: 's1', text: 'from phone' });
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the prompt to a turn that is running', async () => {
    const { deps, wake } = setup({ isSessionActive: () => true });
    await wake({ sessionId: 's1', text: 'from phone' });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing when another turn already took the remote prompt', async () => {
    const { deps, wake } = setup({ hasPendingRemoteTurn: () => false });
    await wake({ sessionId: 's1', text: 'from phone' });
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does not leave the session marked running when the send fails', async () => {
    const { deps, wake } = setup({ sendMessage: vi.fn(async () => { throw new Error('boom'); }) });
    await wake({ sessionId: 's1', text: 'from phone' });
    await vi.waitFor(() => expect(deps.endSession).toHaveBeenCalledWith('s1'));
  });
});

/**
 * A wake that could not run leaves the phone's prompt pending on the parked
 * process. The next local prompt must not be sent on top of it: the remote turn
 * runs first, as its own turn, so each answer lands under its own prompt.
 */
describe('runStrandedRemoteControlTurn', () => {
  function strandedDeps(overrides: Partial<StrandedRemoteTurnDeps> = {}) {
    const order: string[] = [];
    const deps: StrandedRemoteTurnDeps = {
      isSessionActive: () => false,
      pendingRemoteTurnText: () => 'from phone',
      runRemoteTurn: vi.fn(async (text: string) => { order.push(`remote:${text}`); }),
      logInfo: () => {},
      logError: () => {},
      ...overrides,
    };
    return { deps, order };
  }

  it('runs a pending remote turn to completion before the local prompt', async () => {
    const { deps, order } = strandedDeps();
    await runStrandedRemoteControlTurn('s1', undefined, deps);
    order.push('local');
    expect(order).toEqual(['remote:from phone', 'local']);
  });

  it('does nothing when nothing is pending, for a remote send itself, or while a wake owns the session', async () => {
    for (const [origin, overrides] of [
      [undefined, { pendingRemoteTurnText: () => null }],
      ['remote_control', {}],
      [undefined, { isSessionActive: () => true }],
    ] as const) {
      const { deps } = strandedDeps(overrides);
      await runStrandedRemoteControlTurn('s1', origin, deps);
      expect(deps.runRemoteTurn).not.toHaveBeenCalled();
    }
  });

  it('still lets the local prompt run when the remote turn fails', async () => {
    const logError = vi.fn();
    const { deps } = strandedDeps({ runRemoteTurn: vi.fn(async () => { throw new Error('boom'); }), logError });
    await expect(runStrandedRemoteControlTurn('s1', undefined, deps)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });
});
