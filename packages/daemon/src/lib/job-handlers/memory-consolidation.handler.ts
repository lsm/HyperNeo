import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { AgentMemoryRepository } from '../../storage/repositories/agent-memory-repository.ts';
import { MEMORY_CONSOLIDATION } from '../job-queue-constants.ts';

const NEXT_RUN_DELAY_MS = 24 * 60 * 60 * 1000;

export function createMemoryConsolidationHandler(
  memoryRepo: AgentMemoryRepository,
  jobQueue?: JobQueueRepository
) {
  return async (job: Job): Promise<Record<string, unknown>> => {
    const nextRunAt = Date.now() + NEXT_RUN_DELAY_MS;
    if (jobQueue) enqueueMemoryConsolidationIfMissing(jobQueue, nextRunAt);
    const result = memoryRepo.consolidate(buildConsolidationOptions(job.payload));
    return { ...result, nextRunAt };
  };
}

export function enqueueMemoryConsolidationIfMissing(
  jobQueue: JobQueueRepository,
  runAt = Date.now()
): void {
  const pending = jobQueue.listJobs({ queue: MEMORY_CONSOLIDATION, status: 'pending', limit: 1 });
  if (pending.length === 0) {
    jobQueue.enqueue({ queue: MEMORY_CONSOLIDATION, payload: {}, runAt });
  }
}

function buildConsolidationOptions(payload: Record<string, unknown>) {
  return {
    ...(readOptionalString(payload.spaceId)
      ? { spaceId: readOptionalString(payload.spaceId) }
      : {}),
    ...(readOptionalNumber(payload.staleTtlMs) !== undefined
      ? { staleTtlMs: readOptionalNumber(payload.staleTtlMs) }
      : {}),
    ...(readOptionalNumber(payload.duplicateJaccardThreshold) !== undefined
      ? { duplicateJaccardThreshold: readOptionalNumber(payload.duplicateJaccardThreshold) }
      : {}),
    ...(readOptionalNumber(payload.coreLimit) !== undefined
      ? { coreLimit: readOptionalNumber(payload.coreLimit) }
      : {}),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
