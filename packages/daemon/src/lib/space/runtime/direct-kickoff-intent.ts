import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import { canonicalJson } from '../../agent/prompt-comparison.ts';
import {
  createMailboxEntry,
  parseMailboxEntry,
  toMailboxMessage,
  type MailboxEntry,
  type MailboxMessage,
} from '../../mailbox/entry.ts';

export interface DirectKickoffInput {
  attemptId: string;
  sessionId: string;
  message: MailboxMessage;
}
export type DirectKickoffResult =
  | { recorded: true; entry: MailboxEntry }
  | { recorded: false; reason: 'unavailable' | 'invalid_message' | 'content_conflict' };

export function requireDirectKickoffClaim(
  attempt: DirectTaskAttempt | null,
  active: DirectTaskAttempt | null,
  stopRequested: boolean,
  input: DirectKickoffInput
): boolean {
  return (
    !!attempt &&
    attempt.id === input.attemptId &&
    attempt.sessionId === input.sessionId &&
    attempt.phase === 'reserved' &&
    active?.id === attempt.id &&
    active.generation === attempt.generation &&
    !stopRequested
  );
}

export function readDirectKickoffIntent(db: Database, attemptId: string): MailboxEntry | null {
  const row = db
    .prepare('SELECT entry FROM direct_task_kickoff_intents WHERE attempt_id = ?')
    .get(attemptId) as { entry: string } | null;
  if (!row) return null;
  const entry = parseMailboxEntry(JSON.parse(row.entry));
  if (!entry) throw new Error('Invalid persisted direct kickoff intent');
  return entry;
}

export function recordDirectKickoffAtomically(
  db: Database,
  input: DirectKickoffInput
): DirectKickoffResult {
  const projected = toMailboxMessage(input.message);
  if ('reason' in projected) return { recorded: false, reason: 'invalid_message' };
  return db.transaction((): DirectKickoffResult => {
    const attempts = new DirectTaskExecutionRepository(db);
    const attempt = attempts.get(input.attemptId);
    if (
      !requireDirectKickoffClaim(
        attempt,
        attempt ? attempts.getActive(attempt.taskId) : null,
        attempts.isStopRequested(input.attemptId, input.sessionId),
        input
      )
    )
      return { recorded: false, reason: 'unavailable' };
    const existing = readDirectKickoffIntent(db, input.attemptId);
    if (existing)
      return canonicalJson(existing.message) === canonicalJson(projected.message)
        ? { recorded: true, entry: existing }
        : { recorded: false, reason: 'content_conflict' };
    const entry = createMailboxEntry({
      to: { kind: 'session', sessionId: input.sessionId },
      message: projected.message,
      origin: 'direct-task-kickoff',
      messageUuid: randomUUID(),
    });
    db.prepare('INSERT INTO direct_task_kickoff_intents(attempt_id, entry) VALUES (?, ?)').run(
      input.attemptId,
      JSON.stringify(entry)
    );
    return { recorded: true, entry };
  }, 'immediate')();
}

export function createDirectKickoffRecorder(db: Database) {
  return (superpipe({ db })('record-direct-task-kickoff') as PipelineAPI)
    .input('input')
    .pipe(recordDirectKickoffAtomically, ['db', 'input'], 'result')
    .end('result') as (input: DirectKickoffInput) => DirectKickoffResult;
}
