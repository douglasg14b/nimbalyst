/**
 * Runs a prompt sent through Remote Control (claude.ai/code or the Claude app)
 * while the session is idle (GH #1480).
 *
 * With Remote Control on, ClaudeCodeProvider keeps the session's CLI process
 * open between turns and reads it with an idle pump. When the pump sees a
 * prompt from the phone start a turn, it emits `remoteControl:turnStarted`;
 * this listener turns that into an ordinary send, so the remote turn is
 * persisted, rendered, and gets permission prompts and interactive tools like
 * any other. The provider recognises the send by its `promptOrigin` and runs it
 * on the parked process without sending the prompt a second time.
 *
 * Modeled on teammateIdleWake.ts, with the session-state guard inverted: an
 * idle session is exactly the case here, and an active one means a turn already
 * owns the stream. A session can still read as active for a moment after its
 * turn parked, so the wake waits briefly for it to settle.
 */

import { REMOTE_CONTROL_PROMPT_ORIGIN } from '@nimbalyst/runtime/ai/server/providers/claudeCode/remoteControl';

export interface RemoteControlTurnStartedData {
  sessionId?: string;
  text?: string;
}

export interface WakeTargetWindow {
  isDestroyed: () => boolean;
}

export interface RemoteControlWakeDeps<W extends WakeTargetWindow = WakeTargetWindow> {
  isSessionActive: (sessionId: string) => boolean;
  /** The provider still holds the remote turn (nothing else consumed it). */
  hasPendingRemoteTurn: (sessionId: string) => boolean;
  startSession: (options: { sessionId: string; workspacePath: string }) => Promise<void>;
  endSession: (sessionId: string) => Promise<void>;
  turnWorkspacePath: () => string;
  resolveOwnerWorkspacePath: (sessionId: string) => Promise<string | null>;
  findWindow: (workspacePath: string) => W | null | undefined;
  sendMessage: (
    window: W,
    message: string,
    sessionId: string,
    workspacePath: string,
    documentContext: { promptOrigin: string },
  ) => Promise<unknown>;
  defer: (fn: () => void) => void;
  delay: (ms: number) => Promise<void>;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}

/** How long the wake waits for a just-finished turn to mark the session idle. */
export const REMOTE_WAKE_SETTLE_ATTEMPTS = 20;
export const REMOTE_WAKE_SETTLE_INTERVAL_MS = 250;

export function createRemoteControlWakeListener<W extends WakeTargetWindow>(deps: RemoteControlWakeDeps<W>) {
  return async (data: RemoteControlTurnStartedData): Promise<void> => {
    const sessionId = data?.sessionId;
    if (!sessionId) {
      deps.logWarn('[AIService] remoteControl:turnStarted with no sessionId');
      return;
    }
    const text = data.text?.trim() || 'Prompt from Remote Control';

    for (let attempt = 0; deps.isSessionActive(sessionId); attempt++) {
      if (attempt >= REMOTE_WAKE_SETTLE_ATTEMPTS) {
        // A turn is running on this session; it reads the stream itself.
        deps.logInfo(`[AIService] Remote Control prompt for ${sessionId} arrived while a turn is running; that turn owns it`);
        return;
      }
      await deps.delay(REMOTE_WAKE_SETTLE_INTERVAL_MS);
    }
    if (!deps.hasPendingRemoteTurn(sessionId)) {
      deps.logInfo(`[AIService] Remote Control prompt for ${sessionId} was already taken by another turn`);
      return;
    }

    deps.logInfo(`[AIService] Remote Control prompt while idle, starting a turn for session ${sessionId}`);
    const workspacePath = (await deps.resolveOwnerWorkspacePath(sessionId)) ?? deps.turnWorkspacePath();
    // startSession marks the session running; anything that stops the send
    // from starting must undo that or the session reads as running forever.
    const abandon = (message: string, error: unknown) => {
      deps.logError(message, error);
      deps.endSession(sessionId).catch((endError) => {
        deps.logError('[AIService] Failed to end session after an abandoned Remote Control wake', endError);
      });
    };
    try {
      await deps.startSession({ sessionId, workspacePath });
      const targetWindow = deps.findWindow(workspacePath);
      if (!targetWindow || targetWindow.isDestroyed()) {
        abandon('[AIService] No window for Remote Control wake', new Error(`No window for workspace ${workspacePath}`));
        return;
      }
      deps.defer(() => {
        deps.sendMessage(targetWindow, text, sessionId, workspacePath, { promptOrigin: REMOTE_CONTROL_PROMPT_ORIGIN })
          .catch((error) => abandon('[AIService] Failed to run a Remote Control prompt', error));
      });
    } catch (error) {
      abandon('[AIService] Failed to handle a Remote Control prompt', error);
    }
  };
}
