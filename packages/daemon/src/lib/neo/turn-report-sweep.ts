import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';

type Worker = { todo: NeoTodo; ask: NeoAsk; ref: WorkRef };
type Plan = { selected: Worker[]; next: number };

export const planNeoTurnReportSweep = (superpipe({})('neo.turn-report-sweep') as PipelineAPI)
  .input(['candidates', 'cursor'])
  .pipe(
    (candidates: readonly Worker[]) => {
      const workers = new Map<string, Worker>();
      for (const worker of candidates) {
        const key = JSON.stringify([
          worker.ask.sessionId,
          worker.ref.adapter,
          worker.ref.id,
          worker.ref.daemon ?? null,
        ]);
        if (!workers.has(key)) workers.set(key, worker);
      }
      return [...workers.values()];
    },
    'candidates',
    'workers'
  )
  .pipe(
    (workers: readonly Worker[], cursor: number): Plan => {
      const selected: Worker[] = [];
      for (let offset = 0; offset < Math.min(20, workers.length); offset++)
        selected.push(workers[(cursor + offset) % workers.length]);
      return { selected, next: workers.length ? (cursor + selected.length) % workers.length : 0 };
    },
    ['workers', 'cursor'],
    'plan'
  )
  .end('plan') as (candidates: readonly Worker[], cursor: number) => Plan;
