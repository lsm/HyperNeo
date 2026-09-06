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

export interface ExecutionProgressObservation {
  observedAt: number;
  state: AgentStuckRecoveryState;
}

export function observeExecutionProgress(
  state: AgentStuckRecoveryState,
  execution: StuckLadderExecutionSnapshot,
  lastMessage: StuckLadderMessageSnapshot | null,
  now: number
): ExecutionProgressObservation {
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
    return {
      observedAt,
      state: {
        ...state,
        lastSessionId: execution.agentSessionId,
        lastObservedMessageId: lastMessage?.dbId ?? null,
        lastObservedMessageAt: lastMessage?.timestamp ?? null,
        lastObservedProgressMessageId: progressMessage?.dbId ?? null,
        lastObservedProgressMessageAt: progressMessage?.timestamp ?? null,
        lastRuntimeNagMessageId: null,
        lastAction: null,
        lastActionAt: null,
        nagCount: 0,
        restartCount: 0,
        pendingRestartNotice: null,
      },
    };
  }

  if (state.lastObservedMessageId !== (lastMessage?.dbId ?? null)) {
    const progressed =
      progressMessage && state.lastObservedProgressMessageId !== progressMessage.dbId
        ? {
            ...state,
            lastObservedProgressMessageId: progressMessage.dbId,
            lastObservedProgressMessageAt: progressMessage.timestamp,
            lastAction: null,
            lastActionAt: null,
            nagCount: 0,
            restartCount: 0,
            pendingRestartNotice: null,
          }
        : state;
    return {
      observedAt,
      state: {
        ...progressed,
        lastObservedMessageId: lastMessage?.dbId ?? null,
        lastObservedMessageAt: lastMessage?.timestamp ?? null,
      },
    };
  }

  return { observedAt, state };
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
