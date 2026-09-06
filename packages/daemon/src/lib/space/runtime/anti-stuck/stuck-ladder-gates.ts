import { MAX_AGENT_STUCK_NAGS, MAX_AGENT_STUCK_RESTARTS } from '../constants.ts';

export interface AgentStuckRecoveryState {
  nagCount: number;
  restartCount: number;
  lastAction: 'nag' | 'restart' | 'blocked' | null;
  lastActionAt: number | null;
  lastObservedMessageId: string | null;
  lastObservedMessageAt: number | null;
  lastObservedProgressMessageId: string | null;
  lastObservedProgressMessageAt: number | null;
  lastRuntimeNagMessageId: string | null;
  lastSessionId: string | null;
  pendingRestartNotice: string | null;
}

export interface StuckLadderExecutionSnapshot {
  agentSessionId: string | null;
  lastActivityAt: number | null;
  startedAt: number | null;
}

export interface StuckLadderMessageSnapshot {
  type: string;
  dbId: string;
  timestamp: number;
}

export function createAgentStuckRecoveryState(
  agentSessionId: string | null
): AgentStuckRecoveryState {
  return {
    nagCount: 0,
    restartCount: 0,
    lastAction: null,
    lastActionAt: null,
    lastObservedMessageId: null,
    lastObservedMessageAt: null,
    lastObservedProgressMessageId: null,
    lastObservedProgressMessageAt: null,
    lastRuntimeNagMessageId: null,
    lastSessionId: agentSessionId,
    pendingRestartNotice: null,
  };
}

export function observeExecutionProgress(
  state: AgentStuckRecoveryState,
  execution: StuckLadderExecutionSnapshot,
  lastMessage: StuckLadderMessageSnapshot | null,
  now: number
): number {
  const isRuntimeNagMessage =
    lastMessage !== null &&
    lastMessage.type === 'user' &&
    lastMessage.dbId === state.lastRuntimeNagMessageId;
  const progressMessage = lastMessage !== null && !isRuntimeNagMessage ? lastMessage : null;
  const progressSignals = [execution.lastActivityAt, progressMessage?.timestamp].filter(
    (t): t is number => typeof t === 'number'
  );
  const observedAt =
    progressSignals.length > 0
      ? Math.max(...progressSignals)
      : (execution.startedAt ?? state.lastActionAt ?? now);

  if (state.lastSessionId !== execution.agentSessionId) {
    state.lastSessionId = execution.agentSessionId;
    state.lastObservedMessageId = lastMessage?.dbId ?? null;
    state.lastObservedMessageAt = lastMessage?.timestamp ?? null;
    state.lastObservedProgressMessageId = progressMessage?.dbId ?? null;
    state.lastObservedProgressMessageAt = progressMessage?.timestamp ?? null;
    state.lastRuntimeNagMessageId = null;
    state.lastAction = null;
    state.lastActionAt = null;
    state.nagCount = 0;
    state.restartCount = 0;
    state.pendingRestartNotice = null;
  } else if (state.lastObservedMessageId !== (lastMessage?.dbId ?? null)) {
    state.lastObservedMessageId = lastMessage?.dbId ?? null;
    state.lastObservedMessageAt = lastMessage?.timestamp ?? null;
    if (progressMessage && state.lastObservedProgressMessageId !== progressMessage.dbId) {
      state.lastObservedProgressMessageId = progressMessage.dbId;
      state.lastObservedProgressMessageAt = progressMessage.timestamp;
      state.lastAction = null;
      state.lastActionAt = null;
      state.nagCount = 0;
      state.restartCount = 0;
      state.pendingRestartNotice = null;
    }
  }
  return observedAt;
}

export type StuckLadderDecision =
  | { action: 'within_threshold' }
  | { action: 'nag' }
  | { action: 'wait_nag_grace' }
  | { action: 'restart' }
  | { action: 'block' };

export function decideStuckLadderAction(input: {
  now: number;
  observedAt: number;
  thresholdMs: number;
  nagGraceMs: number;
  state: AgentStuckRecoveryState;
}): StuckLadderDecision {
  const { now, observedAt, thresholdMs, nagGraceMs, state } = input;
  if (now - observedAt <= thresholdMs) return { action: 'within_threshold' };
  if (state.nagCount < MAX_AGENT_STUCK_NAGS) return { action: 'nag' };
  if (state.lastAction === 'nag' && state.lastActionAt !== null) {
    if (now - state.lastActionAt < nagGraceMs) return { action: 'wait_nag_grace' };
  }
  if (state.restartCount < MAX_AGENT_STUCK_RESTARTS) return { action: 'restart' };
  return { action: 'block' };
}
