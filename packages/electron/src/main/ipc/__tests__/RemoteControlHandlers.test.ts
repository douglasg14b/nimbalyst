// @vitest-environment node
/**
 * Pull and command paths for per-session Remote Control (GH #1480).
 *
 * The distinctions these defend: "this provider cannot bridge at all" (hide the
 * control), "this session has no live provider yet" (nothing to bridge), and
 * the provider's own honest state. Commands never create a provider, and the
 * `/rc` outcome lands in the transcript as a host notice, not a model prompt.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const getProvider = vi.fn();

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ProviderFactory: {
    getProvider: (...args: unknown[]) => getProvider(...args),
  },
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(async () => {}) },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

import {
  getRemoteControlSnapshot,
  persistRemoteControlNotice,
  remoteControlNoticeText,
  runRemoteControlCommand,
} from '../RemoteControlHandlers';
import { remoteControlCarryOver } from '@nimbalyst/runtime/ai/server/providers/claudeCode/remoteControl';

const READY = {
  desired: true,
  state: 'ready' as const,
  sessionUrl: 'https://claude.ai/code/session_x',
  name: null,
  error: null,
};
const OFF = { desired: false, state: 'off' as const, sessionUrl: null, name: null, error: null };

function providerWith(status: typeof READY | typeof OFF) {
  return {
    enableRemoteControl: vi.fn(async () => READY),
    disableRemoteControl: vi.fn(async () => OFF),
    getRemoteControlStatus: vi.fn(() => status),
  };
}

describe('getRemoteControlSnapshot', () => {
  beforeEach(() => {
    getProvider.mockReset();
    remoteControlCarryOver.clear('s1');
  });

  it('reports the provider\'s bridge with its pairing URL', () => {
    getProvider.mockReturnValue(providerWith(READY));
    expect(getRemoteControlSnapshot('s1', 'claude-code')).toEqual({ sessionId: 's1', supported: true, active: true, ...READY });
  });

  it('separates "not started yet" from "not supported", and never looks up an unsupported provider', () => {
    getProvider.mockReturnValue(undefined);
    expect(getRemoteControlSnapshot('s1', 'claude-code')).toEqual({ sessionId: 's1', supported: true, active: false, ...OFF });

    getProvider.mockClear();
    for (const provider of ['openai-codex', 'claude-code-cli']) {
      expect(getRemoteControlSnapshot('s1', provider)).toMatchObject({ supported: false, active: false, desired: false });
    }
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('treats a provider without the methods as not active', () => {
    getProvider.mockReturnValue({ somethingElse: () => {} });
    expect(getRemoteControlSnapshot('s1', 'claude-code')).toMatchObject({ supported: true, active: false, state: 'off' });
  });

  it('shows a session whose provider was replaced as wanted but down, never connected', () => {
    getProvider.mockReturnValue(undefined);
    remoteControlCarryOver.stash('s1', { name: 'laptop', bridgeSessionId: 'cse_x', sessionUrl: READY.sessionUrl });
    expect(getRemoteControlSnapshot('s1', 'claude-code')).toMatchObject({
      active: false,
      desired: true,
      state: 'disconnected',
      sessionUrl: READY.sessionUrl,
    });
  });
});

describe('runRemoteControlCommand', () => {
  beforeEach(() => {
    getProvider.mockReset();
  });

  it('enables on a live provider and returns the new snapshot', async () => {
    const provider = providerWith(OFF);
    provider.enableRemoteControl.mockImplementation(async () => {
      provider.getRemoteControlStatus.mockReturnValue(READY);
      return READY;
    });
    getProvider.mockReturnValue(provider);

    const result = await runRemoteControlCommand('enable', 's1', 'claude-code', 'laptop');

    expect(provider.enableRemoteControl).toHaveBeenCalledWith('laptop');
    expect(result).toEqual({ success: true, snapshot: { sessionId: 's1', supported: true, active: true, ...READY } });
  });

  it('reports a provider failure instead of throwing', async () => {
    const provider = providerWith(OFF);
    provider.enableRemoteControl.mockRejectedValue(new Error('not logged in to claude.ai'));
    getProvider.mockReturnValue(provider);

    const result = await runRemoteControlCommand('enable', 's1', 'claude-code');

    expect(result.success).toBe(false);
    expect(result.error).toBe('not logged in to claude.ai');
  });

  it('refuses to enable without a live provider, and never creates one', async () => {
    getProvider.mockReturnValue(undefined);
    const result = await runRemoteControlCommand('enable', 's1', 'claude-code');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Send a message/);
  });

  it('treats disabling with nothing to stop as success', async () => {
    getProvider.mockReturnValue(undefined);
    await expect(runRemoteControlCommand('disable', 's1', 'claude-code')).resolves.toMatchObject({ success: true });
  });

  it('refuses on a provider that cannot bridge', async () => {
    const result = await runRemoteControlCommand('enable', 's1', 'openai-codex');
    expect(result.success).toBe(false);
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('the /rc transcript notice', () => {
  it('is written as a system/informational notice row and broadcast', async () => {
    const createMessage = vi.fn(async () => {});
    const notifyMessageLogged = vi.fn();

    await persistRemoteControlNotice('s1', '/repo', 'Remote Control is off.', { createMessage, notifyMessageLogged });

    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      source: 'claude-code',
      direction: 'output',
      hidden: false,
    }));
    const row = (createMessage.mock.calls[0] as unknown as [{ content: string }])[0];
    expect(JSON.parse(row.content)).toEqual({ type: 'system', subtype: 'informational', level: 'notice', content: 'Remote Control is off.' });
    expect(notifyMessageLogged).toHaveBeenCalledWith('s1', '/repo');
  });

  it('describes each outcome', () => {
    const snapshot = { sessionId: 's1', supported: true, active: true, ...READY };
    expect(remoteControlNoticeText('enable', { success: true, snapshot })).toContain(READY.sessionUrl);
    expect(remoteControlNoticeText('enable', { success: false, snapshot, error: 'boom' })).toBe('Remote Control could not start: boom');
    expect(remoteControlNoticeText('disable', { success: true, snapshot })).toBe('Remote Control is off.');
  });
});
