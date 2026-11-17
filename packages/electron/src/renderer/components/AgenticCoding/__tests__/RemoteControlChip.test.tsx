// @vitest-environment jsdom
/**
 * Session header control for Remote Control (GH #1480).
 *
 * What these defend: the control only exists where it can work (Claude Agent
 * sessions, never Codex or the claude-code-cli terminal), it never claims a
 * bridge the provider did not report, and it follows pushes (a bridge that
 * drops while idle) through the atom the central listener writes.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteControlAtomFamily, type RemoteControlSnapshot } from '../../../store/atoms/remoteControl';
import { sessionStoreAtom } from '../../../store/atoms/sessions';
import { ActiveSessionRemoteControlChip, RemoteControlChip } from '../RemoteControlChip';

const floatingState = vi.hoisted(() => ({
  current: null as null | { open?: boolean; onOpenChange?: (v: boolean) => void },
}));

vi.mock('@floating-ui/react', () => ({
  autoUpdate: vi.fn(),
  flip: vi.fn(() => ({ name: 'flip' })),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => children,
  offset: vi.fn(() => ({ name: 'offset' })),
  shift: vi.fn(() => ({ name: 'shift' })),
  useClick: vi.fn(() => ({})),
  useDismiss: vi.fn(() => ({})),
  useRole: vi.fn(() => ({})),
  useFloating: vi.fn((options: { open?: boolean; onOpenChange?: (v: boolean) => void }) => {
    floatingState.current = options;
    return { refs: { setReference: vi.fn(), setFloating: vi.fn() }, floatingStyles: {}, context: options };
  }),
  useInteractions: vi.fn(() => ({
    getReferenceProps: (props: Record<string, unknown> = {}) => ({
      ...props,
      onClick: () => {
        const ctx = floatingState.current;
        ctx?.onOpenChange?.(!ctx.open);
      },
    }),
    getFloatingProps: (props: Record<string, unknown> = {}) => props,
  })),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${btoa(text)}`) },
}));

const copyToClipboard = vi.hoisted(() => vi.fn());
vi.mock('@nimbalyst/runtime/utils/clipboard', () => ({ copyToClipboard }));

const SESSION_ID = 'session-1';
const URL = 'https://claude.ai/code/session_x';

function snapshot(overrides: Partial<RemoteControlSnapshot> = {}): RemoteControlSnapshot {
  return {
    sessionId: SESSION_ID,
    supported: true,
    active: true,
    desired: false,
    state: 'off',
    sessionUrl: null,
    name: null,
    error: null,
    ...overrides,
  };
}

const READY = snapshot({ desired: true, state: 'ready', sessionUrl: URL });

let invoke: ReturnType<typeof vi.fn>;

function installApi(pulled: RemoteControlSnapshot, commands: Record<string, unknown> = {}) {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'ai:remote-control:get') return pulled;
    const result = commands[channel];
    if (result instanceof Error) throw result;
    return result;
  });
  (window as any).electronAPI = { invoke, openExternal: vi.fn() };
}

function renderChip(provider = 'claude-code') {
  const store = createStore();
  const result = render(
    <JotaiProvider store={store}>
      <RemoteControlChip sessionId={SESSION_ID} provider={provider} />
    </JotaiProvider>,
  );
  return { store, ...result };
}

const chipState = () => screen.getByTestId('remote-control-chip').getAttribute('data-state');

describe('RemoteControlChip', () => {
  beforeEach(() => {
    installApi(snapshot());
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as any).electronAPI;
  });

  it.each(['openai-codex', 'claude-code-cli'])('renders nothing and asks nothing for %s', (provider) => {
    renderChip(provider);
    expect(screen.queryByTestId('remote-control-chip')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('mounts only for Claude Agent sessions from the header', async () => {
    const store = createStore();
    store.set(sessionStoreAtom(SESSION_ID), { id: SESSION_ID, provider: 'openai-codex' } as never);
    render(
      <JotaiProvider store={store}>
        <ActiveSessionRemoteControlChip sessionId={SESSION_ID} />
      </JotaiProvider>,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId('remote-control-chip')).toBeNull();
  });

  it('stays hidden until the session has a live provider', async () => {
    installApi(snapshot({ active: false }));
    renderChip();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:remote-control:get', { sessionId: SESSION_ID, provider: 'claude-code' }));
    expect(screen.queryByTestId('remote-control-chip')).toBeNull();
  });

  it('turns on from the popover and shows the link and QR code', async () => {
    installApi(snapshot(), { 'ai:remote-control:enable': { success: true, snapshot: READY } });
    renderChip();
    const chip = await screen.findByTestId('remote-control-chip');
    expect(chipState()).toBe('off');

    fireEvent.click(chip);
    await act(async () => { fireEvent.click(screen.getByTestId('remote-control-enable')); });

    expect(invoke).toHaveBeenCalledWith('ai:remote-control:enable', { sessionId: SESSION_ID, provider: 'claude-code' });
    await waitFor(() => expect(chipState()).toBe('ready'));
    const qr = await screen.findByTestId('remote-control-qr');
    expect(atob(qr.getAttribute('src')!.split(',')[1])).toBe(URL);

    fireEvent.click(screen.getByTestId('remote-control-copy'));
    expect(copyToClipboard).toHaveBeenCalledWith(URL);
  });

  it('turns off from the popover', async () => {
    installApi(READY, { 'ai:remote-control:disable': { success: true, snapshot: snapshot() } });
    renderChip();
    await waitFor(() => expect(chipState()).toBe('ready'));

    fireEvent.click(screen.getByTestId('remote-control-chip'));
    await act(async () => { fireEvent.click(screen.getByTestId('remote-control-disable')); });

    expect(invoke).toHaveBeenCalledWith('ai:remote-control:disable', { sessionId: SESSION_ID, provider: 'claude-code' });
    await waitFor(() => expect(chipState()).toBe('off'));
    expect(screen.queryByTestId('remote-control-qr')).toBeNull();
  });

  it('follows a pushed drop: no link is offered once the bridge is down', async () => {
    installApi(READY);
    const { store } = renderChip();
    await waitFor(() => expect(chipState()).toBe('ready'));

    act(() => {
      store.set(remoteControlAtomFamily(SESSION_ID), snapshot({ desired: false, state: 'off' }));
    });
    expect(chipState()).toBe('off');
  });

  it('surfaces a failure instead of silently staying off', async () => {
    installApi(snapshot(), {
      'ai:remote-control:enable': { success: false, error: 'not logged in to claude.ai', snapshot: snapshot() },
    });
    renderChip();
    fireEvent.click(await screen.findByTestId('remote-control-chip'));
    await act(async () => { fireEvent.click(screen.getByTestId('remote-control-enable')); });

    expect((await screen.findByTestId('remote-control-error')).textContent).toBe('not logged in to claude.ai');
  });
});
