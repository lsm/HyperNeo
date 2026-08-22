import type { AgentProcessingState } from '@hyperneo/shared';
import type { VerifiedSessionStop } from './task-agent-manager';

export const VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS = 2;

export interface StopVerificationSnapshot {
  sessionPresent: boolean;
  processingStatus: AgentProcessingState['status'];
  interruptInProgress: boolean;
  livePids: readonly number[];
  interruptAttemptsSoFar: number;
  escalationDone: boolean;
}

export type SessionLiveness = { down: true } | { down: false; reason: string };

export type StopVerificationDecision =
  | { action: 'down' }
  | { action: 'retry_interrupt'; reason: string }
  | { action: 'escalate_terminate'; reason: string }
  | { action: 'report_leak'; reason: string };

export function isStopDownProcessingStatus(status: AgentProcessingState['status']): boolean {
  switch (status) {
    case 'idle':
    case 'interrupted':
      return true;
    case 'queued':
    case 'processing':
    case 'waiting_for_input':
    case 'rate_limit_cooldown':
      return false;
    default: {
      const _exhaustive: never = status;
      return Boolean(_exhaustive);
    }
  }
}

export interface SessionLivenessSnapshot {
  processingStatus: StopVerificationSnapshot['processingStatus'];
  interruptInProgress: boolean;
  livePids: readonly number[];
}

export function inspectSessionLiveness(snapshot: SessionLivenessSnapshot): SessionLiveness {
  if (!isStopDownProcessingStatus(snapshot.processingStatus)) {
    return { down: false, reason: `processing state '${snapshot.processingStatus}'` };
  }
  if (snapshot.interruptInProgress) {
    return { down: false, reason: 'interrupt still in progress' };
  }
  if (snapshot.livePids.length > 0) {
    return { down: false, reason: `live SDK process pid(s) ${snapshot.livePids.join(', ')}` };
  }
  return { down: true };
}

export function decideStopVerification(
  snapshot: StopVerificationSnapshot
): StopVerificationDecision {
  if (!snapshot.sessionPresent) return { action: 'down' };
  const liveness = inspectSessionLiveness(snapshot);
  if (liveness.down) return { action: 'down' };
  if (snapshot.interruptAttemptsSoFar < VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS) {
    return { action: 'retry_interrupt', reason: liveness.reason };
  }
  if (!snapshot.escalationDone) {
    return { action: 'escalate_terminate', reason: liveness.reason };
  }
  return { action: 'report_leak', reason: liveness.reason };
}

export interface VerifiedStopAssembly {
  sessionId: string;
  notes: readonly string[];
  decision: StopVerificationDecision;
}

export function assembleVerifiedStopResult(assembly: VerifiedStopAssembly): VerifiedSessionStop {
  if (assembly.decision.action === 'down') {
    if (assembly.notes.length === 0) {
      return { sessionId: assembly.sessionId, stopped: true };
    }
    return { sessionId: assembly.sessionId, stopped: true, detail: assembly.notes.join('; ') };
  }
  return {
    sessionId: assembly.sessionId,
    stopped: false,
    detail: [...assembly.notes, `still alive: ${assembly.decision.reason}`].join('; '),
  };
}
