import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import type {
  JobQueueRepository,
  Job,
} from '../../../storage/repositories/job-queue-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import {
  claimDirectStart,
  directTaskStartIdentity,
  type DirectTaskStartInput,
  type DirectTaskStartResult,
} from './start-direct-task.ts';
import { DIRECT_TASK_START, readDirectStartRequest } from './direct-start-request.ts';

export type DirectStartAcknowledgement =
  | { accepted: true; jobId: string | null }
  | { accepted: false; reason: string };
function acknowledge(
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
    .pipe(acknowledge, ['db', 'claim'], 'result')
    .end('result') as (input: DirectTaskStartInput) => DirectStartAcknowledgement;
}
export function createDirectStartJobHandler(
  db: Database,
  start: (input: DirectTaskStartInput) => Promise<DirectTaskStartResult>,
  jobs: Pick<JobQueueRepository, 'requeue'>
) {
  return async (job: Job) => {
    const attemptId = job.payload.attemptId;
    if (job.queue !== DIRECT_TASK_START || typeof attemptId !== 'string')
      return { started: false, reason: 'unlinked_job' };
    const request = readDirectStartRequest(db, attemptId);
    const attempts = new DirectTaskExecutionRepository(db);
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
    if (!result.started) {
      const current = attempts.getActive(attempt.taskId);
      if (current?.id !== attempt.id || attempts.isStopRequested(attempt.id, attempt.sessionId))
        return { started: false, reason: 'superseded' };
      if (!job.claimToken) throw new Error(`Direct start remains unavailable: ${result.reason}`);
      if (jobs.requeue(job.id, Date.now() + 30_000, job.claimToken))
        return { ...result, parked: 'direct_start_not_ready' };
      return { started: false, reason: 'superseded_claim' };
    }
    return result;
  };
}
