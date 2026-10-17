import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoAnswerItem } from './answer-outcome.ts';
import {
  type NeoAsk,
  type NeoAskApprovalSpent,
  type NeoAskItem,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoDriverTargetCard } from '../../storage/repositories/neo-driver-session-rows.ts';
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
  approval: boolean | null;
};
type Admissible = NeoAdmissionSnapshot & { work: NeoWork };

export interface NeoAdmissionDeps {
  bootedAt: number;
  readWork(id: string): NeoWork | null;
  readAsk(id: string): NeoAsk | null;
  readApproval?(id: string): boolean | null;
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
    if (item.metBy === 'daemon' && isNeoAnswerItem(item)) return true;
    if (item.metBy !== 'daemon' || !item.check || !registry.ok) return false;
    const check = registry.resolve(item.check);
    return check.ok && check.value.independent;
  };
}

const NEO_ADMISSION_SETTLED = ['card_not_active', 'already_started', 'already_claimed'];

export function neoAdmissionRefusal(
  result: { ok: true } | NeoAdmissionRefusal
): NeoAdmissionRefusal | null {
  return result.ok || NEO_ADMISSION_SETTLED.includes(result.reason) ? null : result;
}

export const NEO_EDGES_NEED_APPROVAL =
  "not_approved: the dependency edges are recorded, and they change this ask's plan, so its approval no longer covers it. Ask the human to approve the ask again; the card then starts once its prerequisites are met.";

export function planNeoStartRefusal(
  refused: NeoAdmissionRefusal | null,
  edgesChanged: boolean
): NeoAdmissionRefusal | null {
  return refused && edgesChanged && ['not_approved', 'approval_stale'].includes(refused.reason)
    ? { ...refused, reason: NEO_EDGES_NEED_APPROVAL }
    : refused;
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
    approval: deps.readApproval?.(workId) ?? null,
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
  const stale = claimedAt !== null && claimedAt < snapshot.bootedAt;
  if (claimedAt !== null && !(stale && snapshot.work.status === 'proposed'))
    return refuse(stale ? 'handoff_uncertain' : 'already_claimed');
  return { value: snapshot };
}

export function neoAskApprovalRefusal(
  ask: Pick<NeoAsk, 'approvedAt' | 'approvedRevision' | 'revision'> | null,
  _spent: NeoAskApprovalSpent | null | undefined
): string | null {
  if (!ask || ask.approvedAt == null) return 'not_approved';
  if ((ask.approvedRevision ?? null) !== (ask.revision ?? 0)) return 'approval_stale';
  return null;
}

export function isNeoAdmissionApproved(ask: NeoAsk | null, _now: number): boolean {
  return neoAskApprovalRefusal(ask, null) === null;
}

function requireNeoAdmissionAuthorized(snapshot: Admissible, authorized: boolean, _now: number) {
  const { ask } = snapshot;
  const refused =
    snapshot.approval === false
      ? 'not_approved'
      : authorized || snapshot.approval === true
        ? null
        : neoAskApprovalRefusal(ask, null);

  return refused ? refuse(refused) : { value: snapshot };
}

function requireNeoAdmissionPrerequisites(snapshot: Admissible) {
  return snapshot.blockers.length
    ? refuse('prerequisites_unmet', snapshot.blockers)
    : { value: snapshot };
}

const checkNeoAdmission = (superpipe({})('neo-work-admission-check') as PipelineAPI)
  .input(['workId', 'authorized', 'now', 'deps'])
  .pipe(readNeoAdmission, ['workId', 'deps'], 'snapshot')
  .pipe(requireNeoAdmissionCard, 'snapshot', 'result:admission')
  .pipe(requireNeoAdmissionHandoff, 'admission', 'result:admission')
  .pipe(requireNeoAdmissionAuthorized, ['admission', 'authorized', 'now'], 'result:admission')
  .pipe(requireNeoAdmissionPrerequisites, 'admission', 'result:admission')
  .end('admission') as (
  workId: string,
  authorized: boolean,
  now: number,
  deps: NeoAdmissionDeps
) => Admissible | NeoAdmissionRefusal;

const asNeoAdmissionGate = (checked: Admissible | NeoAdmissionRefusal) =>
  'ok' in checked ? { reason: checked } : { value: checked };

export const admitNeoWork = (superpipe({})('neo-work-admission') as PipelineAPI)
  .input(['workId', 'authorized', 'now', 'deps'])
  .pipe(
    (workId: string, authorized: boolean, now: number, deps: NeoAdmissionDeps) =>
      asNeoAdmissionGate(checkNeoAdmission(workId, authorized, now, deps)),
    ['workId', 'authorized', 'now', 'deps'],
    'result:admission'
  )
  .pipe(
    (
      admitted: Admissible,
      workId: string,
      authorized: boolean,
      now: number,
      deps: NeoAdmissionDeps
    ) => {
      if (deps.claim(workId, () => !('ok' in checkNeoAdmission(workId, authorized, now, deps))))
        return { value: admitted };
      const checked = checkNeoAdmission(workId, authorized, now, deps);
      return 'ok' in checked ? { reason: checked } : refuse('already_claimed');
    },
    ['admission', 'workId', 'authorized', 'now', 'deps'],
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
  authorized: boolean,
  now: number,
  deps: NeoAdmissionDeps
) => Promise<{ ok: true; handoff: NeoAdmissionHandoff } | NeoAdmissionRefusal>;
