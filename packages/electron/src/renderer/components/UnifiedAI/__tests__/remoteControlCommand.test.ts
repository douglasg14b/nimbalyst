// @vitest-environment node
/**
 * `/rc` and `/remote-control` (GH #1480): intercepted for Claude Agent
 * sessions only, never sent to the model, and routed to the main process with
 * `announce` so the outcome lands in the transcript.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { remoteControlAtomFamily } from '../../../store/atoms/remoteControl';
import { parseRemoteControlCommand, remoteControlCommandFor, runRemoteControlCommand } from '../remoteControlCommand';

describe('parseRemoteControlCommand', () => {
  it.each([
    ['/rc', { action: 'enable' }],
    ['/remote-control', { action: 'enable' }],
    ['  /rc   ', { action: 'enable' }],
    ['/rc my laptop', { action: 'enable', name: 'my laptop' }],
    ['/remote-control desk', { action: 'enable', name: 'desk' }],
    ['/rc off', { action: 'disable' }],
    ['/remote-control OFF', { action: 'disable' }],
    ['/rc stop', { action: 'disable' }],
  ])('reads %j', (draft, expected) => {
    expect(parseRemoteControlCommand(draft)).toEqual(expected);
  });

  it.each(['/rcx', '/remote', 'rc', 'please /rc', '/rename', '/remote-controller'])('ignores %j', (draft) => {
    expect(parseRemoteControlCommand(draft)).toBeNull();
  });
});

describe('remoteControlCommandFor', () => {
  it('intercepts only in Claude Agent sessions', () => {
    expect(remoteControlCommandFor('claude-code', '/rc')).toEqual({ action: 'enable' });
    // Codex has no bridge; the terminal CLI handles /remote-control itself.
    expect(remoteControlCommandFor('openai-codex', '/rc')).toBeNull();
    expect(remoteControlCommandFor('claude-code-cli', '/remote-control')).toBeNull();
    expect(remoteControlCommandFor(undefined, '/rc')).toBeNull();
  });
});

describe('runRemoteControlCommand', () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('asks main to announce the outcome and stores the returned snapshot', async () => {
    const snapshot = {
      sessionId: 's1', supported: true, active: true, desired: true, state: 'ready',
      sessionUrl: 'https://claude.ai/code/session_x', name: 'desk', error: null,
    };
    const invoke = vi.fn(async () => ({ success: true, snapshot }));
    (globalThis as any).window = { electronAPI: { invoke } };

    await runRemoteControlCommand({ sessionId: 's1', provider: 'claude-code', workspacePath: '/repo', command: { action: 'enable', name: 'desk' } });

    expect(invoke).toHaveBeenCalledWith('ai:remote-control:enable', {
      sessionId: 's1', provider: 'claude-code', name: 'desk', announce: true, workspacePath: '/repo',
    });
    expect(store.get(remoteControlAtomFamily('s1'))).toEqual(snapshot);
  });

  it('routes /rc off to disable', async () => {
    const invoke = vi.fn(async () => null);
    (globalThis as any).window = { electronAPI: { invoke } };

    await runRemoteControlCommand({ sessionId: 's1', provider: 'claude-code', workspacePath: '/repo', command: { action: 'disable' } });

    expect(invoke).toHaveBeenCalledWith('ai:remote-control:disable', expect.objectContaining({ announce: true }));
  });
});
