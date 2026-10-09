import type { Database } from '../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { DirectTaskStartInput } from './start-direct-task.ts';
import { canonicalJson } from '../agent/prompt-comparison.ts';

export const DIRECT_TASK_START = 'direct_task_start';
export function readDirectStartRequest(db: Database, attemptId: string) {
  const row = db
    .prepare(
      'SELECT request_json AS input, job_id AS jobId, lifecycle_generation AS lifecycleGeneration FROM direct_task_start_requests WHERE attempt_id = ?'
    )
    .get(attemptId) as { input: string; jobId: string; lifecycleGeneration: number } | null;
  return row
    ? {
        input: JSON.parse(row.input) as DirectTaskStartInput,
        jobId: row.jobId,
        lifecycleGeneration: row.lifecycleGeneration,
      }
    : null;
}
export function expediteDirectStart(
  db: Database,
  jobs: Pick<JobQueueRepository, 'reschedulePending'>,
  attemptId: string
): boolean {
  const request = readDirectStartRequest(db, attemptId);
  return request ? jobs.reschedulePending(request.jobId, Date.now()) : false;
}

export function reviveDirectStartJob(
  db: Database,
  jobs: Pick<JobQueueRepository, 'enqueue'>,
  attemptId: string
): string {
  const revived = jobs.enqueue({ queue: DIRECT_TASK_START, payload: { attemptId } });
  db.prepare('UPDATE direct_task_start_requests SET job_id = ? WHERE attempt_id = ?').run(
    revived.id,
    attemptId
  );
  return revived.id;
}

export function enqueueDirectStartRequest(
  db: Database,
  jobs: JobQueueRepository,
  attemptId: string,
  input: DirectTaskStartInput,
  lifecycleGeneration: number
): void {
  const normalized = {
    ...input,
    ...(input.reviewRejection
      ? {
          reviewRejection: {
            ...input.reviewRejection,
            reason: input.reviewRejection.reason ?? null,
          },
        }
      : {}),
  };
  const frozen = canonicalJson(normalized);
  const existing = readDirectStartRequest(db, attemptId);
  if (existing) {
    if (canonicalJson(existing.input) !== frozen)
      throw new Error('Direct start request conflicts with frozen input');
    const status = jobs.getJob(existing.jobId)?.status;
    if (status === 'dead' || status === 'failed') reviveDirectStartJob(db, jobs, attemptId);
    return;
  }
  const job = jobs.enqueue({ queue: DIRECT_TASK_START, payload: { attemptId } });
  db.prepare(
    'INSERT INTO direct_task_start_requests(attempt_id,request_json,job_id,lifecycle_generation) VALUES(?,?,?,?)'
  ).run(attemptId, frozen, job.id, lifecycleGeneration);
}
