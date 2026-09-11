import type { Database } from '../../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { DirectTaskStartInput } from './start-direct-task.ts';
import { canonicalJson } from '../../agent/prompt-comparison.ts';

export const DIRECT_TASK_START = 'direct_task_start';
export function readDirectStartRequest(db: Database, attemptId: string) {
  const row = db
    .prepare(
      'SELECT request_json AS input, job_id AS jobId FROM direct_task_start_requests WHERE attempt_id = ?'
    )
    .get(attemptId) as { input: string; jobId: string } | null;
  return row ? { input: JSON.parse(row.input) as DirectTaskStartInput, jobId: row.jobId } : null;
}
export function enqueueDirectStartRequest(
  db: Database,
  jobs: JobQueueRepository,
  attemptId: string,
  input: DirectTaskStartInput
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
    return;
  }
  const job = jobs.enqueue({ queue: DIRECT_TASK_START, payload: { attemptId } });
  db.prepare(
    'INSERT INTO direct_task_start_requests(attempt_id,request_json,job_id) VALUES(?,?,?)'
  ).run(attemptId, frozen, job.id);
}
