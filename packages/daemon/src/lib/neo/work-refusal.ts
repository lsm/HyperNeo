import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoWorkRefusal } from '../../storage/repositories/neo-work-refusal-repository.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { readDriverInputs } from './driver-work.ts';

interface RefusalDeps {
  read(): Promise<OperationOutcome>;
  clear(): void;
}

export const reconcileNeoWorkRefusal = (superpipe({})('neo-work-refusal-input') as PipelineAPI)
  .input(['refusal', 'deps'])
  .pipe((deps: RefusalDeps) => deps.read(), 'deps', 'read')
  .pipe(
    (refusal: NeoWorkRefusal, read: OperationOutcome) =>
      readDriverInputs(read)?.some((input) => input.human === true && input.at > refusal.at)
        ? { value: true }
        : { reason: false },
    ['refusal', 'read'],
    'result:cleared'
  )
  .pipe((deps: RefusalDeps) => deps.clear(), 'deps')
  .endAsync('cleared') as (refusal: NeoWorkRefusal, deps: RefusalDeps) => Promise<boolean>;
