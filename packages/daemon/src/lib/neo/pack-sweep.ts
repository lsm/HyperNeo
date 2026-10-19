import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { NeoService } from './service.ts';

export const NEO_PACK_SWEEP = 'neo.pack.sweep';
export const NEO_PACK_SWEEP_MS = 5 * 60_000;

export function schedulePackSweep(queue: JobQueueRepository, delay = NEO_PACK_SWEEP_MS): void {
  queue.enqueueUniquePending({
    queue: NEO_PACK_SWEEP,
    payload: { scope: 'neo' },
    matchPayload: { scope: 'neo' },
    activeStatuses: ['pending'],
    runAt: Date.now() + delay,
  });
}

export const sweepNeoPacks = (superpipe({})('neo-pack-sweep') as PipelineAPI)
  .input(['queue', 'service'])
  .pipe((queue: JobQueueRepository) => schedulePackSweep(queue), 'queue')
  .pipe(
    async (service: NeoService) => {
      await service.sweepPacks();
      return { swept: true };
    },
    'service',
    'result'
  )
  .endAsync('result') as (
  queue: JobQueueRepository,
  service: NeoService
) => Promise<{ swept: true }>;
