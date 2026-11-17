/**
 * Per-session Remote Control IPC (GH #1480).
 *
 * The pull-and-command half of the surface. `ClaudeCodeProvider` owns the
 * bridge (see runtime `providers/claudeCode/remoteControl.ts`); this exposes it
 * to the renderer so a session can be driven from claude.ai/code and the Claude
 * mobile app, and so the header chip and the `/rc` command can show its state.
 *
 * The push half (live transitions) lives in MessageStreamingHandler, where
 * provider event listeners are installed. Both build their payload with
 * `getRemoteControlSnapshot`, so a pushed snapshot and a pulled one agree.
 *
 * Never creates a provider. A session that has not run a turn since the app
 * started has no process to put a bridge on, which reads as `active: false`.
 */

import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import type { AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import {
  REMOTE_CONTROL_OFF,
  remoteControlCarryOver,
  type RemoteControlStatus,
} from '@nimbalyst/runtime/ai/server/providers/claudeCode/remoteControl';
import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';

/** Same broadcast as claudeCliUserPromptLog's: `sessionStateListeners` reloads the transcript. */
function broadcastMessageLogged(sessionId: string, workspacePath: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('ai:message-logged', { sessionId, workspacePath });
    }
  }
}

/**
 * Providers that can bridge a session to Remote Control. Only the Agent SDK
 * path: Codex has no equivalent, and `claude-code-cli` drives a real terminal
 * session that handles `/remote-control` itself.
 */
export const REMOTE_CONTROL_PROVIDERS: ReadonlySet<string> = new Set(['claude-code']);

/** Structural view of the provider methods this module needs. */
interface RemoteControlCapableProvider {
  enableRemoteControl(name?: string): Promise<RemoteControlStatus>;
  disableRemoteControl(): Promise<RemoteControlStatus>;
  getRemoteControlStatus(): RemoteControlStatus;
  hasPendingRemoteControlTurn?(): boolean;
  getPendingRemoteControlTurnText?(): string | null;
  handOffRemoteControlForReplacement?(): void;
}

/** What the renderer gets. Flat; no SDK shapes cross the wire. */
export interface RemoteControlSnapshot extends RemoteControlStatus {
  sessionId: string;
  /** The provider can bridge at all. Unsupported sessions hide the control. */
  supported: boolean;
  /** A live provider exists for this session, so enabling can work now. */
  active: boolean;
}

export interface RemoteControlCommandResult {
  success: boolean;
  snapshot: RemoteControlSnapshot;
  error?: string;
}

function isCapable(provider: unknown): provider is RemoteControlCapableProvider {
  return typeof (provider as RemoteControlCapableProvider)?.getRemoteControlStatus === 'function';
}

/** Cache lookup only: never creates a provider. */
function capableProvider(sessionId: string, provider: string): RemoteControlCapableProvider | null {
  if (!REMOTE_CONTROL_PROVIDERS.has(provider)) return null;
  const instance = ProviderFactory.getProvider(provider as AIProviderType, sessionId);
  return isCapable(instance) ? instance : null;
}

/**
 * Build the renderer payload for a session. Used by the pull handlers and by
 * the push path; both must produce the same snapshot for the same state.
 */
export function getRemoteControlSnapshot(sessionId: string, provider: string): RemoteControlSnapshot {
  const supported = REMOTE_CONTROL_PROVIDERS.has(provider);
  if (!supported) return { sessionId, supported: false, active: false, ...REMOTE_CONTROL_OFF };
  const instance = capableProvider(sessionId, provider);
  if (instance) return { sessionId, supported: true, active: true, ...instance.getRemoteControlStatus() };
  // The provider was replaced (a model change) and the next one has not run a
  // turn yet: still wanted, not up, reattaches on the next message.
  const carry = remoteControlCarryOver.peek(sessionId);
  if (carry) {
    return {
      sessionId,
      supported: true,
      active: false,
      desired: true,
      state: 'disconnected',
      sessionUrl: carry.sessionUrl ?? null,
      name: carry.name ?? null,
      error: null,
    };
  }
  return { sessionId, supported: true, active: false, ...REMOTE_CONTROL_OFF };
}

/** Same snapshot, from a status the provider just emitted. */
export function snapshotFromStatus(sessionId: string, status: RemoteControlStatus): RemoteControlSnapshot {
  return { sessionId, supported: true, active: true, ...status };
}

/** True when a prompt sent through Remote Control is waiting to run as a turn. */
export function hasPendingRemoteControlTurn(sessionId: string): boolean {
  const instance = capableProvider(sessionId, 'claude-code');
  return instance?.hasPendingRemoteControlTurn?.() === true;
}

/** The text of a remote turn still waiting for its wake, or null. Never creates a provider. */
export function pendingRemoteControlTurnText(sessionId: string, provider: string): string | null {
  return capableProvider(sessionId, provider)?.getPendingRemoteControlTurnText?.() ?? null;
}

export interface RemoteControlSnapshotPushDeps {
  resolveWorkspacePath: (sessionId: string) => Promise<string | null>;
  /** Send to the window owning the workspace; false when there is no live one. */
  sendToWorkspace: (workspacePath: string, payload: unknown) => boolean;
  logWarn: (message: string, error: unknown) => void;
}

/**
 * Pushes snapshots to the renderer. Three guarantees: a snapshot resolved late
 * never overwrites a newer one for the same session (the workspace lookup is
 * async, so two pushes can settle out of order); `onlyIfChanged` pushes (the
 * one every turn makes) are dropped when the renderer already has that exact
 * snapshot, so a session with Remote Control off re-renders nothing per turn;
 * and a send to a disposed frame is logged, never an unhandled rejection.
 */
export function createRemoteControlSnapshotPusher(deps: RemoteControlSnapshotPushDeps) {
  let sequence = 0;
  const latest = new Map<string, number>();
  const lastSent = new Map<string, string>();
  return (
    snapshot: RemoteControlSnapshot,
    options: { onlyIfChanged?: boolean; fallback: (payload: unknown) => void },
  ): Promise<void> => {
    const sessionId = snapshot.sessionId;
    const mine = ++sequence;
    latest.set(sessionId, mine);
    return (async () => {
      const workspacePath = await deps.resolveWorkspacePath(sessionId);
      if (latest.get(sessionId) !== mine) return;
      const key = JSON.stringify(snapshot);
      if (options.onlyIfChanged && lastSent.get(sessionId) === key) return;
      lastSent.set(sessionId, key);
      const payload = workspacePath ? { ...snapshot, workspacePath } : snapshot;
      if (!workspacePath || !deps.sendToWorkspace(workspacePath, payload)) options.fallback(payload);
    })().catch((error) => {
      deps.logWarn('[RemoteControl] Failed to push a snapshot', error);
    });
  };
}

/**
 * Call before a session's provider is destroyed to be replaced (a model
 * change), so the replacement reattaches to the same bridge on its first turn.
 */
export function handOffRemoteControlBeforeProviderReplacement(sessionId: string): void {
  capableProvider(sessionId, 'claude-code')?.handOffRemoteControlForReplacement?.();
}

/** A deleted session leaves nothing behind for a future provider to pick up. */
export function forgetRemoteControlForSession(sessionId: string): void {
  remoteControlCarryOver.clear(sessionId);
}

export interface RemoteControlNoticeDeps {
  createMessage: (row: {
    sessionId: string;
    source: 'claude-code';
    direction: 'output';
    content: string;
    hidden: boolean;
    createdAt: Date;
  }) => Promise<unknown>;
  notifyMessageLogged: (sessionId: string, workspacePath: string) => void;
}

const productionNoticeDeps: RemoteControlNoticeDeps = {
  createMessage: (row) => AgentMessagesRepository.create(row),
  notifyMessageLogged: broadcastMessageLogged,
};

/**
 * Show the result of `/rc` in the transcript as a host notice. Rendered by
 * ClaudeCodeRawParser's `system/informational` branch; never sent to the model.
 */
export async function persistRemoteControlNotice(
  sessionId: string,
  workspacePath: string,
  text: string,
  deps: RemoteControlNoticeDeps = productionNoticeDeps,
): Promise<void> {
  await deps.createMessage({
    sessionId,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({ type: 'system', subtype: 'informational', level: 'notice', content: text }),
    hidden: false,
    createdAt: new Date(),
  });
  deps.notifyMessageLogged(sessionId, workspacePath);
}

/** The transcript text for a command's outcome. */
export function remoteControlNoticeText(action: 'enable' | 'disable', result: RemoteControlCommandResult): string {
  if (!result.success) {
    return action === 'enable'
      ? `Remote Control could not start: ${result.error ?? 'unknown error'}`
      : `Remote Control could not be turned off: ${result.error ?? 'unknown error'}`;
  }
  if (action === 'disable') return 'Remote Control is off.';
  const { snapshot } = result;
  if (snapshot.sessionUrl && (snapshot.state === 'ready' || snapshot.state === 'connected')) {
    return `Remote Control is on. Open ${snapshot.sessionUrl} or scan the QR code in the Remote chip to continue this session from your phone or browser.`;
  }
  return 'Remote Control is starting. It connects when this session\'s turn starts; the Remote chip shows the link and QR code.';
}

interface CommandPayload {
  sessionId?: string;
  provider?: string;
  name?: string;
  /** Write the outcome to the transcript (the `/rc` command). Requires workspacePath. */
  announce?: boolean;
  workspacePath?: string;
}

function requireArgs(channel: string, payload: CommandPayload | undefined) {
  if (!payload?.sessionId) throw new Error(`${channel} requires sessionId`);
  if (!payload.provider) throw new Error(`${channel} requires provider`);
  if (payload.announce && !payload.workspacePath) throw new Error(`${channel} with announce requires workspacePath`);
  return { sessionId: payload.sessionId, provider: payload.provider };
}

const NOT_STARTED = 'Remote Control starts once this session has run a turn. Send a message, then try again.';

/** Run enable or disable and describe the outcome. Exported for tests. */
export async function runRemoteControlCommand(
  action: 'enable' | 'disable',
  sessionId: string,
  provider: string,
  name?: string,
): Promise<RemoteControlCommandResult> {
  if (!REMOTE_CONTROL_PROVIDERS.has(provider)) {
    return { success: false, error: 'Remote Control is only available in Claude Agent sessions.', snapshot: getRemoteControlSnapshot(sessionId, provider) };
  }
  const instance = capableProvider(sessionId, provider);
  if (!instance) {
    if (action === 'disable') {
      // Nothing to stop is a success: the caller wanted it off, and it is.
      forgetRemoteControlForSession(sessionId);
      return { success: true, snapshot: getRemoteControlSnapshot(sessionId, provider) };
    }
    return { success: false, error: NOT_STARTED, snapshot: getRemoteControlSnapshot(sessionId, provider) };
  }
  try {
    if (action === 'enable') await instance.enableRemoteControl(name);
    else await instance.disableRemoteControl();
    return { success: true, snapshot: getRemoteControlSnapshot(sessionId, provider) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      snapshot: getRemoteControlSnapshot(sessionId, provider),
    };
  }
}

async function handleCommand(action: 'enable' | 'disable', channel: string, payload: CommandPayload | undefined) {
  const { sessionId, provider } = requireArgs(channel, payload);
  const result = await runRemoteControlCommand(action, sessionId, provider, payload?.name);
  if (payload?.announce && payload.workspacePath) {
    try {
      await persistRemoteControlNotice(sessionId, payload.workspacePath, remoteControlNoticeText(action, result));
    } catch (error) {
      console.error('[RemoteControl] Failed to write the transcript notice:', error);
    }
  }
  return result;
}

export function registerRemoteControlHandlers(): void {
  safeHandle('ai:remote-control:get', async (_event, payload: CommandPayload) => {
    const { sessionId, provider } = requireArgs('ai:remote-control:get', payload);
    return getRemoteControlSnapshot(sessionId, provider);
  });

  safeHandle('ai:remote-control:enable', async (_event, payload: CommandPayload) =>
    handleCommand('enable', 'ai:remote-control:enable', payload));

  safeHandle('ai:remote-control:disable', async (_event, payload: CommandPayload) =>
    handleCommand('disable', 'ai:remote-control:disable', payload));
}
