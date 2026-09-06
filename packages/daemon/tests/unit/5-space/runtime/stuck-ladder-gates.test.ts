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
    const state = makeState();
    const observedAt = observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: 6_000, startedAt: 1_000 },
      makeMessage({ timestamp: 4_000 }),
      NOW
    );
    expect(observedAt).toBe(6_000);
  });

  test('observedAt falls back to startedAt, then lastActionAt, then now', () => {
    const state = makeState({ lastActionAt: 3_000 });
    expect(
      observeExecutionProgress(
        state,
        { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 2_000 },
        null,
        NOW
      )
    ).toBe(2_000);
    expect(
      observeExecutionProgress(
        state,
        { agentSessionId: 'session-1', lastActivityAt: null, startedAt: null },
        null,
        NOW
      )
    ).toBe(3_000);
    expect(
      observeExecutionProgress(
        makeState(),
        { agentSessionId: 'session-1', lastActivityAt: null, startedAt: null },
        null,
        NOW
      )
    ).toBe(NOW);
  });

  test('a session change resets the ladder and rebinds observations', () => {
    const state = spentState({ lastSessionId: 'session-old' });
    const message = makeMessage({ dbId: 'msg-new', timestamp: 4_500 });
    const observedAt = observeExecutionProgress(
      state,
      { agentSessionId: 'session-new', lastActivityAt: null, startedAt: 1_000 },
      message,
      NOW
    );
    expect(observedAt).toBe(4_500);
    expect(state.lastSessionId).toBe('session-new');
    expect(state.lastObservedMessageId).toBe('msg-new');
    expect(state.lastObservedMessageAt).toBe(4_500);
    expect(state.lastObservedProgressMessageId).toBe('msg-new');
    expect(state.lastObservedProgressMessageAt).toBe(4_500);
    expect(state.lastRuntimeNagMessageId).toBeNull();
    expect(state.lastAction).toBeNull();
    expect(state.lastActionAt).toBeNull();
    expect(state.nagCount).toBe(0);
    expect(state.restartCount).toBe(0);
    expect(state.pendingRestartNotice).toBeNull();
  });

  test('a new progress message resets the ladder but keeps the session binding', () => {
    const state = spentState({ lastObservedMessageId: 'msg-old' });
    const message = makeMessage({ dbId: 'msg-new', timestamp: 7_000 });
    const observedAt = observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 1_000 },
      message,
      NOW
    );
    expect(observedAt).toBe(7_000);
    expect(state.lastSessionId).toBe('session-1');
    expect(state.lastObservedMessageId).toBe('msg-new');
    expect(state.lastObservedProgressMessageId).toBe('msg-new');
    expect(state.nagCount).toBe(0);
    expect(state.restartCount).toBe(0);
    expect(state.lastAction).toBeNull();
    expect(state.pendingRestartNotice).toBeNull();
  });

  test('the runtime nag message itself is tracked but never counts as progress', () => {
    const state = spentState({
      lastObservedMessageId: 'msg-old',
      lastObservedProgressMessageId: 'msg-progress',
      lastRuntimeNagMessageId: 'msg-nag',
    });
    const nag = makeMessage({ type: 'user', dbId: 'msg-nag', timestamp: 8_000 });
    const observedAt = observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 1_000 },
      nag,
      NOW
    );
    expect(observedAt).toBe(1_000);
    expect(state.lastObservedMessageId).toBe('msg-nag');
    expect(state.lastObservedMessageAt).toBe(8_000);
    expect(state.lastObservedProgressMessageId).toBe('msg-progress');
    expect(state.nagCount).toBe(MAX_AGENT_STUCK_NAGS);
    expect(state.restartCount).toBe(MAX_AGENT_STUCK_RESTARTS);
    expect(state.lastAction).toBe('restart');
  });

  test('an unchanged last message leaves the ladder untouched', () => {
    const state = spentState({ lastObservedMessageId: 'msg-1' });
    observeExecutionProgress(
      state,
      { agentSessionId: 'session-1', lastActivityAt: null, startedAt: 1_000 },
      makeMessage({ dbId: 'msg-1', timestamp: 5_000 }),
      NOW
    );
    expect(state.nagCount).toBe(MAX_AGENT_STUCK_NAGS);
    expect(state.restartCount).toBe(MAX_AGENT_STUCK_RESTARTS);
    expect(state.lastAction).toBe('restart');
  });
});

describe('decideStuckLadderAction', () => {
  test('within the threshold the ladder holds', () => {
    const state = makeState();
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state,
      })
    ).toEqual({ action: 'within_threshold' });
  });

  test('a stale execution with nag budget remaining nags first', () => {
    const state = makeState();
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state,
      })
    ).toEqual({ action: 'nag' });
  });

  test('a spent nag still inside its grace window waits', () => {
    const state = spentState({
      restartCount: 0,
      lastAction: 'nag',
      lastActionAt: NOW - NAG_GRACE_MS + 1,
    });
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state,
      })
    ).toEqual({ action: 'wait_nag_grace' });
  });

  test('a nag exactly past its grace window proceeds to restart', () => {
    const state = spentState({
      restartCount: 0,
      lastAction: 'nag',
      lastActionAt: NOW - NAG_GRACE_MS,
    });
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state,
      })
    ).toEqual({ action: 'restart' });
  });

  test('no nag grace applies when the last action was not a nag', () => {
    const state = spentState({ restartCount: 0, lastAction: null, lastActionAt: null });
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state,
      })
    ).toEqual({ action: 'restart' });
  });

  test('an exhausted ladder blocks', () => {
    const state = spentState();
    expect(
      decideStuckLadderAction({
        now: NOW,
        observedAt: NOW - THRESHOLD_MS - 1,
        thresholdMs: THRESHOLD_MS,
        nagGraceMs: NAG_GRACE_MS,
        state,
      })
    ).toEqual({ action: 'block' });
  });
});
