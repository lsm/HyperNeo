import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { NeoService } from './service.ts';

export const NEO_DRIVER_REFRESH = 'neo.work.driver.refresh';

export function scheduleDriverRefresh(queue: JobQueueRepository): void {
  queue.enqueueUniquePending({
    queue: NEO_DRIVER_REFRESH,
    payload: { scope: 'neo' },
    matchPayload: { scope: 'neo' },
    activeStatuses: ['pending'],
    runAt: Date.now() + 60_000,
  });
}

export const refreshNeoDriverWork = (superpipe({})('neo-driver-refresh') as PipelineAPI)
  .input(['queue', 'service'])
  .pipe(scheduleDriverRefresh, 'queue')
  .pipe(
    async (service: NeoService) => {
      await service.refreshDriverWork();
      return { refreshed: true };
    },
    'service',
    'result'
  )
  .endAsync('result') as (
  queue: JobQueueRepository,
  service: NeoService
) => Promise<{ refreshed: true }>;
