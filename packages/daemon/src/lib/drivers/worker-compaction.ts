import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import type { WorkAdapter, WorkRef } from './types.ts';

type Compact = NonNullable<WorkAdapter['compact']>;
export const WORKER_COMPACTION_TIMEOUT_MS = 180_000;

export type WorkerReuseReason =
  | 'other_ask'
  | 'released'
  | 'other_todo'
  | 'cannot_compact'
  | 'not_confirmed';
export type WorkerReuseDecision =
  | { action: 'send' | 'compact' }
  | { action: 'fresh'; reason: WorkerReuseReason };

export function planCleanWorker(facts: {
  sameTodo: boolean;
  named: boolean;
  started: boolean;
  remote: boolean;
  sameAsk: boolean;
  released: boolean;
  otherTodo: boolean;
  canCompact: boolean;
}): WorkerReuseDecision {
  if (facts.sameTodo || facts.named || !facts.started || facts.remote) return { action: 'send' };
  if (!facts.sameAsk) return { action: 'fresh', reason: 'other_ask' };
  if (facts.released) return { action: 'fresh', reason: 'released' };
  if (facts.otherTodo) return { action: 'fresh', reason: 'other_todo' };
  if (!facts.canCompact) return { action: 'fresh', reason: 'cannot_compact' };
  return { action: 'compact' };
}

export type ReusedWorker = {
  ref: WorkRef;
  sameAsk: boolean;
  compact: WorkAdapter['compact'];
};

export function planReuseCompaction({
  ref,
  sameAsk,
  compact,
}: ReusedWorker): { value: { ref: WorkRef; compact: Compact } } | { reason: boolean } {
  return sameAsk && compact && !ref.daemon ? { value: { ref, compact } } : { reason: false };
}

export const compactBeforeReuse = (superpipe({})('work-reuse-compaction') as PipelineAPI)
  .input(['worker', 'caller', 'warn'])
  .pipe(planReuseCompaction, 'worker', 'result:compacted')
  .pipe(
    async (
      plan: { ref: WorkRef; compact: Compact },
      caller: OperationCaller,
      warn: (message: string, error: unknown) => void
    ) => {
      const failed = (error: unknown) => {
        warn(`Worker ${plan.ref.adapter}:${plan.ref.id} could not be compacted`, error);
        return { value: false };
      };
      try {
        const result = await plan.compact(plan.ref, { caller, from: 'neo' });
        return result.ok
          ? { value: result.value.compacted }
          : failed(`${result.reason}: ${result.detail}`);
      } catch (error) {
        return failed(error);
      }
    },
    ['compacted', 'caller', 'warn'],
    'result:compacted'
  )
  .endAsync('compacted') as (
  worker: ReusedWorker,
  caller: OperationCaller,
  warn: (message: string, error: unknown) => void
) => Promise<boolean>;
