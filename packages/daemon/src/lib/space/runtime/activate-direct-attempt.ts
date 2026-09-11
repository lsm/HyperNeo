import { readDirectKickoffIntent } from './direct-kickoff-intent.ts';
import { mailboxEntryExpired, type MailboxEntry } from '../../mailbox/entry.ts';
import type { Session, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { assertValidTaskTransition } from '../../tasks/transitions.ts';
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
  | { activated: false; reason: 'unavailable' };
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
}

export function requireDirectActivation(
  input: DirectAttemptActivationInput,
  evidence: DirectAttemptActivationEvidence,
  now: number
):
  | { value: { attempt: DirectTaskAttempt; task: SpaceTask } }
  | { reason: DirectAttemptActivationResult } {
  const { attempt, active, task, space, session, selected, stopRequested, dependencies } = evidence;
  const prepared = requireReservedDirectTask(attempt, active, selected, task, space, stopRequested);
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
        dependency.spaceId !== task.spaceId ||
        dependency.status !== 'done'
    )
  )
    return { reason: { activated: false, reason: 'unavailable' } };
  return { value: { attempt, task: prepared.value.task } };
}

function activateAtomically(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  input: DirectAttemptActivationInput
): DirectAttemptActivationResult {
  reactiveDb?.beginTransaction();
  try {
    const result = db.transaction((): DirectAttemptActivationResult => {
      const attempts = new DirectTaskExecutionRepository(db);
      const tasks = new SpaceTaskRepository(db, reactiveDb);
      const attempt = attempts.get(input.attemptId);
      const task = attempt ? tasks.getTask(attempt.taskId) : null;
      const admission = requireDirectActivation(
        input,
        {
          attempt,
          active: task ? attempts.getActive(task.id) : null,
          task,
          space: task ? new SpaceRepository(db).getSpace(task.spaceId) : null,
          session: new SessionRepository(db).getSession(input.sessionId),
          selected: !!task && attempts.isSelected(task.id),
          stopRequested: attempts.isStopRequested(input.attemptId, input.sessionId),
          kickoff: readDirectKickoffIntent(db, input.attemptId),
          dependencies: (task?.dependsOn ?? []).map((id) => tasks.getTask(id)),
        },
        Date.now()
      );
      if ('reason' in admission) return admission.reason;
      assertValidTaskTransition(admission.value.task.status, 'in_progress');
      const updated = tasks.updateTask(
        admission.value.task.id,
        {
          status: 'in_progress',
          taskAgentSessionId: input.sessionId,
        },
        'open'
      );
      const activated = attempts.activate(input.attemptId, input.sessionId);
      if (!updated || !activated)
        throw new Error('Direct activation lost its transaction admission');
      return { activated: true, attempt: activated, task: updated };
    }, 'immediate')();
    reactiveDb?.commitTransaction();
    return result;
  } catch (error) {
    reactiveDb?.abortTransaction();
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
    .pipe(activateAtomically, ['db', 'reactiveDb', 'input'], 'result')
    .end('result') as (input: DirectAttemptActivationInput) => DirectAttemptActivationResult;
}
