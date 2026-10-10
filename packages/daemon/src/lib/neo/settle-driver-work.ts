import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkRef, WorkStatus } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import {
  decideCardLiveStatus,
  type DriverSent,
  isNeoCardUnconfirmed,
  messageOpening,
  readDriverLanded,
  readDriverLive,
  readDriverSettlement,
} from './driver-work.ts';

type DriverLive = NonNullable<ReturnType<typeof readDriverLive>>;
type DriverSettled = NonNullable<ReturnType<typeof readDriverSettlement>>;

export interface NeoDriverSettleEvidence {
  startedAt: number | null;
  sent: DriverSent | null;
  outcome: OperationOutcome;
  priorLiveStatus: WorkStatus | null;
  continuing: boolean;
  now: number;
}

export interface NeoDriverSettlePlan {
  landed: number | null;
  live: DriverLive | null;
  cardStatus: WorkStatus | null;
  settled: DriverSettled | null;
}

export interface NeoDriverSettleDeps {
  readStartedAt(workId: string): number | null;
  readSent(workId: string): DriverSent | null;
  readLiveStatus(workId: string): WorkStatus | null;
  isContinuing(workId: string): boolean;
  readStatus(work: NeoWork, ref: WorkRef, since: number | null): Promise<OperationOutcome>;
  recordStartedAt(workId: string, at: number): void;
  recordLive(workId: string, status: WorkStatus, live: DriverLive): boolean;
  recordCheck(workId: string, read: boolean, now: number): boolean;
  notifyChanged(): void;
  noteUnsettled(work: NeoWork, ref: WorkRef, outcome: OperationOutcome): Promise<void>;
  forgetActivity(workId: string): void;
  transition(work: NeoWork, settled: DriverSettled): NeoWork | null;
  anchorFollow(workId: string, at: number): void;
  returnReport(work: NeoWork): Promise<void>;
}

export function planNeoDriverSettlement(
  work: NeoWork,
  evidence: NeoDriverSettleEvidence
): NeoDriverSettlePlan {
  const { startedAt, sent, outcome } = evidence;
  const landed = startedAt === null ? readDriverLanded(outcome, sent) : null;
  const live = readDriverLive(outcome);
  const anchored = startedAt ?? landed;
  return {
    landed,
    live,
    cardStatus: !live
      ? null
      : anchored === null && isNeoCardUnconfirmed(work, sent, evidence.now)
        ? live.status
        : decideCardLiveStatus(live, anchored, evidence.priorLiveStatus),
    settled:
      landed === null
        ? readDriverSettlement(
            work,
            outcome,
            evidence.now,
            startedAt,
            evidence.continuing,
            sent?.opening ?? (messageOpening(work.instruction) || null)
          )
        : null,
  };
}

export function requireNeoDriverSettled(
  plan: NeoDriverSettlePlan
): { value: DriverSettled } | { reason: 'unsettled' } {
  return plan.settled ? { value: plan.settled } : { reason: 'unsettled' };
}

async function readNeoDriverSettleEvidence(
  deps: NeoDriverSettleDeps,
  work: NeoWork,
  ref: WorkRef
): Promise<NeoDriverSettleEvidence> {
  const startedAt = deps.readStartedAt(work.id);
  const sent = deps.readSent(work.id);
  const outcome = await deps.readStatus(work, ref, startedAt ?? sent?.inputBefore ?? null);
  return {
    startedAt,
    sent,
    outcome,
    priorLiveStatus: deps.readLiveStatus(work.id),
    continuing: deps.isContinuing(work.id),
    now: Date.now(),
  };
}

function recordNeoDriverProgress(
  deps: NeoDriverSettleDeps,
  work: NeoWork,
  evidence: NeoDriverSettleEvidence,
  plan: NeoDriverSettlePlan
): void {
  if (plan.landed !== null) deps.recordStartedAt(work.id, plan.landed);
  const live =
    !!plan.live && !!plan.cardStatus && deps.recordLive(work.id, plan.cardStatus, plan.live);
  const freshness = deps.recordCheck(work.id, plan.live !== null, evidence.now);
  if (live || freshness) deps.notifyChanged();
}

async function noteUnsettledNeoDriverWork(
  deps: NeoDriverSettleDeps,
  work: NeoWork,
  ref: WorkRef,
  evidence: NeoDriverSettleEvidence,
  plan: NeoDriverSettlePlan
): Promise<void> {
  if (!plan.settled) await deps.noteUnsettled(work, ref, evidence.outcome);
}

function transitionSettledNeoDriverWork(
  deps: NeoDriverSettleDeps,
  work: NeoWork,
  settled: DriverSettled
): { work: NeoWork | null } {
  deps.forgetActivity(work.id);
  return { work: deps.transition(work, settled) };
}

async function returnSettledNeoDriverWork(
  deps: NeoDriverSettleDeps,
  plan: NeoDriverSettlePlan,
  done: { work: NeoWork | null }
): Promise<void> {
  if (!done.work) return;
  if (plan.live) deps.anchorFollow(done.work.id, plan.live.lastActivityAt);
  await deps.returnReport(done.work);
}

export const settleNeoDriverWork = (superpipe({})('neo.driver-work.settle') as PipelineAPI)
  .input(['deps', 'work', 'ref'])
  .pipe(readNeoDriverSettleEvidence, ['deps', 'work', 'ref'], 'evidence')
  .pipe(planNeoDriverSettlement, ['work', 'evidence'], 'plan')
  .pipe(recordNeoDriverProgress, ['deps', 'work', 'evidence', 'plan'])
  .pipe(noteUnsettledNeoDriverWork, ['deps', 'work', 'ref', 'evidence', 'plan'])
  .pipe(requireNeoDriverSettled, 'plan', 'result:settled')
  .pipe(transitionSettledNeoDriverWork, ['deps', 'work', 'settled'], 'done')
  .pipe(returnSettledNeoDriverWork, ['deps', 'plan', 'done'])
  .endAsync('settled') as (
  deps: NeoDriverSettleDeps,
  work: NeoWork,
  ref: WorkRef
) => Promise<DriverSettled | 'unsettled'>;
