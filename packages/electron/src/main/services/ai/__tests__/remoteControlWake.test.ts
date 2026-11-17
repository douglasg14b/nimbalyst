// @vitest-environment node
/**
 * A prompt sent through Remote Control while the session is idle must run as
 * an ordinary turn (GH #1480). The guard is the inverse of the teammate wake:
 * an ended session is the normal case, and an active one means a turn already
 * reads the stream.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRemoteControlWakeListener, type RemoteControlWakeDeps } from '../remoteControlWake';

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
