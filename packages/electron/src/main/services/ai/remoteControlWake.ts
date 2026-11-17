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
        // The prompt stays pending on the parked process; the session's next
        // prompt runs it first, as its own turn (runStrandedRemoteControlTurn).
        deps.logInfo(`[AIService] Remote Control prompt for ${sessionId} arrived while the session still read as busy; left pending for the session's next prompt to run first`);
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

export interface StrandedRemoteTurnDeps {
  isSessionActive: (sessionId: string) => boolean;
  /** The transcript text of a remote turn still waiting on the parked process, or null. */
  pendingRemoteTurnText: (sessionId: string) => string | null;
  /** Run it as its own turn (a send flagged with the remote prompt origin); resolves when it ends. */
  runRemoteTurn: (text: string) => Promise<unknown>;
  logInfo: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}

/**
 * Called before a local prompt is sent. When a remote turn's wake could not run
 * (no window, a failed send, a session that read busy), the parked process is
 * already answering the phone's prompt. Sending the local prompt onto it would
 * pull that answer into the local turn and leave the local answer to show up
 * later as a phantom remote turn. So the remote turn runs first, as its own
 * turn with its own user row, and the local prompt follows it.
 *
 * Skipped when the session is active: a wake (or another turn) is already in
 * flight and owns the parked process.
 */
export async function runStrandedRemoteControlTurn(
  sessionId: string,
  promptOrigin: unknown,
  deps: StrandedRemoteTurnDeps,
): Promise<void> {
  if (promptOrigin === REMOTE_CONTROL_PROMPT_ORIGIN) return;
  if (deps.isSessionActive(sessionId)) return;
  const text = deps.pendingRemoteTurnText(sessionId);
  if (text === null) return;
  deps.logInfo(`[AIService] Running a pending Remote Control prompt for ${sessionId} before the local prompt`);
  try {
    await deps.runRemoteTurn(text);
  } catch (error) {
    // The local prompt still runs; the provider then reports the mixed turn.
    deps.logError('[AIService] Failed to run a pending Remote Control prompt before a local one', error);
  }
}
