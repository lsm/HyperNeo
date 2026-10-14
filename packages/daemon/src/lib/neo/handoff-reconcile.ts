import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoDriverTargetCard } from '../../storage/repositories/neo-work-driver-target-repository.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { type DriverSent, readDriverInputAttribution } from './driver-work.ts';

export type NeoHandoffFacts = {
  work: Pick<NeoWork, 'status'> | null;
  card: Pick<NeoDriverTargetCard, 'ref' | 'startInterrupted' | 'claimedAt'> | null;
  receipt: DriverSent['receipt'];
  bootedAt: number;
};

export type NeoHandoffVerdict =
  | { state: 'idle' }
  | { state: 'in_flight' }
  | { state: 'not_started' }
  | { state: 'started'; ref: WorkRef; input: 'confirmed' | 'pending' | 'unconfirmed' }
  | {
      state: 'uncertain';
      reason: 'start_interrupted' | 'no_external_identifier' | 'work_gone';
    };

export interface NeoHandoffDeps {
  bootedAt: number;
  readWork(id: string): NeoWork | null;
  readCard(id: string): NeoDriverTargetCard | null;
  readSent(id: string): DriverSent | null;
  readStatus(
    work: NeoWork,
    ref: WorkRef,
    receipt: DriverSent['receipt']
  ): Promise<OperationOutcome>;
}

export function decideNeoHandoffBeforeRead(facts: NeoHandoffFacts): NeoHandoffVerdict | null {
  const { work, card } = facts;
  if (!card?.ref && card?.startInterrupted)
    return { state: 'uncertain', reason: 'start_interrupted' };
  if (!work || !['proposed', 'queued'].includes(work.status)) return { state: 'idle' };
  if (card?.ref) return null;
  const claimedAt = card?.claimedAt ?? null;
  if (claimedAt !== null && claimedAt >= facts.bootedAt) return { state: 'in_flight' };
  if (work.status === 'queued') return { state: 'uncertain', reason: 'no_external_identifier' };
  return claimedAt === null ? { state: 'idle' } : { state: 'not_started' };
}

export function decideNeoHandoffAfterRead(
  ref: WorkRef,
  receipt: DriverSent['receipt'],
  read: OperationOutcome
): NeoHandoffVerdict {
  const reply =
    read.kind === 'completed' ? (read.value as { ok?: unknown; reason?: unknown }) : null;
  if (reply?.ok === false && reply.reason === 'not_found')
    return { state: 'uncertain', reason: 'work_gone' };
  const attribution = readDriverInputAttribution(read, receipt);
  return {
    state: 'started',
    ref,
    input:
      attribution?.state === 'observed'
        ? 'confirmed'
        : attribution?.state === 'pending'
          ? 'pending'
          : 'unconfirmed',
  };
}

function readNeoHandoffFacts(workId: string, deps: NeoHandoffDeps) {
  const work = deps.readWork(workId);
  const card = work ? deps.readCard(workId) : null;
  return {
    work,
    card,
    receipt: work ? deps.readSent(workId)?.receipt : undefined,
    bootedAt: deps.bootedAt,
  };
}

function requireNeoHandoffRead(facts: ReturnType<typeof readNeoHandoffFacts>) {
  const decided = decideNeoHandoffBeforeRead(facts);
  return decided || !facts.work || !facts.card?.ref
    ? { reason: decided ?? ({ state: 'idle' } as const) }
    : { value: { work: facts.work, ref: facts.card.ref, receipt: facts.receipt } };
}

export const reconcileNeoHandoff = (superpipe({})('neo-handoff-reconcile') as PipelineAPI)
  .input(['workId', 'deps'])
  .pipe(readNeoHandoffFacts, ['workId', 'deps'], 'facts')
  .pipe(requireNeoHandoffRead, 'facts', 'result:verdict')
  .pipe(
    async (
      started: { work: NeoWork; ref: WorkRef; receipt: DriverSent['receipt'] },
      deps: NeoHandoffDeps
    ) =>
      decideNeoHandoffAfterRead(
        started.ref,
        started.receipt,
        await deps.readStatus(started.work, started.ref, started.receipt)
      ),
    ['verdict', 'deps'],
    'verdict'
  )
  .endAsync('verdict') as (workId: string, deps: NeoHandoffDeps) => Promise<NeoHandoffVerdict>;
