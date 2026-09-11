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
  | { finalized: false; reason: 'unavailable' | 'unverified' };
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

function readRequest(db: Database, input: DirectFinalizationInput): FrozenFinalization | null {
  const row = db
    .prepare(
      'SELECT finalization_json AS payload FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?'
    )
    .get(input.attemptId, input.sessionId) as { payload: string | null } | null;
  return row?.payload ? (JSON.parse(row.payload) as FrozenFinalization) : null;
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
    if (!matchesTarget(input, attempt, task) || !attempt || !task) return unavailable;
    const lifecycleGeneration = tasks.getLifecycleGeneration(task.id)!;
    const frozen = readRequest(db, input);
    if (frozen) {
      const { fromStatus, lifecycleGeneration: frozenGeneration, ...savedInput } = frozen;
      if (
        !isDeepStrictEqual(JSON.parse(JSON.stringify(input)), savedInput) ||
        lifecycleGeneration !== frozenGeneration + (attempt.phase === 'stopped' ? 1 : 0)
      )
        return unavailable;
      if (attempt.phase === 'stopped' && task.status === frozen.status)
        return { reason: { finalized: true, attempt, task } as DirectFinalizationResult };
      if (attempt.phase !== 'running' || task.status !== fromStatus) return unavailable;
      return { value: attempt };
    }
    if (
      attempt.phase !== 'running' ||
      attempts.isStopRequested(attempt.id, attempt.sessionId) ||
      !['review', 'blocked', 'cancelled', 'stopped'].includes(input.status) ||
      !isValidTaskTransition(task.status, input.status)
    )
      return unavailable;
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
        !matchesTarget(input, current, task) ||
        !current ||
        !task ||
        !request ||
        request.generation !== current.generation ||
        request.status !== input.status ||
        tasks.getLifecycleGeneration(task.id) !==
          request.lifecycleGeneration + (current.phase === 'stopped' ? 1 : 0)
      )
        return { finalized: false, reason: 'unavailable' };
      if (current.phase === 'stopped' && task.status === request.status)
        return { finalized: true, attempt: current, task };
      if (current.phase !== 'running' || task.status !== request.fromStatus)
        return { finalized: false, reason: 'unavailable' };
      const stopped = attempts.finishRequestedStop(
        current.id,
        current.sessionId,
        current.generation,
        token
      );
      if (!stopped) return { finalized: false, reason: 'unavailable' };
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
