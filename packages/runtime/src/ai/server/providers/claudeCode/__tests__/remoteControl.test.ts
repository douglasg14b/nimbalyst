// @vitest-environment node
/**
 * The pure Remote Control decisions (GH #1480). The provider tests cover the
 * lifecycle; these pin the rules it is built on: what may start a remote turn
 * while the session is idle, when a turn may keep its process, and that a
 * bridge state the code does not know is never shown as "up".
 */
import { describe, expect, it } from 'vitest';
import {
  asRemoteControlQuery,
  classifyParkedChunk,
  describeChunkShape,
  extractUserPromptText,
  isBridgeUp,
  mapBridgeState,
  replayingIterator,
  shouldParkForRemoteControl,
  type ParkFacts,
} from '../remoteControl';

const cleanTurn: ParkFacts = {
  desired: true,
  bridgeOnTurnQuery: true,
  completeEmitted: true,
  errored: false,
  drainExitCause: 'resolved',
  wasInterrupted: false,
  transportDied: false,
  aborted: false,
  promptStreamOpen: true,
  drainingBackgroundTasks: false,
  settledBackgroundTasksThisTurn: false,
  hasRunningTasks: false,
  sawStreamClosed: false,
  hasTeammateWork: false,
};

describe('shouldParkForRemoteControl', () => {
  it('parks only a clean turn with Remote Control on and the bridge on its query', () => {
    expect(shouldParkForRemoteControl(cleanTurn)).toBe(true);
    expect(shouldParkForRemoteControl({ ...cleanTurn, desired: false })).toBe(false);
    expect(shouldParkForRemoteControl({ ...cleanTurn, bridgeOnTurnQuery: false })).toBe(false);
  });

  it.each<[string, Partial<ParkFacts>]>([
    ['no complete', { completeEmitted: false }],
    ['an error', { errored: true }],
    ['an abort', { drainExitCause: 'aborted' }],
    ['the iterator ending', { drainExitCause: 'iterator-done' }],
    ['an interrupt', { wasInterrupted: true }],
    ['a dead transport', { transportDied: true }],
    ['an aborted signal', { aborted: true }],
    ['an ended prompt stream', { promptStreamOpen: false }],
    ['a background drain', { drainingBackgroundTasks: true }],
    ['a task settled this turn', { settledBackgroundTasksThisTurn: true }],
    ['running tasks', { hasRunningTasks: true }],
    ['a stream-closed failure', { sawStreamClosed: true }],
    ['teammate work', { hasTeammateWork: true }],
  ])('does not park after %s', (_label, change) => {
    expect(shouldParkForRemoteControl({ ...cleanTurn, ...change })).toBe(false);
  });
});

describe('classifyParkedChunk', () => {
  it('reads bridge state and a remote-side disable', () => {
    expect(classifyParkedChunk({ type: 'system', subtype: 'bridge_state', state: 'connected' }))
      .toEqual({ kind: 'bridge', state: 'connected' });
    expect(classifyParkedChunk({ type: 'system', subtype: 'worker_shutting_down', reason: 'remote_control_disabled' }))
      .toEqual({ kind: 'bridge-off' });
  });

  it('starts a turn only on positive evidence', () => {
    expect(classifyParkedChunk({ type: 'user', message: { content: [{ type: 'text', text: 'from phone' }] } }))
      .toEqual({ kind: 'turn-start', text: 'from phone' });
    expect(classifyParkedChunk({ type: 'assistant', message: { content: [] } })).toEqual({ kind: 'turn-start', text: null });
    expect(classifyParkedChunk({ type: 'stream_event', event: {} })).toEqual({ kind: 'turn-start', text: null });
  });

  it('holds init and a running state as preamble: a warm query emits init with no prompt behind it', () => {
    expect(classifyParkedChunk({ type: 'system', subtype: 'init' })).toEqual({ kind: 'preamble' });
    expect(classifyParkedChunk({ type: 'system', subtype: 'session_state_changed', state: 'running' }))
      .toEqual({ kind: 'preamble' });
  });

  it('drops the frames that trail a finished turn', () => {
    for (const chunk of [
      { type: 'prompt_suggestion', suggestion: 'x' },
      { type: 'result', subtype: 'success' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      { type: 'system', subtype: 'hook_response' },
      { type: 'rate_limit_event' },
    ]) {
      expect(classifyParkedChunk(chunk)).toEqual({ kind: 'noise' });
    }
  });

  it('reports an unknown shape instead of guessing that a turn started', () => {
    expect(classifyParkedChunk({ type: 'brand_new' })).toEqual({ kind: 'unknown' });
    expect(classifyParkedChunk({ type: 'system', subtype: 'brand_new' })).toEqual({ kind: 'unknown' });
    // A tool result is not a prompt.
    expect(classifyParkedChunk({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }))
      .toEqual({ kind: 'unknown' });
  });
});

describe('bridge state', () => {
  it('shows only ready and connected as up; unknown values read as connecting', () => {
    expect(mapBridgeState('ready')).toBe('ready');
    expect(mapBridgeState('connected')).toBe('connected');
    expect(mapBridgeState('reconnecting')).toBe('reconnecting');
    expect(mapBridgeState('disconnected')).toBe('disconnected');
    expect(mapBridgeState('failed')).toBe('error');
    expect(mapBridgeState('something_else')).toBe('connecting');
    expect(isBridgeUp(mapBridgeState('something_else'))).toBe(false);
  });
});

describe('extractUserPromptText / describeChunkShape', () => {
  it('reads string and block content, and logs shapes without values', () => {
    expect(extractUserPromptText({ type: 'user', message: { content: '  hi  ' } })).toBe('hi');
    expect(extractUserPromptText({ type: 'user', message: { content: [{ type: 'image' }] } })).toBeNull();
    const shape = describeChunkShape({ type: 'system', subtype: 'bridge_state', session_url: 'https://claude.ai/code/session_secret' });
    expect(shape).toBe('system/bridge_state keys=[session_url,subtype,type]');
    expect(shape).not.toContain('claude.ai');
  });
});

describe('replayingIterator', () => {
  it('replays buffered chunks, then the in-flight next, then the source', async () => {
    async function* source() { yield 'c'; }
    const inner = source();
    const iterator = replayingIterator(['a'], Promise.resolve({ value: 'b', done: false }), inner);
    const values: unknown[] = [];
    for (let result = await iterator.next(); !result.done; result = await iterator.next()) values.push(result.value);
    expect(values).toEqual(['a', 'b', 'c']);
  });
});

describe('asRemoteControlQuery', () => {
  it('returns null for a query without the undeclared method', () => {
    expect(asRemoteControlQuery({})).toBeNull();
    expect(asRemoteControlQuery(null)).toBeNull();
    const query = { enableRemoteControl: async () => ({}) };
    expect(asRemoteControlQuery(query)).toBe(query);
  });
});
