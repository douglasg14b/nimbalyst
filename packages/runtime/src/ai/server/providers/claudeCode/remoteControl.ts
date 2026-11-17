/**
 * Remote Control for Agent SDK sessions (GH #1480): the decisions, kept pure.
 *
 * Remote Control bridges a session to claude.ai/code and the Claude mobile
 * app. The bridge lives inside the CLI subprocess, and the CLI exits about a
 * second after its input stream ends (measured against SDK 0.3.321). Nimbalyst
 * ends that stream at every turn end, so on its own a bridge dies with the
 * turn. While Remote Control is on, ClaudeCodeProvider therefore keeps the live
 * query open between turns ("parks" it), reads it with an idle pump so a prompt
 * sent from the phone is noticed, and hands it to the next turn. Where a query
 * has to be replaced anyway (model switch, abort, crash), the new one reattaches
 * to the same bridge session with `reattachSessionId`.
 *
 * Everything here is a pure function of its inputs so the rules can be tested
 * without a subprocess. Remote Control is off for every session by default, and
 * every decision below answers "do nothing new" when it is off.
 */

/** What the SDK returns when a bridge comes up (probe, SDK 0.3.321). */
export interface RemoteControlInfo {
  /** claude.ai URL of the bridged session; what the user opens or scans. */
  session_url?: string;
  connect_url?: string;
  environment_id?: string;
  bridge_epoch?: number;
  /** Present once the bridge is live; reattaching to it keeps the same URL. */
  bridge_session_id?: string;
}

export interface EnableRemoteControlOptions {
  reattachSessionId?: string;
  keepSessionOnExit?: boolean;
  workSecret?: string;
  refreshWorkSecret?: boolean;
}

/**
 * The query method that starts and stops the bridge.
 *
 * The SDK's query object implements `enableRemoteControl`, but its type
 * declarations omit it:
 * https://github.com/anthropics/claude-agent-sdk-typescript/issues/460
 * This interface and `asRemoteControlQuery` are the only place the method is
 * cast. When the SDK declares it, delete both and call it on the query directly.
 */
export interface RemoteControlQuery {
  enableRemoteControl(
    enabled: boolean,
    name?: string,
    opts?: EnableRemoteControlOptions,
  ): Promise<RemoteControlInfo>;
}

/** The query as a Remote Control handle, or null when this SDK build lacks the method. */
export function asRemoteControlQuery(query: unknown): RemoteControlQuery | null {
  const method = (query as { enableRemoteControl?: unknown } | null | undefined)?.enableRemoteControl;
  return typeof method === 'function' ? (query as RemoteControlQuery) : null;
}

/**
 * Honest bridge state, as shown to the user.
 *
 * - `off`: not wanted.
 * - `connecting`: wanted, no bridge yet (enabling, or waiting for the session's
 *   next turn to start a process to put it on).
 * - `ready`: bridge up, no phone or browser attached.
 * - `connected`: a phone or browser is attached.
 * - `reconnecting`: the bridge reported a transient drop.
 * - `disconnected`: wanted, but the process holding the bridge is gone; it
 *   comes back on the session's next turn.
 * - `error`: the last attempt to start it failed (see the error text).
 */
export type RemoteControlState =
  | 'off'
  | 'connecting'
  | 'ready'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface RemoteControlStatus {
  desired: boolean;
  state: RemoteControlState;
  /** The pairing URL. Kept while reconnecting: a reattach returns the same one. */
  sessionUrl: string | null;
  name: string | null;
  error: string | null;
}

export const REMOTE_CONTROL_OFF: RemoteControlStatus = Object.freeze({
  desired: false,
  state: 'off',
  sessionUrl: null,
  name: null,
  error: null,
}) as RemoteControlStatus;

/** `documentContext.promptOrigin` of a turn started by a prompt sent through Remote Control. */
export const REMOTE_CONTROL_PROMPT_ORIGIN = 'remote_control';

/** Shown as the user's prompt when a remote turn's text could not be read from the stream. */
export const REMOTE_CONTROL_PLACEHOLDER_PROMPT = 'Prompt from Remote Control';

/** Delay before an idle session whose bridge died with its turn gets a fresh one. */
export const REMOTE_CONTROL_RESTORE_DELAY_MS = 1_500;

/** How long the idle pump keeps reading after a remote turn starts, looking for the prompt text. */
export const REMOTE_PROMPT_TEXT_WAIT_MS = 2_000;
export const REMOTE_PROMPT_TEXT_MAX_CHUNKS = 8;

/** Map a `system/bridge_state` value onto the states the UI shows. Unknown values never read as "up". */
export function mapBridgeState(raw: string): RemoteControlState {
  const value = raw.toLowerCase();
  if (value === 'ready') return 'ready';
  if (value === 'connected') return 'connected';
  if (value.includes('reconnect')) return 'reconnecting';
  if (value.includes('fail') || value.includes('error')) return 'error';
  if (value.includes('disconnect') || value.includes('closed') || value.includes('stopped') || value === 'off') {
    return 'disconnected';
  }
  return 'connecting';
}

/** True for states in which the bridge is actually up. */
export function isBridgeUp(state: RemoteControlState): boolean {
  return state === 'ready' || state === 'connected';
}

type Chunk = Record<string, unknown>;

function asChunk(value: unknown): Chunk | null {
  return value && typeof value === 'object' ? (value as Chunk) : null;
}

/** The raw state of a `system/bridge_state` chunk, else null. */
export function bridgeStateOf(chunk: unknown): string | null {
  const c = asChunk(chunk);
  if (!c || c.type !== 'system' || c.subtype !== 'bridge_state') return null;
  return typeof c.state === 'string' ? c.state : 'unknown';
}

/**
 * True when the CLI says the bridge was switched off from the other side
 * (`system/worker_shutting_down`, reason `remote_control_disabled`).
 */
export function isRemoteSideDisable(chunk: unknown): boolean {
  const c = asChunk(chunk);
  return !!c && c.type === 'system' && c.subtype === 'worker_shutting_down'
    && c.reason === 'remote_control_disabled';
}

function contentBlocks(chunk: Chunk): unknown {
  return (chunk.message as { content?: unknown } | undefined)?.content;
}

/**
 * A user-role chunk that carries a prompt (text), as opposed to the CLI's own
 * tool_result rows or a sub-agent's input.
 */
export function isUserPromptChunk(chunk: unknown): boolean {
  const c = asChunk(chunk);
  if (!c || c.type !== 'user') return false;
  if (typeof c.parent_tool_use_id === 'string' && c.parent_tool_use_id) return false;
  return extractUserPromptText(c) !== null;
}

/** The prompt text of a user-role chunk, or null when it has none (tool results, images only). */
export function extractUserPromptText(chunk: unknown): string | null {
  const c = asChunk(chunk);
  if (!c || c.type !== 'user') return null;
  const content = contentBlocks(c);
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? text : null;
  }
  if (!Array.isArray(content)) return null;
  if (content.some((block) => (block as { type?: unknown })?.type === 'tool_result')) return null;
  const text = content
    .filter((block) => (block as { type?: unknown })?.type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('\n')
    .trim();
  return text ? text : null;
}

/** Chunks the idle pump reads and drops: they never start a turn. */
const NOISE_TYPES = new Set([
  'prompt_suggestion',
  'result',
  'rate_limit_event',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'keep_alive',
]);

const NOISE_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_progress',
  'hook_response',
  'status',
  'informational',
  'notification',
  'commands_changed',
  'files_persisted',
  'memory_recall',
  'api_retry',
  'background_tasks_changed',
  'session_writes_lost',
  'mirror_error',
  'plugin_install',
]);

export type ParkedChunkClass =
  | { kind: 'bridge'; state: string }
  | { kind: 'bridge-off' }
  | { kind: 'noise' }
  | { kind: 'turn-start'; text: string | null }
  | { kind: 'unknown' };

/**
 * Classify a chunk read from a parked query, where no turn is running.
 *
 * Only positive evidence starts a turn: a user prompt, an assistant or stream
 * event, `system/init`, or `session_state_changed: running`. An unrecognised
 * shape is reported as `unknown` so the caller can log it and keep waiting; a
 * false "turn started" would run an empty turn that hangs until the stall
 * watchdog fires.
 *
 * UNVERIFIED: nobody has yet observed the exact chunks a prompt sent from the
 * phone produces while the query is parked (see nimbalyst-local/rc-probe).
 */
export function classifyParkedChunk(chunk: unknown): ParkedChunkClass {
  const c = asChunk(chunk);
  if (!c || typeof c.type !== 'string') return { kind: 'unknown' };
  const bridge = bridgeStateOf(c);
  if (bridge !== null) return { kind: 'bridge', state: bridge };
  if (isRemoteSideDisable(c)) return { kind: 'bridge-off' };
  if (NOISE_TYPES.has(c.type)) return { kind: 'noise' };
  if (c.type === 'system') {
    if (c.subtype === 'init') return { kind: 'turn-start', text: null };
    if (c.subtype === 'session_state_changed') {
      return c.state === 'running' ? { kind: 'turn-start', text: null } : { kind: 'noise' };
    }
    if (typeof c.subtype === 'string' && NOISE_SYSTEM_SUBTYPES.has(c.subtype)) return { kind: 'noise' };
    return { kind: 'unknown' };
  }
  if (c.type === 'user') {
    const text = extractUserPromptText(c);
    return text !== null ? { kind: 'turn-start', text } : { kind: 'unknown' };
  }
  if (c.type === 'assistant' || c.type === 'stream_event') return { kind: 'turn-start', text: null };
  return { kind: 'unknown' };
}

/**
 * A loggable description of a chunk's shape: type, subtype and top-level keys,
 * never values (a chunk can carry session URLs and prompt text).
 */
export function describeChunkShape(chunk: unknown): string {
  const c = asChunk(chunk);
  if (!c) return typeof chunk;
  const type = typeof c.type === 'string' ? c.type : '?';
  const subtype = typeof c.subtype === 'string' ? `/${c.subtype}` : '';
  return `${type}${subtype} keys=[${Object.keys(c).sort().join(',')}]`;
}

/** The key the shape log is deduplicated on. */
export function chunkShapeKey(chunk: unknown): string {
  const c = asChunk(chunk);
  if (!c) return typeof chunk;
  return `${String(c.type)}/${String(c.subtype ?? '')}`;
}

/**
 * Everything a parked process was spawned with that a later turn could change.
 * A turn whose key differs cannot reuse the process; it spawns its own and
 * reattaches the bridge to it.
 */
export function remoteControlSpawnKey(inputs: {
  modelVariant: string;
  effortLevel?: string;
  thinkingMode?: string;
  cwd?: string;
  permissionsPath?: string;
  mcpConfigWorkspacePath?: string;
}): string {
  return JSON.stringify([
    inputs.modelVariant,
    inputs.effortLevel ?? null,
    inputs.thinkingMode ?? null,
    inputs.cwd ?? null,
    inputs.permissionsPath ?? null,
    inputs.mcpConfigWorkspacePath ?? null,
  ]);
}

export interface ParkFacts {
  /** Remote Control is on for this session. */
  desired: boolean;
  /** The bridge is on this turn's query, or being put on it. */
  bridgeOnTurnQuery: boolean;
  /** The turn reached its `result` and emitted `complete`. */
  completeEmitted: boolean;
  /** The turn's catch block ran (an error, including a crash being retried). */
  errored: boolean;
  /** Why the chunk loop stopped: only a clean 'resolved' can park. */
  drainExitCause: string;
  wasInterrupted: boolean;
  transportDied: boolean;
  aborted: boolean;
  promptStreamOpen: boolean;
  /** Background sub-agents drained or settled this turn; finalizeBackgroundDrain closes such a query. */
  drainingBackgroundTasks: boolean;
  settledBackgroundTasksThisTurn: boolean;
  hasRunningTasks: boolean;
  sawStreamClosed: boolean;
  hasTeammateWork: boolean;
}

/**
 * Whether a finished turn keeps its query open for Remote Control instead of
 * ending it. Only a clean, plain turn qualifies; anything unusual takes the
 * existing teardown path and the bridge is reattached afterwards.
 */
export function shouldParkForRemoteControl(facts: ParkFacts): boolean {
  return facts.desired
    && facts.bridgeOnTurnQuery
    && facts.completeEmitted
    && !facts.errored
    && facts.drainExitCause === 'resolved'
    && !facts.wasInterrupted
    && !facts.transportDied
    && !facts.aborted
    && facts.promptStreamOpen
    && !facts.drainingBackgroundTasks
    && !facts.settledBackgroundTasksThisTurn
    && !facts.hasRunningTasks
    && !facts.sawStreamClosed
    && !facts.hasTeammateWork;
}

/**
 * An iterator that first replays chunks the idle pump already read (and a
 * `next()` it had in flight), then continues on the query's own iterator. This
 * is how a turn adopts a parked query without losing or reordering anything.
 */
export function replayingIterator<T>(
  buffered: T[],
  pendingNext: Promise<IteratorResult<T>> | null,
  inner: AsyncIterator<T>,
): AsyncIterator<T> {
  const queue = [...buffered];
  let carried = pendingNext;
  return {
    next: () => {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false });
      if (carried) {
        const next = carried;
        carried = null;
        return next;
      }
      return inner.next();
    },
    return: inner.return ? (value?: unknown) => inner.return!(value as never) : undefined,
    throw: inner.throw ? (error?: unknown) => inner.throw!(error) : undefined,
  };
}

/** What a replaced provider hands its successor so the bridge survives a model switch. */
export interface RemoteControlCarry {
  name?: string;
  bridgeSessionId?: string;
  sessionUrl?: string;
}

/**
 * Remote Control state that outlives a provider instance. Changing a session's
 * model destroys its provider (SessionHandlers `session:update`); the session
 * id keys what the next provider needs to reattach on its first turn. Empty
 * unless a session with Remote Control on had its model changed.
 */
class RemoteControlCarryOverRegistry {
  private readonly carries = new Map<string, RemoteControlCarry>();

  stash(sessionId: string, carry: RemoteControlCarry | null): void {
    if (carry) this.carries.set(sessionId, carry);
  }

  peek(sessionId: string): RemoteControlCarry | undefined {
    return this.carries.get(sessionId);
  }

  take(sessionId: string): RemoteControlCarry | undefined {
    const carry = this.carries.get(sessionId);
    this.carries.delete(sessionId);
    return carry;
  }

  clear(sessionId: string): void {
    this.carries.delete(sessionId);
  }
}

export const remoteControlCarryOver = new RemoteControlCarryOverRegistry();
