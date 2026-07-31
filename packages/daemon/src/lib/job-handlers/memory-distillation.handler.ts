import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { MemoryDistillationService } from '../space/memory-distillation-service';
import { MEMORY_DISTILLATION } from '../job-queue-constants';

/**
 * Distillation cadence. Shorter than memory_consolidation's 24h because the
 * per-agent cursor makes idle runs cheap (no LLM call when nothing is new), so
 * active long-horizon agents get knowledge into memory within minutes of
 * producing it instead of waiting up to a day.
 */
const NEXT_RUN_DELAY_MS = 30 * 60 * 1000;

export interface MemoryDistillationJobPayload {
  /** Present (and non-empty) on per-agent jobs; absent on the coordinator tick. */
  agentId?: string;
}

export function createMemoryDistillationHandler(
  service: MemoryDistillationService,
  jobQueue?: JobQueueRepository
) {
  return async (job: Job): Promise<Record<string, unknown>> => {
    const agentId = readOptionalString(job.payload.agentId);

    // Per-agent job: distill a single agent. These are short (one bounded LLM
    // call, or none when idle/in-backoff), so they finish well under the job
    // queue's 5-min stale-reclaim threshold — and even if one were reclaimed
    // and re-run, the per-agent cursor makes it idempotent.
    if (agentId) {
      const result = await service.distillAgentById(agentId);
      return {
        agentId,
        distilled: result?.distilled ?? false,
        messagesRead: result?.messagesRead ?? 0,
        memoriesWritten: result?.memoriesWritten ?? 0,
        skipped: result?.skipped,
      };
    }

    // Coordinator tick: self-schedule the next tick, then fan out one short
    // per-agent job per active LH agent. Splitting work this way (instead of
    // one long distillAll) keeps every job short enough to never be reclaimed
    // as stale and re-executed concurrently — which would duplicate paid LLM
    // calls and race on cursor/memory writes.
    const nextRunAt = Date.now() + NEXT_RUN_DELAY_MS;
    if (jobQueue) enqueueMemoryDistillationIfMissing(jobQueue, nextRunAt);

    const agentIds = service.listActiveAgentIds();
    let dispatched = 0;
    if (jobQueue) {
      for (const id of agentIds) {
        // Dedupe per-agent: if a job for this agent is already pending or
        // processing (e.g. a slow prior extraction hasn't finished), don't
        // enqueue another. The per-agent cursor makes re-runs idempotent, but
        // skipping the duplicate avoids a pile-up under slow providers.
        const enqueued = jobQueue.enqueueUniquePending({
          queue: MEMORY_DISTILLATION,
          payload: { agentId: id },
          matchPayload: { agentId: id },
          runAt: Date.now(),
        });
        if (enqueued) dispatched++;
      }
    }

    return { coordinator: true, agentsDispatched: dispatched, nextRunAt };
  };
}

/**
 * Enqueue the next coordinator tick (payload `{}`, i.e. no agentId) unless one
 * is already pending. Per-agent jobs (payload `{ agentId }`) are NOT counted —
 * they're transient work, not the cadence.
 *
 * Uses a targeted payload query rather than `listJobs`+filter: `listJobs` is
 * newest-first and bounded, and the coordinator is enqueued before the per-agent
 * fan-out, so with many pending per-agent jobs the coordinator is the oldest row
 * and would fall outside a `LIMIT` window — producing duplicate coordinators.
 */
export function enqueueMemoryDistillationIfMissing(
  jobQueue: JobQueueRepository,
  runAt = Date.now()
): void {
  if (!jobQueue.hasPendingJobWithoutPayloadField(MEMORY_DISTILLATION, 'agentId')) {
    jobQueue.enqueue({ queue: MEMORY_DISTILLATION, payload: {}, runAt });
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
