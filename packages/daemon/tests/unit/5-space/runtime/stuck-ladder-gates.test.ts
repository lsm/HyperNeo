import { describe, expect, test } from 'bun:test';
import {
  MAX_AGENT_STUCK_NAGS,
  MAX_AGENT_STUCK_RESTARTS,
} from '../../../../src/lib/space/runtime/constants';
import {
  createAgentStuckRecoveryState,
  decideStuckLadderAction,
  observeExecutionProgress,
  type AgentStuckRecoveryState,
} from '../../../../src/lib/space/runtime/anti-stuck/stuck-ladder-gates';

const NOW = 10_000;
const THRESHOLD_MS = 15 * 60 * 1000;
const NAG_GRACE_MS = 2 * 60 * 1000;

function makeMessage(overrides: { type?: string; dbId?: string; timestamp?: number } = {}) {
  return {
    type: overrides.type ?? 'assistant',
    dbId: overrides.dbId ?? 'msg-1',
    timestamp: overrides.timestamp ?? 5_000,
  };
}

function makeState(overrides: Partial<AgentStuckRecoveryState> = {}): AgentStuckRecoveryState {
  return {
    ...createAgentStuckRecoveryState('session-1'),
    ...overrides,
  };
}

function spentState(overrides: Partial<AgentStuckRecoveryState> = {}): AgentStuckRecoveryState {
  return makeState({
    nagCount: MAX_AGENT_STUCK_NAGS,
    restartCount: MAX_AGENT_STUCK_RESTARTS,
    lastAction: 'restart',
    lastActionAt: NOW - THRESHOLD_MS - NAG_GRACE_MS,
    ...overrides,
  });
}

describe('createAgentStuckRecoveryState', () => {
  test('initializes counters bound to the current session with no observations', () => {
    expect(createAgentStuckRecoveryState('session-1')).toEqual({
      nagCount: 0,
      restartCount: 0,
      lastAction: null,
      lastActionAt: null,
      lastObservedMessageId: null,
      lastObservedMessageAt: null,
      lastObservedProgressMessageId: null,
      lastObservedProgressMessageAt: null,
      lastRuntimeNagMessageId: null,
      lastSessionId: 'session-1',
      pendingRestartNotice: null,
    });
  });
});

describe('observeExecutionProgress', () => {
  test('observedAt is the max of lastActivityAt and the latest non-nag message timestamp', () => {
    const result = observeExecutionProgress(
      makeState(),
      { agentSessionId: 'session-1', lastActivityAt: 6_000, startedAt: 1_000 },
      makeMessage({ timestamp: 4_000 }),
      NOW
    );
    expect(result.observedAt).toBe(6_000);
  });

  test('observedAt falls back to startedAt, then lastActionAt, then now', () => {
    expect(
      observeExecutionProgress(
        makeState({ lastActionAt: 3_000 }),
        { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 2_000 },
        null,
        NOW
      ).observedAt
    ).toBe(2_000);
    expect(
      observeExecutionProgress(
        makeState({ lastActionAt: 3_000 }),
        { agentSessionId: 'session-1', lastActivityAt: null, startedAt: null },
        null,
        NOW
      ).observedAt
    ).toBe(3_000);
    expect(
      observeExecutionProgress(
        makeState(),
        { agentSessionId: 'session-1', lastActivityAt: null, startedAt: null },
        null,
        NOW
      ).observedAt
    ).toBe(NOW);
  });

  test('a session change returns a rebound state and never mutates the input', () => {
    const state = spentState({ lastSessionId: 'session-old' });
    const snapshot = { ...state };
    const message = makeMessage({ dbId: 'msg-new', timestamp: 4_500 });
    const result = observeExecutionProgress(
      state,
      { agentSessionId: 'session-new', lastActivityAt: null, startedAt: 1_000 },
      message,
      NOW
    );
    expect(result.observedAt).toBe(4_500);
    expect(result.state).not.toBe(state);
    expect(result.state.lastSessionId).toBe('session-new');
    expect(result.state.lastObservedMessageId).toBe('msg-new');
    expect(result.state.lastObservedMessageAt).toBe(4_500);
    expect(result.state.lastObservedProgressMessageId).toBe('msg-new');
    expect(result.state.lastObservedProgressMessageAt).toBe(4_500);
    expect(result.state.lastRuntimeNagMessageId).toBeNull();
    expect(result.state.lastAction).toBeNull();
    expect(result.state.lastActionAt).toBeNull();
    expect(result.state.nagCount).toBe(0);
    expect(result.state.restartCount).toBe(0);
    expect(result.state.pendingRestartNotice).toBeNull();
    expect(state).toEqual(snapshot);
  });

  test('a new progress message returns a ladder-reset state and never mutates the input', () => {
    const state = spentState({ lastObservedMessageId: 'msg-old' });
    const snapshot = { ...state };
    const message = makeMessage({ dbId: 'msg-new', timestamp: 7_000 });
    const result = observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 1_000 },
      message,
      NOW
    );
    expect(result.observedAt).toBe(7_000);
    expect(result.state).not.toBe(state);
    expect(result.state.lastSessionId).toBe('session-1');
    expect(result.state.lastObservedMessageId).toBe('msg-new');
    expect(result.state.lastObservedProgressMessageId).toBe('msg-new');
    expect(result.state.nagCount).toBe(0);
    expect(result.state.restartCount).toBe(0);
    expect(result.state.lastAction).toBeNull();
    expect(result.state.pendingRestartNotice).toBeNull();
    expect(state).toEqual(snapshot);
  });

  test('the runtime nag message is tracked but never counts as progress', () => {
    const state = spentState({
      lastObservedMessageId: 'msg-old',
      lastObservedProgressMessageId: 'msg-progress',
      lastRuntimeNagMessageId: 'msg-nag',
    });
    const snapshot = { ...state };
    const nag = makeMessage({ type: 'user', dbId: 'msg-nag', timestamp: 8_000 });
    const result = observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 1_000 },
      nag,
      NOW
    );
    expect(result.observedAt).toBe(1_000);
    expect(result.state).not.toBe(state);
    expect(result.state.lastObservedMessageId).toBe('msg-nag');
    expect(result.state.lastObservedMessageAt).toBe(8_000);
    expect(result.state.lastObservedProgressMessageId).toBe('msg-progress');
    expect(result.state.nagCount).toBe(MAX_AGENT_STUCK_NAGS);
    expect(result.state.restartCount).toBe(MAX_AGENT_STUCK_RESTARTS);
    expect(result.state.lastAction).toBe('restart');
    expect(state).toEqual(snapshot);
  });

  test('an unchanged last message returns the input state by reference', () => {
    const state = spentState({ lastObservedMessageId: 'msg-1' });
    const result = observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 1_000 },
      makeMessage({ dbId: 'msg-1', timestamp: 5_000 }),
      NOW
    );
    expect(result.state).toBe(state);
  });
});

describe('decideStuckLadderAction', () => {
  test('within the threshold the ladder holds', () => {
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state: makeState(),
      })
    ).toEqual({ action: 'within_threshold' });
  });

  test('a stale execution with nag budget remaining nags first', () => {
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state: makeState(),
      })
    ).toEqual({ action: 'nag' });
  });

  test('a spent nag still inside its grace window waits', () => {
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state: spentState({
          restartCount: 0,
          lastAction: 'nag',
          lastActionAt: NOW - NAG_GRACE_MS + 1,
        }),
      })
    ).toEqual({ action: 'wait_nag_grace' });
  });

  test('a nag exactly past its grace window proceeds to restart', () => {
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state: spentState({
          restartCount: 0,
          lastAction: 'nag',
          lastActionAt: NOW - NAG_GRACE_MS,
        }),
      })
    ).toEqual({ action: 'restart' });
  });

  test('no nag grace applies when the last action was not a nag', () => {
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state: spentState({ restartCount: 0, lastAction: null, lastActionAt: null }),
      })
    ).toEqual({ action: 'restart' });
  });

  test('an exhausted ladder blocks', () => {
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state: spentState(),
      })
    ).toEqual({ action: 'block' });
  });
});
