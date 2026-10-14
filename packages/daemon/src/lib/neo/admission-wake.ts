import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { NeoService } from './service.ts';
import { awaitingNeoWorker } from './work-reroute.ts';

export const NEO_WORK_ADMISSION_WAKE = 'neo.work.admission';

export function scheduleNeoAdmissionWake(
  queue: JobQueueRepository,
  workId: string,
  runAt = Date.now()
): void {
  queue.enqueueUniquePending({
    queue: NEO_WORK_ADMISSION_WAKE,
    payload: { workId },
    matchPayload: { workId },
    activeStatuses: ['pending'],
    runAt,
  });
}

export function planNeoAvailabilityWakes(
  settled: Pick<NeoWork, 'id' | 'projectId'>,
  work: readonly NeoWork[],
  blocked: (workId: string) => boolean
): string[] {
  return work
    .filter(
      (card) =>
        card.id !== settled.id &&
        card.projectId === settled.projectId &&
        awaitingNeoWorker(card) &&
        !blocked(card.id)
    )
    .map((card) => card.id);
}

export function neoAdmissionWakeAuthorized(work: NeoWork, startIntent: boolean): boolean {
  return startIntent || awaitingNeoWorker(work);
}

export const runNeoAdmissionWake = (superpipe({})('neo-work-admission-wake') as PipelineAPI)
  .input(['job', 'service'])
  .pipe(
    (service: NeoService) =>
      service.db.getGlobalSettings?.().neo?.autoDispatch === true
        ? { value: true }
        : { reason: { admitted: false as const, reason: 'auto_dispatch_off' } },
    'service',
    'result:wake'
  )
  .pipe(
    (job: Job, service: NeoService) => {
      const work = service.repo.getWork(String(job.payload.workId));
      return work?.status === 'proposed'
        ? { value: work }
        : { reason: { admitted: false as const, reason: 'card_not_waiting' } };
    },
    ['job', 'service'],
    'result:wake'
  )
  .pipe(
    async (work: NeoWork, service: NeoService) => {
      const admitted = await service.admitWork(
        work.id,
        neoAdmissionWakeAuthorized(work, service.dependencies.hasStartIntent(work.id))
      );
      return {
        value: admitted.ok
          ? { admitted: true as const }
          : { admitted: false as const, reason: admitted.reason },
      };
    },
    ['wake', 'service'],
    'result:wake'
  )
  .endAsync('wake') as (
  job: Job,
  service: NeoService
) => Promise<{ admitted: true } | { admitted: false; reason: string }>;
