import type { JobQueueProcessor } from '../../../storage/job-queue-processor.ts';
import { isTerminalTaskStatus } from '../managers/task-status-preparation.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import {
  createDirectAttemptStopper,
  type DirectAttemptStopDependencies,
} from './stop-direct-attempt.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import type {
  JobQueueRepository,
  Job,
} from '../../../storage/repositories/job-queue-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import {
  createDirectTaskStarter,
  claimDirectStart,
  directTaskStartIdentity,
  type DirectTaskStartInput,
  type DirectTaskStartResult,
} from './start-direct-task.ts';
import { DIRECT_TASK_START, readDirectStartRequest } from './direct-start-request.ts';

export type DirectStartAcknowledgement =
  | { accepted: true; jobId: string | null }
  | { accepted: false; reason: string };
export function acknowledgeDirectStart(
  db: Database,
  claim: ReturnType<typeof claimDirectStart>
): DirectStartAcknowledgement {
  if ('reason' in claim && !claim.reason.started)
    return { accepted: false, reason: claim.reason.reason };
  const attempt =
    'value' in claim
      ? claim.value
      : (claim.reason as Extract<DirectTaskStartResult, { started: true }>).attempt;
  return { accepted: true, jobId: readDirectStartRequest(db, attempt.id)?.jobId ?? null };
}
export function createDirectStartRequester(deps: {
  db: Database;
  reactiveDb?: ReactiveDatabase;
  jobQueue: JobQueueRepository;
  onTaskReopened?: (id: string) => void;
}) {
  return (superpipe({ ...deps })('request-direct-task-start') as PipelineAPI)
    .input('input')
    .pipe(claimDirectStart, ['db', 'reactiveDb', 'input', 'onTaskReopened', 'jobQueue'], 'claim')
    .pipe(acknowledgeDirectStart, ['db', 'claim'], 'result')
    .end('result') as (input: DirectTaskStartInput) => DirectStartAcknowledgement;
}
export function createDirectStartJobHandler(
  db: Database,
  start: (input: DirectTaskStartInput) => Promise<DirectTaskStartResult>,
  jobs: Pick<JobQueueRepository, 'requeue'>,
  sessionManager: DirectAttemptStopDependencies['sessionManager']
) {
  const attempts = new DirectTaskExecutionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const stop = createDirectAttemptStopper({ attempts, tasks, sessionManager });
  return async (job: Job) => {
    const attemptId = job.payload.attemptId;
    if (job.queue !== DIRECT_TASK_START || typeof attemptId !== 'string')
      return { started: false, reason: 'unlinked_job' };
    const request = readDirectStartRequest(db, attemptId);
    const attempt = attempts.get(attemptId);
    if (
      !request ||
      request.jobId !== job.id ||
      !attempt ||
      request.input.taskId !== attempt.taskId ||
      directTaskStartIdentity(request.input).attemptId !== attempt.id ||
      attempts.getActive(attempt.taskId)?.id !== attempt.id
    )
      return { started: false, reason: 'superseded' };
    const result = await start(request.input);
    if (result.started) return result;
    const current = attempts.getActive(attempt.taskId);
    if (current?.id !== attempt.id) return { started: false, reason: 'superseded' };
    const task = tasks.getTask(attempt.taskId);
    const space = task ? new SpaceRepository(db).getSpace(task.spaceId) : null;
    const terminal =
      !task ||
      !space ||
      task.workflowRunId ||
      task.archivedAt != null ||
      space.status !== 'active' ||
      isTerminalTaskStatus(task.status) ||
      task.status === 'archived' ||
      tasks.getLifecycleGeneration(task.id) !==
        request.lifecycleGeneration + (current.phase === 'running' ? 1 : 0);
    const retiring = !!db
      .prepare(
        "SELECT 1 FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ? AND outcome IN ('start_superseded', 'cancelled')"
      )
      .get(attempt.id, attempt.sessionId);
    if (terminal || retiring) {
      if (current.phase !== 'reserved') return { started: false, reason: 'superseded' };
      const stopped = await stop({
        attemptId: current.id,
        sessionId: current.sessionId,
        outcome: 'start_superseded',
      });
      if (stopped.stopped || attempts.getActive(attempt.taskId)?.id !== attempt.id)
        return { started: false, reason: 'superseded' };
    } else if (attempts.isStopRequested(attempt.id, attempt.sessionId))
      return { started: false, reason: 'superseded' };
    if (!job.claimToken) throw new Error(`Direct start remains unavailable: ${result.reason}`);
    if (jobs.requeue(job.id, Date.now() + 30_000, job.claimToken))
      return {
        ...result,
        parked: terminal || retiring ? 'direct_start_cleanup_unverified' : 'direct_start_not_ready',
      };
    return { started: false, reason: 'superseded_claim' };
  };
}

export function registerDirectStartJobs(
  deps: Parameters<typeof createDirectTaskStarter>[0] & {
    sessionManager: DirectAttemptStopDependencies['sessionManager'];
    jobQueue: JobQueueRepository;
    jobProcessor: Pick<JobQueueProcessor, 'register'>;
  }
): void {
  deps.jobProcessor.register(
    DIRECT_TASK_START,
    createDirectStartJobHandler(
      deps.db,
      createDirectTaskStarter(deps),
      deps.jobQueue,
      deps.sessionManager
    )
  );
}
