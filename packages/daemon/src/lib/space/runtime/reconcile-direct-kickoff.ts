import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import {
  JobQueueRepository,
  type Job,
} from '../../../storage/repositories/job-queue-repository.ts';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { canonicalJson } from '../../agent/prompt-comparison.ts';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../mailbox/enqueue.ts';
import { mailboxEntryExpired, parseMailboxEntry, type MailboxEntry } from '../../mailbox/entry.ts';
import { readDirectKickoffIntent } from './direct-kickoff-intent.ts';
import {
  loadDirectTaskWorkerEvidence,
  requireDirectTaskWorkerIdentity,
} from './direct-task-worker-identity.ts';
import {
  directQuerySessionId,
  loadDirectTaskQueryState,
  requireRunningDirectTaskQuery,
  type DirectTaskQueryAdmissionInput,
} from './direct-task-query-admission.ts';

type Outcome =
  | { kind: 'enqueued'; jobId: string }
  | { kind: 'existing'; jobId: string; status: Job['status'] }
  | { kind: 'settled'; status: 'consumed' | 'failed' }
  | { kind: 'blocked'; reason: 'invalid_intent' | 'expired' | 'missing_job' | 'conflict' };
interface DispatchState {
  job: Job | null;
  receipt: { job_id: string | null } | null;
  settled: 'consumed' | 'failed' | null;
}

function requireKickoffEntry(
  db: Database,
  input: DirectTaskQueryAdmissionInput
): { value: MailboxEntry } | { reason: Outcome } {
  const entry = readDirectKickoffIntent(db, input.attemptId);
  return entry?.to.kind === 'session' && entry.to.sessionId === input.sessionId && entry.messageUuid
    ? { value: entry }
    : { reason: { kind: 'blocked', reason: 'invalid_intent' } };
}

function recordReceipt(db: Database, input: DirectTaskQueryAdmissionInput, jobId: string | null) {
  db.prepare(
    'INSERT INTO direct_task_kickoff_dispatches(attempt_id, job_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  ).run(input.attemptId, jobId);
}

function inspectDispatch(
  db: Database,
  jobs: JobQueueRepository,
  messages: SDKMessageRepository,
  input: DirectTaskQueryAdmissionInput,
  entry: MailboxEntry
): DispatchState {
  const job = jobs.getLatestByPayload(MAILBOX_LANE, { id: entry.id });
  const settled = messages.getMessageByStatusAndUuid(input.sessionId, 'failed', entry.messageUuid!)
    ? 'failed'
    : messages.hasConsumptionEvidence(input.sessionId, entry.messageUuid!) ||
        messages.getMessageByStatusAndUuid(input.sessionId, 'consumed', entry.messageUuid!)
      ? 'consumed'
      : null;
  if (job || settled) recordReceipt(db, input, job?.id ?? null);
  const receipt = db
    .prepare('SELECT job_id FROM direct_task_kickoff_dispatches WHERE attempt_id = ?')
    .get(input.attemptId) as DispatchState['receipt'];
  return { job, settled, receipt };
}

export function decideDirectKickoffDispatch(
  entry: MailboxEntry,
  state: DispatchState,
  now: number
): { value: MailboxEntry } | { reason: Outcome } {
  if (state.settled) return { reason: { kind: 'settled', status: state.settled } };
  if (
    state.job &&
    (canonicalJson(parseMailboxEntry(state.job.payload)) !== canonicalJson(entry) ||
      state.receipt?.job_id !== state.job.id)
  )
    return { reason: { kind: 'blocked', reason: 'conflict' } };
  if (mailboxEntryExpired(entry, now)) return { reason: { kind: 'blocked', reason: 'expired' } };
  if (state.job)
    return { reason: { kind: 'existing', jobId: state.job.id, status: state.job.status } };
  if (state.receipt) return { reason: { kind: 'blocked', reason: 'missing_job' } };
  return { value: entry };
}

function enqueueFrozenKickoff(
  db: Database,
  jobs: JobQueueRepository,
  input: DirectTaskQueryAdmissionInput,
  entry: MailboxEntry
): Outcome {
  const outcome = enqueueMailboxEntry(jobs, entry);
  if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  const job = jobs.getLatestByPayload(MAILBOX_LANE, { id: entry.id });
  if (!job) throw new Error('Direct kickoff enqueue did not persist a job');
  recordReceipt(db, input, job.id);
  return { kind: 'enqueued', jobId: job.id };
}

export function createDirectKickoffReconciler(db: Database) {
  const attempts = new DirectTaskExecutionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  const sessions = new SessionRepository(db);
  const dependencies = {
    db,
    jobs: new JobQueueRepository(db),
    messages: new SDKMessageRepository(db),
    getSession: (id: string) => sessions.getSession(id),
    getTask: (id: string) => tasks.getTask(id),
    getActiveAttempt: (id: string) => attempts.getActive(id),
    getSpace: (id: string) => spaces.getSpace(id),
    isStopRequested: (id: string, sessionId: string) => attempts.isStopRequested(id, sessionId),
  };
  const reconcile = (superpipe(dependencies)('reconcile-direct-task-kickoff') as PipelineAPI)
    .input('input')
    .pipe(directQuerySessionId, ['input'], 'sessionId')
    .pipe(
      loadDirectTaskWorkerEvidence,
      ['sessionId', 'getSession', 'getTask', 'getActiveAttempt'],
      'evidence'
    )
    .pipe(requireDirectTaskWorkerIdentity, ['sessionId', 'evidence'], 'result:identity')
    .pipe(loadDirectTaskQueryState, ['identity', 'getSpace', 'isStopRequested'], 'queryState')
    .pipe(
      requireRunningDirectTaskQuery,
      ['input', 'identity', 'evidence', 'queryState'],
      'result:identity'
    )
    .pipe(requireKickoffEntry, ['db', 'input'], 'result:dispatch')
    .pipe(inspectDispatch, ['db', 'jobs', 'messages', 'input', 'dispatch'], 'dispatchState')
    .pipe(Date.now, undefined, 'now')
    .pipe(decideDirectKickoffDispatch, ['dispatch', 'dispatchState', 'now'], 'result:dispatch')
    .pipe(enqueueFrozenKickoff, ['db', 'jobs', 'input', 'dispatch'], 'dispatch')
    .end('dispatch') as (input: DirectTaskQueryAdmissionInput) => Outcome | null;
  return (input: DirectTaskQueryAdmissionInput): Outcome | null =>
    db.transaction(() => reconcile(input), 'immediate')();
}
