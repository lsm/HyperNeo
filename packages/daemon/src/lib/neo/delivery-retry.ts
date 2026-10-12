import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { isNeoAskLive } from './done-check.ts';
import type { NeoService } from './service.ts';

export const NEO_WORK_DELIVERY_RETRY = 'neo.work.delivery.retry';
export const NEO_DELIVERY_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

type DeliveryRetryCard = {
  retryable: boolean;
  ask: Pick<NeoAsk, 'approvedAt' | 'approvedUntil' | 'status'> | null;
  retries: number;
  now: number;
};

export function planNeoDeliveryRetry(
  card: DeliveryRetryCard
): { value: number } | { reason: 'not_retryable' | 'not_approved' | 'retries_spent' } {
  if (!card.retryable) return { reason: 'not_retryable' };
  const ask = card.ask;
  if (!ask?.approvedAt || !isNeoAskLive(ask) || (ask.approvedUntil ?? Infinity) <= card.now)
    return { reason: 'not_approved' };
  const delay = NEO_DELIVERY_RETRY_BACKOFF_MS[card.retries];
  return delay === undefined ? { reason: 'retries_spent' } : { value: delay };
}

export function scheduleNeoDeliveryRetry(
  queue: JobQueueRepository,
  workId: string,
  runAt: number
): void {
  queue.enqueueUniquePending({
    queue: NEO_WORK_DELIVERY_RETRY,
    payload: { workId },
    matchPayload: { workId },
    activeStatuses: ['pending'],
    runAt,
  });
}

export function isNeoDeliveryRetryPending(queue: JobQueueRepository, workId: string): boolean {
  return queue.listActiveByPayload(NEO_WORK_DELIVERY_RETRY, { workId }, ['pending']).length > 0;
}

export const runNeoDeliveryRetry = (superpipe({})('neo-work-delivery-retry') as PipelineAPI)
  .input(['job', 'service'])
  .pipe(
    (job: Job, service: NeoService) => {
      const work = service.repo.getWork(String(job.payload.workId));
      return work && service.isRetryable(work.id)
        ? { value: work }
        : { reason: { retried: false as const } };
    },
    ['job', 'service'],
    'result:retry'
  )
  .pipe(
    async (service: NeoService, work: NeoWork) => {
      const retried = await service.retryWork(work);
      return { value: { retried: retried.ok } };
    },
    ['service', 'retry'],
    'result:retry'
  )
  .endAsync('retry') as (job: Job, service: NeoService) => Promise<{ retried: boolean }>;
