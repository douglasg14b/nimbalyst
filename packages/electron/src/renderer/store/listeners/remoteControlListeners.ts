/**
 * Central Remote Control listener (GH #1480).
 *
 * Subscribes ONCE to `ai:remote-control:changed` and writes the per-session
 * snapshot to remoteControlAtomFamily. The bridge can drop, reconnect or be
 * restored while a session is idle, so this is not tied to any streaming
 * lifecycle. Components never subscribe to the channel (IPC_LISTENERS rule).
 *
 * Call initRemoteControlListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { remoteControlAtomFamily, type RemoteControlSnapshot } from '../atoms/remoteControl';

let initialized = false;

export function initRemoteControlListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'ai:remote-control:changed',
    (data: RemoteControlSnapshot) => {
      if (!data?.sessionId) return;
      store.set(remoteControlAtomFamily(data.sessionId), data);
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
