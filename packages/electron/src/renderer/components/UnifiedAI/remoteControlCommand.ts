/**
 * `/remote-control` and `/rc` in a Claude Agent session (GH #1480).
 *
 * An SDK-hosted session would pass these to the model as a prompt, where they
 * do nothing: Remote Control auto-connect only covers interactive CLI
 * sessions. The composer intercepts them instead and asks the main process to
 * start or stop the bridge; the outcome is written to the transcript as a host
 * notice. They never reach the model.
 *
 *   /rc, /remote-control              turn on
 *   /rc <name>, /remote-control <name> turn on (or rename) with a session name
 *   /rc off, /remote-control off      turn off (also "stop", "disable")
 */

import { store } from '@nimbalyst/runtime/store';
import {
  REMOTE_CONTROL_PROVIDERS,
  remoteControlAtomFamily,
  type RemoteControlCommandResult,
} from '../../store/atoms/remoteControl';

export type RemoteControlCommand = { action: 'enable'; name?: string } | { action: 'disable' };

/** The command in a composer draft, or null when the draft is not one. */
export function parseRemoteControlCommand(draft: string): RemoteControlCommand | null {
  const match = draft.trim().match(/^\/(?:remote-control|rc)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (/^(off|stop|disable)$/i.test(argument)) return { action: 'disable' };
  return argument ? { action: 'enable', name: argument } : { action: 'enable' };
}

/** Whether a draft in a session on this provider is a Remote Control command to intercept. */
export function remoteControlCommandFor(provider: string | null | undefined, draft: string): RemoteControlCommand | null {
  if (!provider || !REMOTE_CONTROL_PROVIDERS.has(provider)) return null;
  return parseRemoteControlCommand(draft);
}

/** Run the command; the main process writes the transcript notice. */
export async function runRemoteControlCommand(params: {
  sessionId: string;
  provider: string;
  workspacePath: string | null | undefined;
  command: RemoteControlCommand;
}): Promise<RemoteControlCommandResult | null> {
  const { sessionId, provider, workspacePath, command } = params;
  const channel = command.action === 'enable' ? 'ai:remote-control:enable' : 'ai:remote-control:disable';
  try {
    const result: RemoteControlCommandResult = await window.electronAPI.invoke(channel, {
      sessionId,
      provider,
      name: command.action === 'enable' ? command.name : undefined,
      announce: !!workspacePath,
      workspacePath: workspacePath ?? undefined,
    });
    if (result?.snapshot?.sessionId) store.set(remoteControlAtomFamily(sessionId), result.snapshot);
    return result ?? null;
  } catch (error) {
    console.error('[RemoteControl] /rc failed:', error);
    return null;
  }
}
