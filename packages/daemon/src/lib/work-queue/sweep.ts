import superpipe, { type PipelineAPI } from 'superpipe';
import { planWorkQueue, type RunningWork, type WorkCandidate } from './capacity.ts';
import { mayRedispatch } from './follow-through.ts';

type Limits = { running: number; perGroup: number };
type Queue = { candidates: WorkCandidate[]; running: RunningWork[] };

export interface WorkQueueAdapter<Claim extends { plan: { kind: string } }> {
  queue(): Promise<Queue>;
  claim(id: string, now: number, mayMove: () => Promise<boolean>): Promise<Claim | null>;
  act(claim: Claim, now: number): Promise<unknown>;
  start(id: string): Promise<unknown>;
}

export function createWorkQueue<Claim extends { plan: { kind: string } }>(
  adapter: WorkQueueAdapter<Claim>,
  limits: () => Limits
) {
  let movedAt = -Infinity;
  const mayMove = (superpipe({})('work-queue.may-move') as PipelineAPI)
    .input(['now'])
    .pipe(() => adapter.queue(), 'now', 'queue')
    .pipe(
      (queue: Queue, now: number) =>
        mayRedispatch(
          queue.running.filter((row) => !row.idle).length,
          movedAt,
          now,
          limits().running
        ),
      ['queue', 'now'],
      'move'
    )
    .endAsync('move') as (now: number) => Promise<boolean>;

  const followThrough = (superpipe({})('work-queue.follow-through') as PipelineAPI)
    .input(['id', 'now'])
    .pipe(
      async (id: string, now: number) => {
        const claim = await adapter.claim(id, now, () => mayMove(now));
        return claim ? { value: claim } : { reason: null };
      },
      ['id', 'now'],
      'result:claim'
    )
    .pipe(
      (claim: Claim, now: number) => {
        if (claim.plan.kind === 'redispatch') movedAt = now;
        return claim;
      },
      ['claim', 'now'],
      'claim'
    )
    .pipe((claim: Claim, now: number) => adapter.act(claim, now), ['claim', 'now'], 'acted')
    .endAsync('acted') as (id: string, now: number) => Promise<unknown>;

  const fillQueue = (superpipe({})('work-queue.fill') as PipelineAPI)
    .input(['limits'])
    .pipe(() => adapter.queue(), 'limits', 'queue')
    .pipe(
      (queue: Queue, caps: Limits) => planWorkQueue(queue.candidates, queue.running, caps).start,
      ['queue', 'limits'],
      'ids'
    )
    .pipe(
      async (ids: readonly string[]) => {
        for (const id of ids) await adapter.start(id);
      },
      'ids',
      'started'
    )
    .endAsync('started') as (caps: Limits) => Promise<void>;
  let filling: Promise<void> = Promise.resolve();

  return {
    followThrough,
    fill: () => (filling = filling.catch(() => undefined).then(() => fillQueue(limits()))),
    takeMove: async (now: number) => (await mayMove(now)) && ((movedAt = now), true),
  };
}
