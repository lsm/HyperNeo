import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkTurnRepository } from '../../storage/repositories/work-turn-repository.ts';
import type { WorkRef, WorkTurnFact } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';

const CATCH_UP_TURNS = 500;

type Deps = {
  turns: Pick<WorkTurnRepository, 'cursor' | 'record'>;
  read(ref: WorkRef, cursor: string | null, limit?: number): Promise<OperationOutcome>;
};

export const readRecordableTurns = (outcome: OperationOutcome): WorkTurnFact[] => {
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  const reply = outcome.value as
    | { ok: true; value: { turns: WorkTurnFact[] } }
    | { ok: false; reason: string; detail: string };
  if (reply.ok) return reply.value.turns;
  if (reply.reason === 'unsupported' || reply.reason === 'not_found') return [];
  throw new Error(`${reply.reason}: ${reply.detail}`);
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

export const planTurnCatchUp = <T extends { ref: WorkRef; lastActivityAt: number | null }>(
  workers: readonly T[],
  seen: ReadonlyMap<string, number>
) =>
  workers.filter(
    ({ ref, lastActivityAt }) =>
      lastActivityAt === null || seen.get(JSON.stringify(ref)) !== lastActivityAt
  );

export async function catchUpWorkerTurns(ref: WorkRef, deps: Deps): Promise<boolean> {
  const found = readRecordableTurns(await deps.read(ref, deps.turns.cursor(ref), CATCH_UP_TURNS));
  if (found.length) await deps.turns.record(ref, found);
  return found.length < CATCH_UP_TURNS;
}
