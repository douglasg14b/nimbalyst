/**
 * Remote Control atoms (GH #1480).
 *
 * Per-session snapshot of the Remote Control bridge, written by the chip's
 * pull and by the central listener in store/listeners/remoteControlListeners.ts.
 * Components read it; they never subscribe to the IPC channel themselves.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

export type RemoteControlState =
  | 'off'
  | 'connecting'
  | 'ready'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

/** Mirrors RemoteControlSnapshot in main/ipc/RemoteControlHandlers.ts. */
export interface RemoteControlSnapshot {
  sessionId: string;
  supported: boolean;
  active: boolean;
  desired: boolean;
  state: RemoteControlState;
  sessionUrl: string | null;
  name: string | null;
  error: string | null;
}

/** Result of `ai:remote-control:enable` / `:disable`. */
export interface RemoteControlCommandResult {
  success: boolean;
  snapshot: RemoteControlSnapshot;
  error?: string;
}

/** Null means nothing known yet; the chip must not render a state from it. */
export const remoteControlAtomFamily = atomFamily((_sessionId: string) =>
  atom<RemoteControlSnapshot | null>(null)
);

/** Providers whose sessions can bridge to Remote Control. Mirrors the main-process set. */
export const REMOTE_CONTROL_PROVIDERS: ReadonlySet<string> = new Set(['claude-code']);
