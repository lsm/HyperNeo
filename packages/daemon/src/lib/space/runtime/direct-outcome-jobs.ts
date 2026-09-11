import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { JobQueueProcessor } from '../../../storage/job-queue-processor.ts';
import type {
  JobQueueRepository,
  Job,
} from '../../../storage/repositories/job-queue-repository.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import {
  requestDirectTaskFinalization,
  readDirectFinalizationRequest,
  commitDirectTaskFinalization,
  requireDirectFinalizationVerification,
  type DirectFinalizationInput,
  type DirectFinalizationResult,
  type DirectTaskFinalizerDependencies,
} from './finalize-direct-attempt.ts';
import { verifyDirectAttemptStop } from './stop-direct-attempt.ts';

export const DIRECT_TASK_OUTCOME = 'direct_task_outcome';
export type DirectOutcomeAcknowledgement =
  | { accepted: true; jobId: string | null }
  | { accepted: false; reason: string };

function receipt(
  db: Database,
  input: Pick<DirectFinalizationInput, 'attemptId' | 'sessionId'>
): string | null {
  const row = db
    .prepare(
      'SELECT finalization_job_id AS id FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?'
    )
    .get(input.attemptId, input.sessionId) as { id: string | null } | null;
  return row?.id ?? null;
}

function frozenInput(
  db: Database,
  target: Pick<DirectFinalizationInput, 'attemptId' | 'sessionId'>
): DirectFinalizationInput | null {
  const frozen = readDirectFinalizationRequest(db, target);
  if (!frozen) return null;
  const { fromStatus: _status, lifecycleGeneration: _revision, state: _state, ...input } = frozen;
  return input;
}

function enqueueOutcome(
  db: Database,
  jobQueue: JobQueueRepository,
  input: DirectFinalizationInput
): DirectOutcomeAcknowledgement {
  return db.transaction((): DirectOutcomeAcknowledgement => {
    const request = requestDirectTaskFinalization(db, input);
    if ('reason' in request)
      return request.reason.finalized
        ? { accepted: true, jobId: receipt(db, input) }
        : { accepted: false, reason: request.reason.reason };
    const existing = receipt(db, input);
    if (existing) return { accepted: true, jobId: existing };
    const job = jobQueue.enqueue({
      queue: DIRECT_TASK_OUTCOME,
      payload: {
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        generation: input.generation,
      },
    });
    db.prepare(
      'UPDATE direct_task_stop_requests SET finalization_job_id = ? WHERE attempt_id = ? AND session_id = ?'
    ).run(job.id, input.attemptId, input.sessionId);
    return { accepted: true, jobId: job.id };
  }, 'immediate')();
}

export function createDirectOutcomeRequester(db: Database, jobQueue: JobQueueRepository) {
  return (superpipe({ db, jobQueue })('request-direct-task-outcome') as PipelineAPI)
    .input('input')
    .pipe(enqueueOutcome, ['db', 'jobQueue', 'input'], 'result')
    .end('result') as (input: DirectFinalizationInput) => DirectOutcomeAcknowledgement;
}

function loadLinkedOutcome(
  db: Database,
  job: Job
): { value: DirectFinalizationInput } | { reason: DirectFinalizationResult } {
  const { attemptId, sessionId, generation } = job.payload;
  const unavailable = {
    reason: { finalized: false, reason: 'unavailable' } as DirectFinalizationResult,
  };
  if (
    job.queue !== DIRECT_TASK_OUTCOME ||
    typeof attemptId !== 'string' ||
    typeof sessionId !== 'string'
  )
    return unavailable;
  const target = { attemptId, sessionId };
  const input = frozenInput(db, target);
  return input && receipt(db, target) === job.id && input.generation === generation
    ? { value: input }
    : unavailable;
}

export function createDirectOutcomeHandler(deps: DirectTaskFinalizerDependencies) {
  const run = (
    superpipe({
      ...deps,
      attempts: new DirectTaskExecutionRepository(deps.db),
      tasks: new SpaceTaskRepository(deps.db),
    })('process-direct-task-outcome') as PipelineAPI
  )
    .input('job')
    .pipe(loadLinkedOutcome, ['db', 'job'], 'result:outcome')
    .pipe((input: DirectFinalizationInput) => input, 'outcome', 'input')
    .pipe(requestDirectTaskFinalization, ['db', 'input'], 'result:outcome')
    .pipe((attempt: DirectTaskAttempt) => attempt, 'outcome', 'attempt')
    .pipe(
      verifyDirectAttemptStop,
      ['attempts', 'tasks', 'sessionManager', 'attempt'],
      'verification'
    )
    .pipe(requireDirectFinalizationVerification, 'verification', 'result:outcome')
    .pipe(
      commitDirectTaskFinalization,
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
    .endAsync('outcome') as (job: Job) => Promise<DirectFinalizationResult>;
  return async (job: Job) => {
    const result = await run(job);
    if (!result.finalized && result.reason === 'unverified')
      throw new Error('Direct outcome shutdown remains unverified');
    return result;
  };
}

export function registerDirectOutcomeJobs(
  deps: DirectTaskFinalizerDependencies & {
    jobQueue: JobQueueRepository;
    jobProcessor: Pick<JobQueueProcessor, 'register'>;
  }
): void {
  deps.jobProcessor.register(DIRECT_TASK_OUTCOME, createDirectOutcomeHandler(deps));
  const pending = deps.db
    .prepare(`SELECT r.attempt_id AS attemptId, r.session_id AS sessionId
    FROM direct_task_stop_requests r JOIN direct_task_execution_attempts a ON a.id = r.attempt_id
    WHERE r.finalization_json IS NOT NULL AND r.finalization_state IS NULL
      AND r.finalization_job_id IS NULL AND a.phase <> 'stopped'`)
    .all() as Array<{ attemptId: string; sessionId: string }>;
  for (const target of pending) {
    const input = frozenInput(deps.db, target);
    if (input) enqueueOutcome(deps.db, deps.jobQueue, input);
  }
}
