import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import { FindWorkResultSchema } from '../drivers/find-operation.ts';
import type { Place, WorkRef, WorkSummary } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { NeoDriverTarget } from './driver-work.ts';

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

function foundWorkers(outcome: OperationOutcome): WorkSummary[] {
  const parsed = FindWorkResultSchema.safeParse(
    outcome.kind === 'completed' ? outcome.value : null
  );
  return parsed.success ? parsed.data.places.flatMap((group) => group.work) : [];
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

interface RerouteDeps {
  pause(work: NeoWork): NeoWork | null;
  find(input: Record<string, unknown>): Promise<OperationOutcome>;
  reserve(
    work: NeoWork,
    candidates: WorkRef[]
  ): { work: NeoWork; target: NeoDriverTarget | null } | null;
  start(work: NeoWork, target: NeoDriverTarget): Promise<void>;
  returnToNeo(work: NeoWork, place: Place | undefined): Promise<void>;
}

export const rerouteNeoDriverWork = (superpipe({})('neo-work-reroute') as PipelineAPI)
  .input(['work', 'ref', 'tried', 'deps'])
  .pipe(
    (work: NeoWork, deps: RerouteDeps) => {
      const paused = deps.pause(work);
      return paused ? { value: paused } : { reason: 'superseded' };
    },
    ['work', 'deps'],
    'result:reroute'
  )
  .pipe(
    (ref: WorkRef, deps: RerouteDeps) =>
      deps.find({ id: ref.id, adapters: [ref.adapter], localOnly: !ref.daemon }),
    ['ref', 'deps'],
    'originalReply'
  )
  .pipe(
    (reply: OperationOutcome, ref: WorkRef) => ({
      worker: foundWorkers(reply).find(
        (worker) => neoWorkerRefKey(worker.ref) === neoWorkerRefKey(ref)
      ),
    }),
    ['originalReply', 'ref'],
    'original'
  )
  .pipe(
    async ({ worker }: { worker?: WorkSummary }, ref: WorkRef, deps: RerouteDeps) =>
      worker && (worker.place.folder || worker.place.spaceId)
        ? foundWorkers(
            await deps.find({
              folder: worker.place.folder,
              spaceId: worker.place.spaceId,
              adapters: [ref.adapter],
              localOnly: !ref.daemon,
              includeClosed: false,
            })
          )
        : [],
    ['original', 'ref', 'deps'],
    'workers'
  )
  .pipe(
    (workers: WorkSummary[], { worker }: { worker?: WorkSummary }, tried: Set<string>) =>
      pickNeoReplacementWorkers(workers, worker, tried),
    ['workers', 'original', 'tried'],
    'candidates'
  )
  .pipe(
    (work: NeoWork, candidates: WorkRef[], deps: RerouteDeps) => {
      const reserved = deps.reserve(work, candidates);
      return reserved ? { value: reserved } : { reason: 'superseded' };
    },
    ['reroute', 'candidates', 'deps'],
    'result:reroute'
  )
  .pipe(
    async (
      reserved: NonNullable<ReturnType<RerouteDeps['reserve']>>,
      { worker }: { worker?: WorkSummary },
      deps: RerouteDeps
    ) => {
      if (reserved.target) await deps.start(reserved.work, reserved.target);
      else await deps.returnToNeo(reserved.work, worker?.place);
    },
    ['reroute', 'original', 'deps']
  )
  .endAsync('reroute') as (
  work: NeoWork,
  ref: WorkRef,
  tried: Set<string>,
  deps: RerouteDeps
) => Promise<unknown>;
