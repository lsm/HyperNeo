import { isDeepStrictEqual } from 'node:util';
import type { SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { isValidTaskTransition } from '../../tasks/transitions.ts';
import {
  prepareSpaceTaskStatusUpdate,
  prepareSpaceTaskReviewUpdate,
  isTerminalTaskStatus,
} from '../managers/task-status-preparation.ts';
import {
  directSessionIsDown,
  verifyDirectAttemptStop,
  type DirectAttemptStopDependencies,
  type VerifiedDirectStop,
} from './stop-direct-attempt.ts';

type OutcomeStatus = 'review' | 'blocked' | 'cancelled' | 'stopped';
type StatusOptions = Parameters<typeof prepareSpaceTaskStatusUpdate>[2];
export interface DirectFinalizationInput {
  attemptId: string;
  sessionId: string;
  generation: number;
  status: OutcomeStatus;
  options?: StatusOptions;
  reviewReason?: string | null;
}
interface FrozenFinalization extends DirectFinalizationInput {
  fromStatus: SpaceTaskStatus;
  lifecycleGeneration: number;
}
export type DirectFinalizationResult =
  | { finalized: true; attempt: DirectTaskAttempt; task: SpaceTask }
  | { finalized: false; reason: 'unavailable' | 'unverified' | 'superseded' };
interface Dependencies {
  db: Database;
  reactiveDb?: ReactiveDatabase;
  sessionManager: DirectAttemptStopDependencies['sessionManager'];
  onTaskReopened?: (taskId: string) => void;
  onTerminalTransition?: (taskId: string, fromStatus: SpaceTaskStatus) => void;
}

function matchesTarget(
  input: DirectFinalizationInput,
  attempt: DirectTaskAttempt | null,
  task: SpaceTask | null
): boolean {
  return (
    !!attempt &&
    !!task &&
    attempt.id === input.attemptId &&
    attempt.sessionId === input.sessionId &&
    attempt.generation === input.generation &&
    task.id === attempt.taskId &&
    !task.workflowRunId &&
    task.taskAgentSessionId === input.sessionId
  );
}

function readRequest(
  db: Database,
  input: DirectFinalizationInput
): (FrozenFinalization & { state: string | null }) | null {
  const row = db
    .prepare(
      'SELECT finalization_json AS payload, finalization_state AS state FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?'
    )
    .get(input.attemptId, input.sessionId) as {
    payload: string | null;
    state: string | null;
  } | null;
  return row?.payload
    ? { ...(JSON.parse(row.payload) as FrozenFinalization), state: row.state }
    : null;
}

function requestFinalization(db: Database, input: DirectFinalizationInput) {
  return db.transaction(() => {
    const attempts = new DirectTaskExecutionRepository(db);
    const attempt = attempts.get(input.attemptId);
    const tasks = new SpaceTaskRepository(db);
    const task = attempt ? tasks.getTask(attempt.taskId) : null;
    const unavailable = {
      reason: { finalized: false, reason: 'unavailable' } as DirectFinalizationResult,
    };
    if (
      !attempt ||
      attempt.sessionId !== input.sessionId ||
      attempt.generation !== input.generation
    )
      return unavailable;
    const frozen = readRequest(db, input);
    if (frozen) {
      const {
        fromStatus: _fromStatus,
        lifecycleGeneration: frozenGeneration,
        state,
        ...savedInput
      } = frozen;
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(input)), savedInput)) return unavailable;
      if (state === 'superseded')
        return { reason: { finalized: false, reason: 'superseded' } as DirectFinalizationResult };
      if (
        state === 'completed' &&
        attempt.phase === 'stopped' &&
        matchesTarget(input, attempt, task) &&
        task?.status === frozen.status &&
        tasks.getLifecycleGeneration(task.id) === frozenGeneration + 1
      )
        return { reason: { finalized: true, attempt, task } as DirectFinalizationResult };
      if (attempt.phase !== 'running' || state !== null) return unavailable;
      return { value: attempt };
    }
    if (
      !matchesTarget(input, attempt, task) ||
      !task ||
      attempt.phase !== 'running' ||
      attempts.isStopRequested(attempt.id, attempt.sessionId) ||
      !['review', 'blocked', 'cancelled', 'stopped'].includes(input.status) ||
      !isValidTaskTransition(task.status, input.status)
    )
      return unavailable;
    const lifecycleGeneration = tasks.getLifecycleGeneration(task.id)!;
    attempts.requestStop(attempt.id, attempt.sessionId, input.status);
    db.prepare(
      'UPDATE direct_task_stop_requests SET finalization_json = ? WHERE attempt_id = ? AND session_id = ?'
    ).run(
      JSON.stringify({ ...input, fromStatus: task.status, lifecycleGeneration }),
      attempt.id,
      attempt.sessionId
    );
    return { value: attempt };
  }, 'immediate')();
}

function commitFinalization(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  sessionManager: Dependencies['sessionManager'],
  onTerminalTransition: Dependencies['onTerminalTransition'],
  onTaskReopened: Dependencies['onTaskReopened'],
  input: DirectFinalizationInput,
  verified: VerifiedDirectStop
): DirectFinalizationResult {
  const { attempt, session, token } = verified;
  const attempts = new DirectTaskExecutionRepository(db);
  try {
    if (
      sessionManager.isSessionLoading(attempt.sessionId) ||
      sessionManager.getCachedSession(attempt.sessionId) ||
      (session && !directSessionIsDown(session))
    ) {
      attempts.clearStopVerification(attempt.id, attempt.sessionId, token);
      return { finalized: false, reason: 'unverified' };
    }
  } catch {
    attempts.clearStopVerification(attempt.id, attempt.sessionId, token);
    return { finalized: false, reason: 'unverified' };
  }
  reactiveDb?.beginTransaction();
  try {
    const result = db.transaction((): DirectFinalizationResult => {
      const current = attempts.get(attempt.id);
      const tasks = new SpaceTaskRepository(db, reactiveDb);
      const task = current ? tasks.getTask(current.taskId) : null;
      const request = readRequest(db, input);
      if (
        !current ||
        current.sessionId !== input.sessionId ||
        current.generation !== input.generation ||
        !request ||
        request.generation !== current.generation ||
        request.status !== input.status
      )
        return { finalized: false, reason: 'unavailable' };
      if (request.state === 'superseded') return { finalized: false, reason: 'superseded' };
      const matchesTask = matchesTarget(input, current, task) && !!task;
      if (
        request.state === 'completed' &&
        current.phase === 'stopped' &&
        matchesTask &&
        task &&
        task.status === request.status &&
        tasks.getLifecycleGeneration(task.id) === request.lifecycleGeneration + 1
      )
        return { finalized: true, attempt: current, task };
      if (current.phase !== 'running' || request.state !== null)
        return { finalized: false, reason: 'unavailable' };
      const stopped = attempts.finishRequestedStop(
        current.id,
        current.sessionId,
        current.generation,
        token
      );
      if (!stopped) return { finalized: false, reason: 'unavailable' };
      const mark = db.prepare(
        'UPDATE direct_task_stop_requests SET finalization_state = ? WHERE attempt_id = ? AND session_id = ?'
      );
      if (
        !matchesTask ||
        !task ||
        task.status !== request.fromStatus ||
        tasks.getLifecycleGeneration(task.id) !== request.lifecycleGeneration
      ) {
        mark.run('superseded', current.id, current.sessionId);
        return { finalized: false, reason: 'superseded' };
      }
      const { updates, reopened } = prepareSpaceTaskStatusUpdate(
        task,
        request.status,
        request.options,
        Date.now()
      );
      if (request.status === 'review')
        Object.assign(
          updates,
          prepareSpaceTaskReviewUpdate(
            {
              submittedByNodeId: null,
              reason: request.reviewReason ?? null,
              reportedSummary: request.options?.reportedSummary,
            },
            Date.now()
          )
        );
      const updated = tasks.updateTask(task.id, updates, request.fromStatus);
      if (!updated) throw new Error('Direct finalization lost its transaction admission');
      if (reopened) onTaskReopened?.(task.id);
      if (isTerminalTaskStatus(request.status)) onTerminalTransition?.(task.id, task.status);
      mark.run('completed', current.id, current.sessionId);
      return { finalized: true, attempt: stopped, task: updated };
    }, 'immediate')();
    reactiveDb?.commitTransaction();
    return result;
  } catch (error) {
    reactiveDb?.abortTransaction();
    throw error;
  }
}

export function createDirectTaskFinalizer(dependencies: Dependencies) {
  return (
    superpipe({
      ...dependencies,
      attempts: new DirectTaskExecutionRepository(dependencies.db),
      tasks: new SpaceTaskRepository(dependencies.db),
      sessionManager: dependencies.sessionManager,
    })('finalize-direct-task-attempt') as PipelineAPI
  )
    .input('input')
    .pipe(requestFinalization, ['db', 'input'], 'result:outcome')
    .pipe((attempt: DirectTaskAttempt) => attempt, 'outcome', 'attempt')
    .pipe(
      verifyDirectAttemptStop,
      ['attempts', 'tasks', 'sessionManager', 'attempt'],
      'verification'
    )
    .pipe(
      (verification: Awaited<ReturnType<typeof verifyDirectAttemptStop>>) =>
        'value' in verification
          ? verification
          : {
              reason: {
                finalized: false,
                reason: verification.reason.stopped ? 'unavailable' : verification.reason.reason,
              },
            },
      'verification',
      'result:outcome'
    )
    .pipe(
      commitFinalization,
      [
        'db',
        'reactiveDb',
        'sessionManager',
        'onTerminalTransition',
        'onTaskReopened',
        'input',
        'outcome',
      ],
      'outcome'
    )
    .endAsync('outcome') as (input: DirectFinalizationInput) => Promise<DirectFinalizationResult>;
}
