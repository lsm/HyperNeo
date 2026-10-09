import type { Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import { canonicalJson } from '../agent/prompt-comparison.ts';
import { mailboxEntryExpired, type MailboxEntry } from '../mailbox/entry.ts';
import { readDirectKickoffIntent } from './direct-kickoff-intent.ts';
import type {
  DirectTaskWorkerEvidence,
  DirectTaskWorkerIdentity,
} from './direct-task-worker-identity.ts';
import {
  admitRunningDirectQuery,
  databaseDirectTaskQueryLookups,
  type DirectTaskQueryState,
  type RunningDirectQuery,
} from './direct-task-query-admission.ts';
import { matchesDirectPreparedSession } from './prepare-direct-session.ts';
import { directTaskWorkspace } from './direct-task-workspace.ts';

type BoundStart = Pick<
  DirectTaskWorkerIdentity,
  'sessionId' | 'attemptId' | 'generation' | 'taskId' | 'spaceId'
> & { kickoff: string; workspacePath: string };
interface KickoffProof {
  entry: MailboxEntry | null;
  receipt: boolean;
  delivery: ReturnType<SDKMessageRepository['getDeliveryContent']>;
}

function readKickoffProof(
  db: Database,
  messages: SDKMessageRepository,
  identity: DirectTaskWorkerIdentity
): KickoffProof {
  const entry = readDirectKickoffIntent(db, identity.attemptId);
  return {
    entry,
    receipt: !!db
      .prepare('SELECT 1 FROM direct_task_kickoff_dispatches WHERE attempt_id = ?')
      .get(identity.attemptId),
    delivery: entry?.messageUuid
      ? messages.getDeliveryContent(identity.sessionId, entry.messageUuid)
      : null,
  };
}

function requireBoundStart(
  identity: DirectTaskWorkerIdentity,
  evidence: DirectTaskWorkerEvidence,
  state: DirectTaskQueryState,
  session: Session,
  proof: KickoffProof,
  expected: BoundStart | null,
  now: number
): { value: BoundStart } | { reason: null } {
  const { entry, receipt, delivery } = proof;
  if (
    !entry?.messageUuid ||
    entry.to.kind !== 'session' ||
    entry.to.sessionId !== identity.sessionId ||
    !receipt ||
    !delivery ||
    !['enqueued', 'submitted', 'consumed'].includes(delivery.sendStatus) ||
    (delivery.sendStatus !== 'consumed' && mailboxEntryExpired(entry, now)) ||
    canonicalJson(delivery.content) !== canonicalJson(entry.message.message.content) ||
    !evidence.attempt ||
    !evidence.task ||
    !state.space
  )
    return { reason: null };
  const workspacePath = directTaskWorkspace(state.space, evidence.task, state.worktreePath);
  if (
    !matchesDirectPreparedSession(session, {
      attempt: evidence.attempt,
      task: evidence.task,
      workspacePath,
    })
  )
    return { reason: null };
  const bound: BoundStart = {
    sessionId: identity.sessionId,
    attemptId: identity.attemptId,
    generation: identity.generation,
    taskId: identity.taskId,
    spaceId: identity.spaceId,
    kickoff: canonicalJson(entry),
    workspacePath,
  };
  return expected && canonicalJson(expected) !== canonicalJson(bound)
    ? { reason: null }
    : { value: bound };
}

function unavailable(): never {
  const error = new Error('Direct task session requires executor activation admission');
  error.name = 'AbortError';
  throw error;
}

export function createDirectQueryStartGuard(
  db: Database,
  getSession: () => Session
): (() => void) | undefined {
  const sessionId = getSession().id;
  const attempts = new DirectTaskExecutionRepository(db);
  if (!attempts.hasSessionProvenance(sessionId)) return undefined;
  const read = (
    superpipe({
      db,
      messages: new SDKMessageRepository(db),
      lookups: databaseDirectTaskQueryLookups(db),
    })('guard-direct-query-start') as PipelineAPI
  )
    .input(['sessionId', 'session', 'expected'])
    .pipe(admitRunningDirectQuery, ['lookups', 'sessionId'], 'result:start')
    .pipe((running: RunningDirectQuery) => running, 'start', [
      'identity:start',
      'evidence',
      'queryState',
    ])
    .pipe(readKickoffProof, ['db', 'messages', 'start'], 'proof')
    .pipe(Date.now, undefined, 'now')
    .pipe(
      requireBoundStart,
      ['start', 'evidence', 'queryState', 'session', 'proof', 'expected', 'now'],
      'result:start'
    )
    .end('start') as (
    sessionId: string,
    session: Session,
    expected: BoundStart | null
  ) => BoundStart | null;
  const expected = read(sessionId, getSession(), null) ?? unavailable();
  return () => {
    if (!read(sessionId, getSession(), expected)) unavailable();
  };
}
