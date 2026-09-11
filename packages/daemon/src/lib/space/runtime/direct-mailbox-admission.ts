import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { canonicalJson } from '../../agent/prompt-comparison.ts';
import { mailboxEntryExpired, type MailboxEntry } from '../../mailbox/entry.ts';
import { readDirectKickoffIntent } from './direct-kickoff-intent.ts';
import {
  loadDirectTaskWorkerEvidence,
  requireDirectTaskWorkerIdentity,
  type DirectTaskWorkerEvidence,
  type DirectTaskWorkerIdentity,
} from './direct-task-worker-identity.ts';
import {
  loadDirectTaskQueryState,
  requireRunningDirectTaskQuery,
  type DirectTaskQueryState,
} from './direct-task-query-admission.ts';
import { resolveTaskWorkspace } from './spawn-slot-resolution.ts';

export type DirectMailboxAdmission = 'admit' | 'settled' | 'blocked';
interface BoundMailbox {
  fingerprint: string;
  status: 'admit' | 'settled';
}
interface KickoffState {
  frozen: MailboxEntry | null;
  receipt: boolean;
  settled: boolean;
}

function loadKickoffState(
  db: Database,
  messages: SDKMessageRepository,
  identity: DirectTaskWorkerIdentity
): KickoffState {
  const frozen = readDirectKickoffIntent(db, identity.attemptId);
  const uuid = frozen?.messageUuid;
  return {
    frozen,
    receipt: !!db
      .prepare('SELECT 1 FROM direct_task_kickoff_dispatches WHERE attempt_id = ?')
      .get(identity.attemptId),
    settled:
      !!uuid &&
      (messages.hasConsumptionEvidence(identity.sessionId, uuid) ||
        !!messages.getMessageByStatusAndUuid(identity.sessionId, 'consumed', uuid) ||
        !!messages.getMessageByStatusAndUuid(identity.sessionId, 'failed', uuid)),
  };
}

function requireBoundMailbox(
  identity: DirectTaskWorkerIdentity,
  evidence: DirectTaskWorkerEvidence,
  state: DirectTaskQueryState,
  entry: MailboxEntry,
  kickoff: KickoffState,
  now: number,
  expected: BoundMailbox | null
): { value: BoundMailbox } | { reason: null } {
  const { frozen } = kickoff;
  if (
    !frozen ||
    !evidence.task ||
    !state.space ||
    entry.to.kind !== 'session' ||
    entry.to.sessionId !== identity.sessionId
  )
    return { reason: null };
  const isKickoff =
    entry.id === frozen.id || (!!entry.messageUuid && entry.messageUuid === frozen.messageUuid);
  if (isKickoff && (canonicalJson(entry) !== canonicalJson(frozen) || !kickoff.receipt))
    return { reason: null };
  const settled = isKickoff && (kickoff.settled || expected?.status === 'settled');
  if (!settled && mailboxEntryExpired(entry, now)) return { reason: null };
  const fingerprint = canonicalJson({
    identity,
    workspacePath: resolveTaskWorkspace(state.space, evidence.task),
    entry,
    frozen,
  });
  return expected && expected.fingerprint !== fingerprint
    ? { reason: null }
    : { value: { fingerprint, status: settled ? 'settled' : 'admit' } };
}

export function captureDirectMailboxAdmission(
  db: Database,
  entry: MailboxEntry
): (() => DirectMailboxAdmission) | undefined {
  if (entry.to.kind !== 'session') return undefined;
  const sessionId = entry.to.sessionId;
  const attempts = new DirectTaskExecutionRepository(db);
  if (!attempts.hasSessionProvenance(sessionId)) return undefined;
  const sessions = new SessionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  const read = (
    superpipe({
      db,
      sessionId,
      entry,
      messages: new SDKMessageRepository(db),
      getSession: (id: string) => sessions.getSession(id),
      getTask: (id: string) => tasks.getTask(id),
      getActiveAttempt: (id: string) => attempts.getActive(id),
      getSpace: (id: string) => spaces.getSpace(id),
      isStopRequested: (id: string, sid: string) => attempts.isStopRequested(id, sid),
    })('admit-direct-mailbox-delivery') as PipelineAPI
  )
    .input('expected')
    .pipe(
      loadDirectTaskWorkerEvidence,
      ['sessionId', 'getSession', 'getTask', 'getActiveAttempt'],
      'evidence'
    )
    .pipe(requireDirectTaskWorkerIdentity, ['sessionId', 'evidence'], 'result:admission')
    .pipe(loadDirectTaskQueryState, ['admission', 'getSpace', 'isStopRequested'], 'queryState')
    .pipe(
      requireRunningDirectTaskQuery,
      ['admission', 'admission', 'evidence', 'queryState'],
      'result:admission'
    )
    .pipe(loadKickoffState, ['db', 'messages', 'admission'], 'kickoff')
    .pipe(Date.now, undefined, 'now')
    .pipe(
      requireBoundMailbox,
      ['admission', 'evidence', 'queryState', 'entry', 'kickoff', 'now', 'expected'],
      'result:admission'
    )
    .end('admission') as (expected: BoundMailbox | null) => BoundMailbox | null;
  const expected = read(null);
  return expected ? () => read(expected)?.status ?? 'blocked' : () => 'blocked';
}
