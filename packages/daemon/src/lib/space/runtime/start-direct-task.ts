import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { enqueueDirectStartRequest } from './direct-start-request.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { requireDirectTaskWorkerIdentity } from './direct-task-worker-identity.ts';
import { requireRunningDirectTaskQuery } from './direct-task-query-admission.ts';
import { createHash } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { prepareSpaceTaskStatusUpdate } from '../managers/task-status-preparation.ts';
import {
  assertValidTaskTransition,
  assertQueuedTaskRetryTransition,
} from '../../tasks/transitions.ts';
import { buildCustomAgentTaskMessage } from '../agents/custom-agent.ts';
import { resolveTaskWorkspace } from './spawn-slot-resolution.ts';
import {
  readPreparation,
  prepareDormantSession,
  type DirectSessionPreparationDependencies,
  type PreparedDirectSession,
} from './prepare-direct-session.ts';
import { readDirectKickoffIntent } from './direct-kickoff-intent.ts';
import {
  activateDirectAttemptAtomically,
  type DirectAttemptActivationResult,
} from './activate-direct-attempt.ts';

export interface DirectTaskStartInput {
  taskId: string;
  requestKey: string;
  retryFrom?: { attemptId: string; generation: number };
  reviewRejection?: { expectedPendingCompletionGeneration: number; reason?: string | null };
}
export type DirectTaskStartResult =
  | { started: true; attempt: DirectTaskAttempt }
  | { started: false; reason: string };

export function directTaskStartIdentity(input: DirectTaskStartInput) {
  const id = createHash('sha256')
    .update(
      JSON.stringify(
        input.reviewRejection
          ? [
              input.taskId,
              input.requestKey,
              input.reviewRejection.expectedPendingCompletionGeneration,
              input.reviewRejection.reason ?? null,
            ]
          : [input.taskId, input.requestKey]
      )
    )
    .digest('hex');
  const attemptId = `direct-${id}`;
  const sessionId = `${attemptId}:session`;
  return { attemptId, sessionId };
}

export function claimDirectStart(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  input: DirectTaskStartInput,
  onTaskReopened?: (taskId: string) => void,
  startJobs?: JobQueueRepository
): { value: DirectTaskAttempt } | { reason: DirectTaskStartResult } {
  const unavailable = { reason: { started: false as const, reason: 'direct_start_unavailable' } };
  if (!input.requestKey.trim() || (input.reviewRejection && !input.retryFrom)) return unavailable;
  const { attemptId, sessionId } = directTaskStartIdentity(input);
  reactiveDb?.beginTransaction();
  try {
    const result = db.transaction(() => {
      const attempts = new DirectTaskExecutionRepository(db);
      const tasks = new SpaceTaskRepository(db, reactiveDb);
      let task = tasks.getTask(input.taskId);
      const space = task ? new SpaceRepository(db).getSpace(task.spaceId) : null;
      if (
        !task ||
        task.workflowRunId ||
        task.archivedAt ||
        space?.status !== 'active' ||
        space.paused ||
        space.stopped
      )
        return unavailable;
      const active = attempts.getActive(task.id);
      if (
        active &&
        (active.id !== attemptId ||
          active.sessionId !== sessionId ||
          attempts.isStopRequested(active.id, sessionId))
      )
        return unavailable;
      let reopenedTaskId: string | null = null;
      if (input.retryFrom && attempts.get(attemptId)?.phase === 'stopped') return unavailable;
      if (input.retryFrom) {
        const previous = attempts.get(input.retryFrom.attemptId);
        if (
          !previous ||
          previous.taskId !== task.id ||
          previous.phase !== 'stopped' ||
          previous.generation !== input.retryFrom.generation ||
          previous.id === attemptId ||
          (active && active.generation !== previous.generation + 1)
        )
          return unavailable;
        if (!active) {
          const row = db
            .prepare(
              'SELECT finalization_json AS payload, finalization_state AS state FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?'
            )
            .get(previous.id, previous.sessionId) as {
            payload: string | null;
            state: string | null;
          } | null;
          const finalization = row?.payload
            ? (JSON.parse(row.payload) as {
                status: string;
                lifecycleGeneration: number;
                generation: number;
              })
            : null;
          if (
            row?.state !== 'completed' ||
            !finalization ||
            finalization.generation !== previous.generation ||
            finalization.status !== task.status ||
            !(input.reviewRejection
              ? task.status === 'review' &&
                task.pendingCheckpointType === 'task_completion' &&
                task.pendingCompletionGeneration ===
                  input.reviewRejection.expectedPendingCompletionGeneration
              : ['blocked', 'cancelled', 'stopped'].includes(task.status)) ||
            tasks.getLifecycleGeneration(task.id) !== finalization.lifecycleGeneration + 1 ||
            task.taskAgentSessionId !== previous.sessionId
          )
            return unavailable;
          assertQueuedTaskRetryTransition(task.status);
          const { updates, reopened } = prepareSpaceTaskStatusUpdate(
            task,
            'open',
            undefined,
            Date.now()
          );
          task = tasks.updateTask(
            task.id,
            {
              ...updates,
              taskAgentSessionId: null,
              ...(input.reviewRejection
                ? { approvalReason: input.reviewRejection.reason ?? null }
                : {}),
            },
            task.status,
            input.reviewRejection?.expectedPendingCompletionGeneration
          );
          if (!task) throw new Error('Direct retry lost its atomic reopen');
          if (reopened) reopenedTaskId = task.id;
        }
      }
      if (active?.phase === 'running') {
        const evidence = {
          session: new SessionRepository(db).getSession(sessionId),
          task,
          attempt: active,
        };
        const identity = requireDirectTaskWorkerIdentity(sessionId, evidence);
        if (
          'reason' in identity ||
          'reason' in
            requireRunningDirectTaskQuery(identity.value, identity.value, evidence, {
              space,
              stopRequested: false,
            })
        )
          return unavailable;
        const kickoff = readDirectKickoffIntent(db, active.id);
        if (
          kickoff?.to.kind !== 'session' ||
          kickoff.to.sessionId !== sessionId ||
          !db
            .prepare('SELECT 1 FROM direct_task_kickoff_dispatches WHERE attempt_id = ?')
            .get(active.id)
        )
          return unavailable;
        return { reason: { started: true as const, attempt: active } };
      }
      if (
        !['draft', 'open'].includes(task.status) ||
        task.taskAgentSessionId ||
        attempts.get(attemptId)?.phase === 'stopped'
      )
        return unavailable;
      if (!attempts.select(task.id)) return unavailable;
      if (task.status === 'draft') {
        assertValidTaskTransition('draft', 'open');
        if (!tasks.updateTask(task.id, { status: 'open' }, 'draft'))
          throw new Error('Direct start lost draft publication');
      }
      const attempt = attempts.claim(task.id, attemptId, sessionId);
      if (!attempt) throw new Error('Direct start lost its atomic claim');
      if (startJobs) enqueueDirectStartRequest(db, startJobs, attempt.id, input);
      if (reopenedTaskId) onTaskReopened?.(reopenedTaskId);
      return { value: attempt };
    }, 'immediate')();
    reactiveDb?.commitTransaction();
    return result;
  } catch (error) {
    reactiveDb?.abortTransaction();
    throw error;
  }
}

function requireStartStage<T>(
  result: { value: T } | { reason: string },
  db: Database,
  input: DirectTaskStartInput
): { value: T } | { reason: DirectTaskStartResult } {
  return 'value' in result
    ? result
    : { reason: alreadyStarted(db, input) ?? { started: false, reason: result.reason } };
}

function alreadyStarted(db: Database, input: DirectTaskStartInput): DirectTaskStartResult | null {
  const active = new DirectTaskExecutionRepository(db).getActive(input.taskId);
  if (active?.phase !== 'running') return null;
  const outcome = claimDirectStart(db, undefined, input);
  return 'reason' in outcome && outcome.reason.started ? outcome.reason : null;
}

function kickoffInput(db: Database, prepared: PreparedDirectSession, input: DirectTaskStartInput) {
  const { attempt } = prepared;
  const existing = readDirectKickoffIntent(db, attempt.id);
  const tasks = new SpaceTaskRepository(db);
  const task = tasks.getTask(attempt.taskId);
  const space = task ? new SpaceRepository(db).getSpace(task.spaceId) : null;
  if (!task || !space) throw new Error('Direct start task disappeared during preparation');
  return {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    message: existing?.message ?? {
      type: 'user' as const,
      message: {
        content: buildCustomAgentTaskMessage({
          task,
          space,
          reviewFeedback: input.reviewRejection?.reason,
          workspacePath: resolveTaskWorkspace(space, task),
        }),
      },
      parent_tool_use_id: null,
    },
  };
}
function startResult(
  result: DirectAttemptActivationResult,
  db: Database,
  input: DirectTaskStartInput
): DirectTaskStartResult {
  return result.activated
    ? { started: true, attempt: result.attempt }
    : (alreadyStarted(db, input) ?? { started: false, reason: result.reason });
}

export function createDirectTaskStarter(dependencies: {
  db: Database;
  reactiveDb?: ReactiveDatabase;
  sessionDb: DirectSessionPreparationDependencies['db'];
  sessionManager: DirectSessionPreparationDependencies['sessionManager'];
  defaultModel: string;
  onTaskReopened?: (taskId: string) => void;
}) {
  const { db, reactiveDb, sessionDb, sessionManager, defaultModel } = dependencies;
  const attempts = new DirectTaskExecutionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  return (
    superpipe({
      db,
      reactiveDb,
      sessionDb,
      sessionManager,
      defaultModel,
      onTaskReopened: dependencies.onTaskReopened,
      attempts,
      tasks,
      getSpace: (id: string) => spaces.getSpace(id),
    })('start-direct-task') as PipelineAPI
  )
    .input('input')
    .pipe(claimDirectStart, ['db', 'reactiveDb', 'input', 'onTaskReopened'], 'result:start')
    .pipe((attempt: DirectTaskAttempt) => attempt.id, 'start', 'attemptId')
    .pipe(readPreparation, ['attempts', 'tasks', 'getSpace', 'attemptId'], 'preparation')
    .pipe(requireStartStage, ['preparation', 'db', 'input'], 'result:start')
    .pipe(
      prepareDormantSession,
      ['attempts', 'tasks', 'getSpace', 'sessionDb', 'sessionManager', 'defaultModel', 'start'],
      'preparation'
    )
    .pipe(requireStartStage, ['preparation', 'db', 'input'], 'result:start')
    .pipe(kickoffInput, ['db', 'start', 'input'], 'kickoff')
    .pipe((kickoff: { message: unknown }) => kickoff.message, 'kickoff', 'message')
    .pipe(activateDirectAttemptAtomically, ['db', 'reactiveDb', 'kickoff', 'message'], 'activation')
    .pipe(startResult, ['activation', 'db', 'input'], 'start')
    .endAsync('start') as (input: DirectTaskStartInput) => Promise<DirectTaskStartResult>;
}
