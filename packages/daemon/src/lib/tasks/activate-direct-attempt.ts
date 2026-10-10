import { readDirectTaskWorktreePath } from './direct-task-workspace.ts';
import { availableTaskSlots, readTaskSlotUsage, type TaskSlotUsage } from './capacity.ts';
import { readDirectStartRequest } from './direct-start-request.ts';
import { enqueueFrozenKickoff } from './reconcile-direct-kickoff.ts';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { readDirectKickoffIntent, recordDirectKickoffAtomically } from './direct-kickoff-intent.ts';
import { mailboxEntryExpired, type MailboxEntry, type MailboxMessage } from '../mailbox/entry.ts';
import type { Session, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../storage/reactive-database.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { assertValidTaskTransition } from './transitions.ts';
import { requireDirectTaskWorkerIdentity } from './direct-task-worker-identity.ts';
import {
  matchesDirectPreparedSession,
  requireReservedDirectTask,
} from './prepare-direct-session.ts';

export interface DirectAttemptActivationInput {
  attemptId: string;
  sessionId: string;
}
export type DirectAttemptActivationResult =
  | { activated: true; attempt: DirectTaskAttempt; task: SpaceTask }
  | { activated: false; reason: 'unavailable' | DirectActivationWait };
export type DirectActivationWait = 'awaiting_capacity' | 'awaiting_dependencies';
export const DIRECT_ACTIVATION_WAITS: ReadonlySet<string> = new Set<DirectActivationWait>([
  'awaiting_capacity',
  'awaiting_dependencies',
]);
class ActivationRejected extends Error {
  constructor(readonly result: DirectAttemptActivationResult) {
    super('Direct activation rejected');
  }
}
export interface DirectAttemptActivationEvidence {
  attempt: DirectTaskAttempt | null;
  active: DirectTaskAttempt | null;
  task: SpaceTask | null;
  space: Space | null;
  session: Session | null;
  selected: boolean;
  stopRequested: boolean;
  kickoff: MailboxEntry | null;
  dependencies: Array<SpaceTask | null>;
  worktreePath: string | null;
}

export function requireDirectActivation(
  input: DirectAttemptActivationInput,
  evidence: DirectAttemptActivationEvidence,
  now: number
):
  | { value: { attempt: DirectTaskAttempt; task: SpaceTask } }
  | { reason: DirectAttemptActivationResult } {
  const { attempt, active, task, space, session, selected, stopRequested, dependencies } = evidence;
  const prepared = requireReservedDirectTask(
    attempt,
    active,
    selected,
    task,
    space,
    stopRequested,
    evidence.worktreePath
  );
  const identity = requireDirectTaskWorkerIdentity(input.sessionId, {
    session,
    task,
    attempt: active,
  });
  if (
    'reason' in prepared ||
    'reason' in identity ||
    attempt?.id !== input.attemptId ||
    attempt.sessionId !== input.sessionId ||
    space?.status !== 'active' ||
    space.paused ||
    space.stopped ||
    evidence.kickoff?.to.kind !== 'session' ||
    evidence.kickoff.to.sessionId !== input.sessionId ||
    evidence.kickoff.origin !== 'direct-task-kickoff' ||
    !evidence.kickoff.messageUuid ||
    evidence.kickoff.deliveryMode !== 'immediate' ||
    mailboxEntryExpired(evidence.kickoff, now) ||
    !session ||
    !matchesDirectPreparedSession(session, prepared.value) ||
    dependencies.length !== (task?.dependsOn?.length ?? 0) ||
    dependencies.some(
      (dependency, index) =>
        !dependency ||
        dependency.id !== task?.dependsOn?.[index] ||
        dependency.spaceId !== task.spaceId
    )
  )
    return { reason: { activated: false, reason: 'unavailable' } };
  if (dependencies.some((dependency) => dependency?.status !== 'done'))
    return { reason: { activated: false, reason: 'awaiting_dependencies' } };
  return { value: { attempt, task: prepared.value.task } };
}

type ActivationGate<T> = { value: T } | { reason: DirectAttemptActivationResult };
const unavailable = { reason: { activated: false, reason: 'unavailable' } } as const;
interface DirectActivationTarget {
  attempt: DirectTaskAttempt | null;
  task: SpaceTask | null;
  slots: TaskSlotUsage;
  admittedGeneration: number | null;
  lifecycleGeneration: number | null;
}

function readActivationTarget(
  db: Database,
  input: DirectAttemptActivationInput
): DirectActivationTarget {
  const tasks = new SpaceTaskRepository(db);
  const attempt = new DirectTaskExecutionRepository(db).get(input.attemptId);
  const task = attempt ? tasks.getTask(attempt.taskId) : null;
  return {
    attempt,
    task,
    slots: task ? readTaskSlotUsage(db, task.spaceId) : { space: null, running: 0 },
    admittedGeneration: readDirectStartRequest(db, input.attemptId)?.lifecycleGeneration ?? null,
    lifecycleGeneration: task ? tasks.getLifecycleGeneration(task.id) : null,
  };
}

export function requireActivationCapacity(
  target: DirectActivationTarget
): ActivationGate<DirectActivationTarget> {
  const { attempt, task, slots } = target;
  if (availableTaskSlots(slots.space, slots.running) > 0) return { value: target };
  return task && slots.space && attempt?.phase === 'reserved'
    ? { reason: { activated: false, reason: 'awaiting_capacity' } }
    : unavailable;
}

export function requireAdmittedGeneration(
  target: DirectActivationTarget
): ActivationGate<DirectActivationTarget> {
  return target.admittedGeneration !== null &&
    target.lifecycleGeneration !== target.admittedGeneration
    ? unavailable
    : { value: target };
}

function recordActivationKickoff(
  db: Database,
  input: DirectAttemptActivationInput,
  kickoffMessage: MailboxMessage | undefined
): 'none' | 'recorded' | 'lost' {
  if (!kickoffMessage) return 'none';
  return recordDirectKickoffAtomically(db, { ...input, message: kickoffMessage }).recorded
    ? 'recorded'
    : 'lost';
}

export function requireKickoffRecorded(
  kickoff: 'none' | 'recorded' | 'lost'
): ActivationGate<boolean> {
  return kickoff === 'lost' ? unavailable : { value: true };
}

function readActivationEvidence(
  db: Database,
  input: DirectAttemptActivationInput,
  { attempt, task, slots }: DirectActivationTarget
): DirectAttemptActivationEvidence {
  const attempts = new DirectTaskExecutionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  return {
    attempt,
    active: task ? attempts.getActive(task.id) : null,
    task,
    space: slots.space,
    session: new SessionRepository(db).getSession(input.sessionId),
    selected: !!task && attempts.isSelected(task.id),
    stopRequested: attempts.isStopRequested(input.attemptId, input.sessionId),
    kickoff: readDirectKickoffIntent(db, input.attemptId),
    dependencies: (task?.dependsOn ?? []).map((id) => tasks.getTask(id)),
    worktreePath: task ? readDirectTaskWorktreePath(db)(task.spaceId, task.id) : null,
  };
}

function rollBackRejectedKickoff<T>(
  admission: ActivationGate<T>,
  kickoffMessage: MailboxMessage | undefined
): ActivationGate<T> {
  if ('reason' in admission && kickoffMessage) throw new ActivationRejected(admission.reason);
  return admission;
}

function commitActivation(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  input: DirectAttemptActivationInput,
  kickoffMessage: MailboxMessage | undefined,
  admitted: { attempt: DirectTaskAttempt; task: SpaceTask }
): DirectAttemptActivationResult {
  const attempts = new DirectTaskExecutionRepository(db);
  assertValidTaskTransition(admitted.task.status, 'in_progress');
  const updated = new SpaceTaskRepository(db, reactiveDb).updateTask(
    admitted.task.id,
    {
      status: 'in_progress',
      taskAgentSessionId: input.sessionId,
    },
    'open'
  );
  const activated = attempts.activate(input.attemptId, input.sessionId);
  if (!updated || !activated) throw new Error('Direct activation lost its transaction admission');
  if (kickoffMessage)
    enqueueFrozenKickoff(
      db,
      new JobQueueRepository(db),
      {
        ...input,
        generation: activated.generation,
      },
      readDirectKickoffIntent(db, activated.id)!
    );
  return { activated: true, attempt: activated, task: updated };
}

const runActivation = (superpipe({})('activate-direct-attempt-in-transaction') as PipelineAPI)
  .input(['db', 'reactiveDb', 'input', 'kickoffMessage'])
  .pipe(readActivationTarget, ['db', 'input'], 'target')
  .pipe(requireActivationCapacity, 'target', 'result:activation')
  .pipe(requireAdmittedGeneration, 'target', 'result:activation')
  .pipe(recordActivationKickoff, ['db', 'input', 'kickoffMessage'], 'kickoff')
  .pipe(requireKickoffRecorded, 'kickoff', 'result:activation')
  .pipe(readActivationEvidence, ['db', 'input', 'target'], 'evidence')
  .pipe(() => Date.now(), undefined, 'now')
  .pipe(requireDirectActivation, ['input', 'evidence', 'now'], 'admission')
  .pipe(rollBackRejectedKickoff, ['admission', 'kickoffMessage'], 'result:activation')
  .pipe(
    commitActivation,
    ['db', 'reactiveDb', 'input', 'kickoffMessage', 'activation'],
    'activation'
  )
  .end('activation') as (
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  input: DirectAttemptActivationInput,
  kickoffMessage: MailboxMessage | undefined
) => DirectAttemptActivationResult;

export function activateDirectAttemptAtomically(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  input: DirectAttemptActivationInput,
  kickoffMessage?: MailboxMessage
): DirectAttemptActivationResult {
  reactiveDb?.beginTransaction();
  try {
    const result = db.transaction(
      () => runActivation(db, reactiveDb, input, kickoffMessage),
      'immediate'
    )();
    reactiveDb?.commitTransaction();
    return result;
  } catch (error) {
    reactiveDb?.abortTransaction();
    if (error instanceof ActivationRejected) return error.result;
    throw error;
  }
}

export function createDirectAttemptActivator(dependencies: {
  db: Database;
  reactiveDb?: ReactiveDatabase;
}) {
  return (
    superpipe({ db: dependencies.db, reactiveDb: dependencies.reactiveDb })(
      'activate-direct-task-attempt'
    ) as PipelineAPI
  )
    .input('input')
    .pipe(activateDirectAttemptAtomically, ['db', 'reactiveDb', 'input'], 'result')
    .end('result') as (input: DirectAttemptActivationInput) => DirectAttemptActivationResult;
}
