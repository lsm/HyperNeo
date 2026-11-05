import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkTurnRepository } from '../../storage/repositories/work-turn-repository.ts';
import type { WorkRef, WorkTurnFact } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';

type Deps = {
  turns: Pick<WorkTurnRepository, 'cursor' | 'record'>;
  read(ref: WorkRef, cursor: string | null): Promise<OperationOutcome>;
};

export const readRecordableTurns = (outcome: OperationOutcome): WorkTurnFact[] => {
  const reply =
    outcome.kind === 'completed'
      ? (outcome.value as { ok?: boolean; value?: { turns?: WorkTurnFact[] } } | null)
      : null;
  return reply?.ok ? (reply.value?.turns ?? []) : [];
};

export const recordWorkerTurns = (superpipe({})('neo.work.record-turns') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(
    (ref: WorkRef, deps: Deps) => deps.read(ref, deps.turns.cursor(ref)),
    ['ref', 'deps'],
    'read'
  )
  .pipe(readRecordableTurns, 'read', 'found')
  .pipe(
    async (ref: WorkRef, found: WorkTurnFact[], deps: Deps) => {
      if (found.length) await deps.turns.record(ref, found);
    },
    ['ref', 'found', 'deps'],
    'recorded'
  )
  .endAsync('recorded') as (ref: WorkRef, deps: Deps) => Promise<void>;
