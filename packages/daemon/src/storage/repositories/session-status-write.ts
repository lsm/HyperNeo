import type { Session } from '@hyperneo/shared';

export type SessionStatus = Session['status'];

export type SessionStatusRefusal = 'stale-status' | 'terminal-task';

export type SessionWriteOutcome = 'written' | SessionStatusRefusal;

export interface SessionStatusFacts {
  readonly status: SessionStatus;
  readonly terminalTask: boolean;
}

export const TERMINAL_TASK_SESSION_ARCHIVE_STATUSES = ['done', 'cancelled', 'archived'] as const;

export function refuseSessionStatusWrite(
  next: SessionStatus,
  readStatus: SessionStatus | null,
  facts: SessionStatusFacts | null
): SessionStatusRefusal | null {
  if (!facts || next === 'archived') return null;
  if (facts.status !== readStatus) return 'stale-status';
  if (facts.status === 'archived' && facts.terminalTask) return 'terminal-task';
  return null;
}
