import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { WorkRef } from '../drivers/types.ts';

export type NeoWorkCloseOutcome = 'done' | 'cancelled';
export type NeoWorkCloseResult = { ok: true; work: NeoWork } | { ok: false; reason: string };
type NeoWorkPatch = Parameters<NeoRepository['transitionWork']>[2];

export interface NeoWorkClosePlan {
  work: NeoWork;
  patch: NeoWorkPatch;
  stopDriver: boolean;
}

export interface NeoWorkCloseDeps {
  repo: Pick<NeoRepository, 'getWork' | 'transitionWork'>;
  readDriverRef(id: string): WorkRef | null;
  stopDriver(ref: WorkRef, work: NeoWork): Promise<void>;
}

export function planNeoWorkClose(
  work: NeoWork | null,
  outcome: NeoWorkCloseOutcome
): { value: NeoWorkClosePlan } | { reason: NeoWorkCloseResult } {
  if (!work) return { reason: { ok: false, reason: 'work_not_found' } };
  if (work.status === 'cancelled')
    return {
      reason:
        outcome === 'cancelled'
          ? { ok: true, work }
          : { ok: false, reason: 'work_closed: cancelled work stays cancelled' },
    };
  if (outcome === 'done' && work.status === 'reported') return { reason: { ok: true, work } };
  return {
    value: {
      work,
      patch:
        outcome === 'done'
          ? { status: 'reported', report: NEO_WORK_CLOSED_DONE }
          : { status: 'cancelled' },
      stopDriver: work.status === 'queued' || work.status === 'proposed',
    },
  };
}

export function requireNeoWorkClosed(closed: {
  work: NeoWork | null;
}): { value: NeoWorkCloseResult } | { reason: NeoWorkCloseResult } {
  return closed.work
    ? { value: { ok: true, work: closed.work } }
    : { reason: { ok: false, reason: 'This work changed meanwhile; read it again.' } };
}

export const closeNeoWork = (superpipe({})('neo.work.close') as PipelineAPI)
  .input(['deps', 'id', 'outcome'])
  .pipe(
    (deps: NeoWorkCloseDeps, id: string) => ({ work: deps.repo.getWork(id) }),
    ['deps', 'id'],
    'current'
  )
  .pipe(
    (current: { work: NeoWork | null }, outcome: NeoWorkCloseOutcome) =>
      planNeoWorkClose(current.work, outcome),
    ['current', 'outcome'],
    'result:closed'
  )
  .pipe((plan: NeoWorkClosePlan) => plan, 'closed', 'plan')
  .pipe(
    (deps: NeoWorkCloseDeps, id: string, plan: NeoWorkClosePlan) => ({
      work: deps.repo.transitionWork(id, plan.work, plan.patch),
    }),
    ['deps', 'id', 'plan'],
    'transition'
  )
  .pipe(requireNeoWorkClosed, 'transition', 'result:closed')
  .pipe(
    async (
      deps: NeoWorkCloseDeps,
      id: string,
      plan: NeoWorkClosePlan,
      closed: { ok: true; work: NeoWork }
    ) => {
      const ref = plan.stopDriver ? deps.readDriverRef(id) : null;
      if (ref) await deps.stopDriver(ref, closed.work);
    },
    ['deps', 'id', 'plan', 'closed']
  )
  .endAsync('closed') as (
  deps: NeoWorkCloseDeps,
  id: string,
  outcome: NeoWorkCloseOutcome
) => Promise<NeoWorkCloseResult>;
