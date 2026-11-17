// @vitest-environment node
/**
 * Remote Control on ClaudeCodeProvider (GH #1480).
 *
 * The CLI exits about a second after its input stream ends, and Nimbalyst ends
 * that stream at every turn end. So a Remote Control bridge only survives the
 * idle period if the provider keeps the live query open ("parks" it) and hands
 * it to the next turn. These tests drive sendMessage with a fake live CLI and
 * pin both halves:
 *
 * - With Remote Control off (every session by default) the turn ends exactly
 *   as before: the prompt stream is ended and no query is kept.
 * - With it on, the query is parked, read by an idle pump, adopted by the next
 *   turn, reattached when it had to be replaced, and closed on abort/destroy.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', async () => ({
  app: { ...(await import('../../../../../../electron/test-stubs/privateUserData')).testApp, isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

// The real restore delay is 1.5s; the tests that wait for it cannot.
vi.mock('../claudeCode/remoteControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claudeCode/remoteControl')>()),
  REMOTE_CONTROL_RESTORE_DELAY_MS: 10,
}));

// The real suggestion wait is 8s.
vi.mock('../claudeCode/promptSuggestionWait', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claudeCode/promptSuggestionWait')>()),
  PROMPT_SUGGESTION_WAIT_MS: 300,
}));

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryMock(args),
}));

import os from 'os';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import type { StreamChunk } from '../../types';

const SESSION = 'nimbalyst-session-1';

async function makeProvider(): Promise<ClaudeCodeProvider> {
  const provider = new ClaudeCodeProvider();
  await provider.initialize({ provider: 'claude-code', model: 'sonnet' } as never);
  const internals = provider as unknown as Record<string, unknown>;
  internals.logAgentMessage = vi.fn(async () => {});
  internals.logAgentMessageNonBlocking = vi.fn();
  internals.logError = vi.fn();
  internals.logSecurity = vi.fn();
  internals.flushPendingWrites = vi.fn(async () => {});
  internals.processTranscriptMessages = vi.fn(async () => {});
  internals.scheduleTranscriptProcessing = vi.fn();
  internals.emitTodoUpdate = vi.fn(async () => {});
  internals.emitTaskUpdate = vi.fn(async () => {});
  internals.maybeApplyDefaultSessionPhase = vi.fn(async () => {});
  internals.checkSessionExists = vi.fn(async () => true);
  internals.getMcpServersSnapshot = vi.fn(async () => ({}));
  internals.ensureGitContext = vi.fn(async () => {});
  internals.sessions = {
    getSessionId: () => 'sdk-session-1',
    captureSessionId: vi.fn(),
    expireSession: vi.fn(),
    getBranchedFrom: () => null,
    clear: vi.fn(),
  };
  return provider;
}

/** Send the CLI's answer only once the turn's prompt reached it, as the real CLI does. */
async function answerAfterPrompt(live: Live, promptCount: number, chunks: unknown[]): Promise<void> {
  await waitFor(() => live.prompts.length >= promptCount);
  live.send(...chunks);
}

async function runTurn(
  provider: ClaudeCodeProvider,
  message: string,
  onChunk?: (chunk: StreamChunk) => void,
  documentContext: object = { mode: 'agent' },
): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage(message, documentContext as never, SESSION, undefined, os.tmpdir())) {
    collected.push(chunk);
    onChunk?.(chunk);
  }
  return collected;
}

const INIT_CHUNK = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  slash_commands: [],
  skills: [],
  mcp_servers: [],
  tools: [],
};

const answer = (id: string, text: string) => [
  INIT_CHUNK,
  { type: 'assistant', session_id: 'sdk-session-1', message: { id, content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1 },
];

/**
 * A live CLI stand-in. It reads the provider's prompt stream the way the SDK
 * does, yields whatever the test sends, and ends its iterator when closed or
 * when the prompt stream ends (the real CLI exits ~1.2s after stdin closes).
 */
function liveQuery(bridge = { session_url: 'https://claude.ai/code/session_test', bridge_session_id: 'cse_test' }) {
  const outbox: unknown[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const prompts: unknown[] = [];
  let promptStreamEnded = false;
  const signal = () => { const resolve = wake; wake = null; resolve?.(); };
  const finish = () => { finished = true; signal(); };
  const close = vi.fn(() => finish());
  const enableRemoteControl = vi.fn(async (enabled: boolean) => (enabled ? bridge : {}));
  const setPermissionMode = vi.fn(async () => {});
  const query = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (outbox.length > 0) {
          yield outbox.shift();
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
    interrupt: async () => {},
    streamInput: async () => {},
    initializationResult: async () => ({}),
    setPermissionMode,
    enableRemoteControl,
    close,
  };
  return {
    query,
    close,
    enableRemoteControl,
    setPermissionMode,
    prompts,
    get promptStreamEnded() { return promptStreamEnded; },
    attach(prompt: AsyncIterable<unknown>) {
      void (async () => {
        for await (const message of prompt) prompts.push(message);
        promptStreamEnded = true;
        finish();
      })();
    },
    send(...chunks: unknown[]) {
      outbox.push(...chunks);
      signal();
    },
    exit: finish,
  };
}

type Live = ReturnType<typeof liveQuery>;

/** Every query() call gets the next fake CLI from `lives` (made on demand). */
function installQueries(lives: Live[] = []): Live[] {
  queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const live = lives[queryMock.mock.calls.length - 1] ?? (lives[queryMock.mock.calls.length - 1] = liveQuery());
    live.attach(prompt);
    return live.query;
  });
  return lives;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

describe('ClaudeCodeProvider with Remote Control off', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  // The hard safety requirement: this provider drives every Claude session,
  // and almost none of them use Remote Control. With it off, a turn must still
  // end its prompt stream (closing the CLI's stdin) and keep nothing alive.
  it('ends the prompt stream at turn end, so the CLI exits as before', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    live.send(...answer('msg_1', 'hello'));

    const chunks = await runTurn(provider, 'hi');

    expect(chunks.map((chunk) => chunk.type)).toEqual(['text', 'complete']);
    await waitFor(() => live.promptStreamEnded);
    expect(live.enableRemoteControl).not.toHaveBeenCalled();
    expect(provider.isLeadBusy()).toBe(false);

    // The next turn spawns its own query, exactly as before.
    const second = liveQuery();
    installQueries([live, second]);
    second.send(...answer('msg_2', 'again'));
    await runTurn(provider, 'again');
    expect(queryMock).toHaveBeenCalledTimes(2);
    await waitFor(() => second.promptStreamEnded);
  });

  it('skips a remote-turn wake without spawning anything when no remote turn is pending', async () => {
    const provider = await makeProvider();
    installQueries();

    const chunks = await runTurn(provider, 'from phone', undefined, { mode: 'agent', promptOrigin: 'remote_control' });

    expect(chunks).toEqual([{ type: 'complete', isComplete: true }]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

const internals = (provider: ClaudeCodeProvider) => provider as unknown as {
  parkedQuery: unknown;
  config: { model?: string };
  logAgentMessage: ReturnType<typeof vi.fn>;
  logAgentMessageNonBlocking: ReturnType<typeof vi.fn>;
};

/**
 * Run a first turn and turn Remote Control on while it is in flight, so the
 * bridge goes onto that turn's process. Resolves once the turn has ended.
 */
async function firstTurnWithRemoteControl(
  provider: ClaudeCodeProvider,
  live: Live,
  name = 'laptop',
  documentContext: object = { mode: 'agent' },
  onChunk?: (chunk: StreamChunk) => void,
): Promise<StreamChunk[]> {
  live.send(INIT_CHUNK);
  const turn = runTurn(provider, 'hi', onChunk, documentContext);
  await waitFor(() => provider.isLeadBusy());
  await provider.enableRemoteControl(name);
  live.send(
    { type: 'assistant', session_id: 'sdk-session-1', message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1 },
  );
  return turn;
}

describe('ClaudeCodeProvider with Remote Control on', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('starts the bridge on the live turn and reports it', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    const events: unknown[] = [];
    provider.on('remoteControl:changed', (payload) => events.push(payload));

    await firstTurnWithRemoteControl(provider, live);

    expect(live.enableRemoteControl).toHaveBeenCalledWith(true, 'laptop', undefined);
    expect(provider.getRemoteControlStatus()).toEqual({
      desired: true,
      state: 'ready',
      sessionUrl: 'https://claude.ai/code/session_test',
      name: 'laptop',
      error: null,
    });
    expect(events.at(-1)).toEqual({ sessionId: SESSION, status: provider.getRemoteControlStatus() });
  });

  it('parks the query at turn end instead of ending its input, and the next turn adopts it', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);

    // The process is still there: stdin open, not closed, idle (not busy).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.promptStreamEnded).toBe(false);
    expect(live.close).not.toHaveBeenCalled();
    expect(provider.isLeadBusy()).toBe(false);
    expect(provider.willResumeAfterCompletion()).toBe(false);
    expect(provider.canAcceptFollowUpDuringDrain()).toBe(false);

    const secondTurn = runTurn(provider, 'second');
    await answerAfterPrompt(live, 2, answer('msg_2', 'second answer'));
    const second = await secondTurn;

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((live.prompts[1] as { message: { content: unknown } }).message.content).toBe('second');
    expect(second.filter((c) => c.type === 'text').map((c) => c.content)).toEqual(['second answer']);
    // Adopted, so no reattach: the bridge never left this process.
    expect(live.enableRemoteControl).toHaveBeenCalledTimes(1);
    expect(provider.getRemoteControlStatus().state).toBe('ready');
  });

  it('tracks bridge_state chunks without persisting them', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);

    live.send({ type: 'system', subtype: 'bridge_state', state: 'connected', bridge_epoch: 2 });
    await waitFor(() => provider.getRemoteControlStatus().state === 'connected');

    // Mid-turn too: the chunk loop applies bridge state without persisting it.
    const secondTurn = runTurn(provider, 'second');
    await answerAfterPrompt(live, 2, [{ type: 'system', subtype: 'bridge_state', state: 'ready' }, ...answer('msg_2', 'ok')]);
    await secondTurn;
    expect(provider.getRemoteControlStatus().state).toBe('ready');
    const persisted = internals(provider).logAgentMessageNonBlocking.mock.calls.map((call) => String(call[3]));
    expect(persisted.some((content) => content.includes('bridge_state'))).toBe(false);
  });

  it('reports the bridge down when the parked CLI exits, then restores it on a warm query with the same bridge session', async () => {
    const provider = await makeProvider();
    const first = liveQuery();
    const warm = liveQuery();
    installQueries([first, warm]);
    await firstTurnWithRemoteControl(provider, first);

    const states: string[] = [];
    provider.on('remoteControl:changed', (payload: { status: { state: string } }) => states.push(payload.status.state));
    first.exit();

    await waitFor(() => states.includes('disconnected'));
    await waitFor(() => queryMock.mock.calls.length === 2 && provider.getRemoteControlStatus().state === 'ready');
    // The warm query starts with nothing to answer and reattaches to the same bridge.
    expect(warm.prompts).toEqual([]);
    expect(warm.enableRemoteControl).toHaveBeenCalledWith(true, 'laptop', { reattachSessionId: 'cse_test' });
    expect(provider.getRemoteControlStatus().sessionUrl).toBe('https://claude.ai/code/session_test');

    // The next local turn adopts the warm query.
    const nextTurn = runTurn(provider, 'next');
    await answerAfterPrompt(warm, 1, answer('msg_2', 'from warm'));
    const chunks = await nextTurn;
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect((warm.prompts[0] as { message: { content: unknown } }).message.content).toBe('next');
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.content)).toEqual(['from warm']);
  });

  it('enables at idle by spawning a warm query with an empty input stream', async () => {
    const provider = await makeProvider();
    const first = liveQuery();
    const warm = liveQuery();
    installQueries([first, warm]);
    first.send(...answer('msg_1', 'hello'));
    await runTurn(provider, 'hi');
    await waitFor(() => first.promptStreamEnded);

    const status = await provider.enableRemoteControl();

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(warm.prompts).toEqual([]);
    expect(warm.enableRemoteControl).toHaveBeenCalledWith(true, undefined, undefined);
    expect(status).toMatchObject({ desired: true, state: 'ready', sessionUrl: 'https://claude.ai/code/session_test' });
    const options = (queryMock.mock.calls[1][0] as { options: { resume?: string } }).options;
    expect(options.resume).toBe('sdk-session-1');
  });

  it('runs a prompt sent from the phone as a turn on the parked query, without pushing it or persisting its echo', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);
    const started: Array<{ sessionId: string; text: string }> = [];
    provider.on('remoteControl:turnStarted', (payload) => started.push(payload));

    // UNVERIFIED shape: what a remote prompt looks like on the stream has not
    // been observed. This models the likely one: init, the user message, the answer.
    live.send(
      INIT_CHUNK,
      { type: 'user', message: { role: 'user', content: 'from phone' }, parent_tool_use_id: null },
    );
    await waitFor(() => started.length === 1);
    expect(started[0]).toEqual({ sessionId: SESSION, text: 'from phone' });
    expect(provider.hasPendingRemoteControlTurn()).toBe(true);

    live.send(
      { type: 'assistant', session_id: 'sdk-session-1', message: { id: 'msg_r', content: [{ type: 'text', text: 'answer for phone' }] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1 },
    );
    const persistedBefore = internals(provider).logAgentMessageNonBlocking.mock.calls.length;
    const chunks = await runTurn(provider, 'from phone', undefined, { mode: 'agent', promptOrigin: 'remote_control' });

    expect(chunks.filter((c) => c.type === 'text').map((c) => c.content)).toEqual(['answer for phone']);
    expect(live.prompts).toHaveLength(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const persisted = internals(provider).logAgentMessageNonBlocking.mock.calls.slice(persistedBefore).map((call) => String(call[3]));
    expect(persisted.some((content) => content.includes('from phone'))).toBe(false);
    // The prompt is recorded once, as the turn's input row (the user bubble).
    const inputs = internals(provider).logAgentMessage.mock.calls.filter((call) => call[2] === 'input');
    expect(JSON.parse(String(inputs.at(-1)?.[3])).prompt).toBe('from phone');
    expect(provider.hasPendingRemoteControlTurn()).toBe(false);
    // And the query is parked again for the next one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.promptStreamEnded).toBe(false);
  });

  it('falls back to a placeholder prompt when the remote turn carries no readable text', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);
    const started: Array<{ text: string }> = [];
    provider.on('remoteControl:turnStarted', (payload) => started.push(payload));

    live.send({ type: 'assistant', session_id: 'sdk-session-1', message: { id: 'msg_r', content: [{ type: 'text', text: 'hm' }] } });
    await waitFor(() => started.length === 1);
    expect(started[0].text).toBe('Prompt from Remote Control');
  });

  it('ignores noise and unrecognised chunks while parked', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);
    const started: unknown[] = [];
    provider.on('remoteControl:turnStarted', (payload) => started.push(payload));

    live.send(
      { type: 'prompt_suggestion', suggestion: 'x' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      { type: 'something_new', detail: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual([]);
    expect(provider.hasPendingRemoteControlTurn()).toBe(false);
  });

  // A warm or restored query emits init on its own, with no prompt behind it.
  // Treating that as a remote turn would wake the session with nothing to run.
  it('does not start a remote turn on a lone init, and a later local turn still adopts the query', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);
    const started: unknown[] = [];
    provider.on('remoteControl:turnStarted', (payload) => started.push(payload));

    live.send(INIT_CHUNK, { type: 'system', subtype: 'session_state_changed', state: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual([]);
    expect(provider.hasPendingRemoteControlTurn()).toBe(false);

    const nextTurn = runTurn(provider, 'local');
    await answerAfterPrompt(live, 2, answer('msg_2', 'local answer'));
    const chunks = await nextTurn;
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.content)).toEqual(['local answer']);
  });

  it('replaces the parked query when the model changed, and reattaches the bridge on the new process', async () => {
    const provider = await makeProvider();
    const first = liveQuery();
    const second = liveQuery();
    installQueries([first, second]);
    await firstTurnWithRemoteControl(provider, first);

    internals(provider).config.model = 'claude-code:opus';
    second.send(...answer('msg_2', 'on opus'));
    await runTurn(provider, 'switch');

    expect(first.close).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(second.enableRemoteControl).toHaveBeenCalledWith(true, 'laptop', { reattachSessionId: 'cse_test' });
    expect(provider.getRemoteControlStatus().state).toBe('ready');
    // The new process is parked in turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.promptStreamEnded).toBe(false);
  });

  it('stops the bridge and closes the parked process when disabled', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    await firstTurnWithRemoteControl(provider, live);

    const status = await provider.disableRemoteControl();

    expect(live.enableRemoteControl).toHaveBeenLastCalledWith(false);
    expect(live.close).toHaveBeenCalled();
    expect(status).toEqual({ desired: false, state: 'off', sessionUrl: null, name: 'laptop', error: null });

    // Back to the default lifecycle: the next turn spawns and ends normally.
    const next = liveQuery();
    installQueries([live, next]);
    next.send(...answer('msg_2', 'plain'));
    await runTurn(provider, 'plain');
    await waitFor(() => next.promptStreamEnded);
  });

  it('closes the parked process on abort and on destroy, leaving no orphan', async () => {
    const provider = await makeProvider();
    const first = liveQuery();
    installQueries([first, liveQuery()]);
    await firstTurnWithRemoteControl(provider, first);

    provider.abort();
    expect(first.close).toHaveBeenCalled();

    // abort keeps Remote Control on and restores it while idle; destroy ends it.
    await waitFor(() => internals(provider).parkedQuery !== null);
    const warm = (queryMock.mock.results[1]?.value) as { close: ReturnType<typeof vi.fn> };
    provider.destroy();
    expect(warm.close).toHaveBeenCalled();
    expect(provider.getRemoteControlStatus()).toMatchObject({ desired: false, state: 'off' });
  });

  it('carries Remote Control across a provider replacement and reattaches on the first turn', async () => {
    const provider = await makeProvider();
    const first = liveQuery();
    installQueries([first]);
    await firstTurnWithRemoteControl(provider, first);

    const events: Array<{ status: { desired: boolean; state: string } }> = [];
    provider.on('remoteControl:changed', (payload) => events.push(payload));
    provider.handOffRemoteControlForReplacement();
    provider.destroy();
    // Replaced, not ended: the UI shows it wanted but down, not off.
    expect(events.at(-1)?.status).toMatchObject({ desired: true, state: 'disconnected' });
    expect(first.close).toHaveBeenCalled();

    const successor = await makeProvider();
    const replacement = liveQuery();
    installQueries([first, replacement]);
    replacement.send(...answer('msg_2', 'new model'));
    await runTurn(successor, 'after switch');

    expect(replacement.enableRemoteControl).toHaveBeenCalledWith(true, 'laptop', { reattachSessionId: 'cse_test' });
    expect(successor.getRemoteControlStatus()).toMatchObject({ desired: true, state: 'ready' });
    await successor.disableRemoteControl();
  });
});

/**
 * A human turn keeps reading after `result` for the prompt suggestion frame.
 * That wait leaves a `next()` in flight on the live query, and the phone can
 * send a prompt during it; both must reach the park, not be lost.
 */
describe('ClaudeCodeProvider with Remote Control on, across the prompt suggestion wait', () => {
  const HUMAN = { mode: 'agent', promptProvenance: { actor: 'human', origin: 'composer' } };

  beforeEach(() => {
    queryMock.mockReset();
    ClaudeCodeProvider.setPromptSuggestionsEnabledLoader(() => true);
  });
  afterEach(() => {
    ClaudeCodeProvider.setPromptSuggestionsEnabledLoader(null);
  });

  it('hands the in-flight read to the park when the wait expires, so the next chunk is not lost', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    const startedAt = Date.now();
    const chunks = await firstTurnWithRemoteControl(provider, live, 'laptop', HUMAN);
    // The turn waited out the suggestion window before parking.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['text', 'complete']);

    live.send({ type: 'system', subtype: 'bridge_state', state: 'connected' });
    await waitFor(() => provider.getRemoteControlStatus().state === 'connected');
  });

  it('starts a remote turn when the phone sends a prompt during the wait, without persisting it in the finished turn', async () => {
    const provider = await makeProvider();
    const [live] = installQueries([liveQuery()]);
    const started: Array<{ text: string }> = [];
    provider.on('remoteControl:turnStarted', (payload) => started.push(payload));
    const phone = { type: 'user', message: { role: 'user', content: 'from phone mid-wait' }, parent_tool_use_id: null };

    const chunks = await firstTurnWithRemoteControl(provider, live, 'laptop', HUMAN, (chunk) => {
      if (chunk.type === 'complete') live.send(phone);
    });

    expect(chunks.map((chunk) => chunk.type)).toEqual(['text', 'complete']);
    await waitFor(() => started.length === 1);
    expect(started[0].text).toBe('from phone mid-wait');
    expect(provider.hasPendingRemoteControlTurn()).toBe(true);
    const persisted = internals(provider).logAgentMessageNonBlocking.mock.calls.map((call) => String(call[3]));
    expect(persisted.some((content) => content.includes('from phone mid-wait'))).toBe(false);
  });
});
