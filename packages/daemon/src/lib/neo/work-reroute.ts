import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { WorkRef, WorkSummary } from '../drivers/types.ts';

export const NEO_WORK_AWAITING_WORKER = 'Waiting for an open worker in the same project.';
export const NEO_WORK_RESERVED_WORKER = 'An open worker is reserved for this card.';

export function awaitingNeoWorker(work: Pick<NeoWork, 'status' | 'report'>): boolean {
  return (
    work.status === 'proposed' &&
    (work.report === NEO_WORK_AWAITING_WORKER || work.report === NEO_WORK_RESERVED_WORKER)
  );
}

export function neoWorkerRefKey(ref: WorkRef): string {
  return JSON.stringify([ref.adapter, ref.daemon ?? null, ref.id]);
}

export function pickNeoReplacementWorkers(
  workers: readonly WorkSummary[],
  original: WorkSummary | undefined,
  tried: ReadonlySet<string>
): WorkRef[] {
  if (!original || (!original.place.folder && !original.place.spaceId)) return [];
  return workers
    .filter(
      (worker) =>
        worker.ref.adapter === original.ref.adapter &&
        worker.ref.daemon === original.ref.daemon &&
        worker.place.machine === original.place.machine &&
        worker.place.folder === original.place.folder &&
        worker.place.spaceId === original.place.spaceId &&
        worker.status === 'done' &&
        !worker.busy &&
        !worker.liveCards &&
        !tried.has(neoWorkerRefKey(worker.ref))
    )
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((worker) => worker.ref);
}
