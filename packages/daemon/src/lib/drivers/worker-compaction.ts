import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import type { WorkAdapter, WorkRef } from './types.ts';

type Compact = NonNullable<WorkAdapter['compact']>;

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
        warn(`Worker ${plan.ref.adapter}:${plan.ref.id} was reused without compaction`, error);
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
