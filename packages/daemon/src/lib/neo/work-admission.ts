import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  neoAskApprovalSpent,
  type NeoAsk,
  type NeoAskItem,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoDriverTargetCard } from '../../storage/repositories/neo-work-driver-target-repository.ts';
import type { buildNeoCheckRegistry } from './packs/check-registry.ts';

type NeoAdmissionBlocker = { workId: string; reason: string; itemIds: string[] };
type NeoAdmissionRefusal = { ok: false; reason: string; blockers?: NeoAdmissionBlocker[] };
type NeoAdmissionHandoff = 'started' | 'reported' | 'uncertain' | 'not_started';
type NeoAdmissionSnapshot = {
  work: NeoWork | null;
  ask: NeoAsk | null;
  card: NeoDriverTargetCard | null;
  blockers: NeoAdmissionBlocker[];
  bootedAt: number;
};
type Admissible = NeoAdmissionSnapshot & { work: NeoWork };

export interface NeoAdmissionDeps {
  bootedAt: number;
  readWork(id: string): NeoWork | null;
  readAsk(id: string): NeoAsk | null;
  readCard(id: string): NeoDriverTargetCard | null;
  readBlockers(id: string): NeoAdmissionBlocker[];
  claim(id: string, admitted: () => boolean): boolean;
  handOff(work: NeoWork): Promise<void>;
  release(id: string): void;
  markUncertain(id: string): void;
}

export function neoOutcomeEligibility(registry: ReturnType<typeof buildNeoCheckRegistry>) {
  return (_ask: NeoAsk, item: NeoAskItem): boolean => {
    if (item.metBy === 'human') return true;
    if (item.metBy !== 'daemon' || !item.check || !registry.ok) return false;
    const check = registry.resolve(item.check);
    return check.ok && check.value.independent;
  };
}

const refuse = (reason: string, blockers?: NeoAdmissionBlocker[]) => ({
  reason: { ok: false as const, reason, ...(blockers ? { blockers } : {}) },
});

function readNeoAdmission(workId: string, deps: NeoAdmissionDeps): NeoAdmissionSnapshot {
  const work = deps.readWork(workId);
  return {
    work,
    ask: work ? deps.readAsk(workId) : null,
    card: work ? deps.readCard(workId) : null,
    blockers: work ? deps.readBlockers(workId) : [],
    bootedAt: deps.bootedAt,
  };
}

function requireNeoAdmissionCard(snapshot: NeoAdmissionSnapshot) {
  const { work, ask, card } = snapshot;
  if (!work || !['proposed', 'queued'].includes(work.status)) return refuse('card_not_active');
  if (ask && ['achieved', 'abandoned'].includes(ask.status)) return refuse('ask_not_live');
  if (card && !card.target) return refuse('no_driver_target');
  return { value: snapshot as Admissible };
}

function requireNeoAdmissionHandoff(snapshot: Admissible) {
  const { card } = snapshot;
  if (card?.ref) return refuse('already_started');
  if (card?.startInterrupted) return refuse('handoff_uncertain');
  const claimedAt = card?.claimedAt ?? null;
  if (claimedAt !== null)
    return refuse(claimedAt < snapshot.bootedAt ? 'handoff_uncertain' : 'already_claimed');
  return { value: snapshot };
}

function requireNeoAdmissionAuthorized(snapshot: Admissible, human: boolean, now: number) {
  if (human) return { value: snapshot };
  const { ask } = snapshot;
  if (!ask || ask.approvedAt == null) return refuse('not_approved');
  if ((ask.approvedRevision ?? null) !== (ask.revision ?? 0)) return refuse('approval_stale');
  if (neoAskApprovalSpent(ask, now)) return refuse('approval_expired');
  return { value: snapshot };
}

function requireNeoAdmissionPrerequisites(snapshot: Admissible) {
  return snapshot.blockers.length
    ? refuse('prerequisites_unmet', snapshot.blockers)
    : { value: snapshot };
}

const checkNeoAdmission = (superpipe({})('neo-work-admission-check') as PipelineAPI)
  .input(['workId', 'human', 'now', 'deps'])
  .pipe(readNeoAdmission, ['workId', 'deps'], 'snapshot')
  .pipe(requireNeoAdmissionCard, 'snapshot', 'result:admission')
  .pipe(requireNeoAdmissionHandoff, 'admission', 'result:admission')
  .pipe(requireNeoAdmissionAuthorized, ['admission', 'human', 'now'], 'result:admission')
  .pipe(requireNeoAdmissionPrerequisites, 'admission', 'result:admission')
  .end('admission') as (
  workId: string,
  human: boolean,
  now: number,
  deps: NeoAdmissionDeps
) => Admissible | NeoAdmissionRefusal;

const asNeoAdmissionGate = (checked: Admissible | NeoAdmissionRefusal) =>
  'ok' in checked ? { reason: checked } : { value: checked };

export const admitNeoWork = (superpipe({})('neo-work-admission') as PipelineAPI)
  .input(['workId', 'human', 'now', 'deps'])
  .pipe(
    (workId: string, human: boolean, now: number, deps: NeoAdmissionDeps) =>
      asNeoAdmissionGate(checkNeoAdmission(workId, human, now, deps)),
    ['workId', 'human', 'now', 'deps'],
    'result:admission'
  )
  .pipe(
    (admitted: Admissible, workId: string, human: boolean, now: number, deps: NeoAdmissionDeps) => {
      if (deps.claim(workId, () => !('ok' in checkNeoAdmission(workId, human, now, deps))))
        return { value: admitted };
      const checked = checkNeoAdmission(workId, human, now, deps);
      return 'ok' in checked ? { reason: checked } : refuse('already_claimed');
    },
    ['admission', 'workId', 'human', 'now', 'deps'],
    'result:admission'
  )
  .pipe(
    async (admitted: Admissible, deps: NeoAdmissionDeps): Promise<NeoAdmissionHandoff> => {
      try {
        await deps.handOff(admitted.work);
      } catch (error) {
        deps.markUncertain(admitted.work.id);
        throw error;
      }
      const work = deps.readWork(admitted.work.id);
      const card = deps.readCard(admitted.work.id);
      if (card?.startInterrupted) return 'uncertain';
      if (!card?.ref) deps.release(admitted.work.id);
      if (work?.status === 'reported') return 'reported';
      return work?.status === 'queued' && (!card || card.ref) ? 'started' : 'not_started';
    },
    ['admission', 'deps'],
    'handoff'
  )
  .pipe((handoff: NeoAdmissionHandoff) => ({ ok: true as const, handoff }), 'handoff', 'admission')
  .endAsync('admission') as (
  workId: string,
  human: boolean,
  now: number,
  deps: NeoAdmissionDeps
) => Promise<{ ok: true; handoff: NeoAdmissionHandoff } | NeoAdmissionRefusal>;
