import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { NeoService } from './service.ts';

export const NEO_CONSULTATION_RECOVERY = 'neo.consultation.recover';

export function scheduleConsultationRecovery(queue: JobQueueRepository): void {
  queue.enqueueUniquePending({
    queue: NEO_CONSULTATION_RECOVERY,
    payload: { scope: 'neo' },
    matchPayload: { scope: 'neo' },
    activeStatuses: ['pending'],
    runAt: Date.now() + 60_000,
  });
}

export const recoverNeoConsultations = (superpipe({})('neo-consultation-recovery') as PipelineAPI)
  .input(['queue', 'service'])
  .pipe(scheduleConsultationRecovery, 'queue')
  .pipe(
    async (service: NeoService) => {
      await service.recoverConsultations();
      return { recovered: true };
    },
    'service',
    'result'
  )
  .endAsync('result') as (
  queue: JobQueueRepository,
  service: NeoService
) => Promise<{ recovered: true }>;
