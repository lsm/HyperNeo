import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  isNeoWorkClosedDone,
  type NeoAsk,
  type NeoWorkPr,
  type NeoWorkWake,
  type NeoWorkContinue,
} from '@hyperneo/shared/types/neo-snapshot';

export interface NeoContinueTurn {
  guarded: boolean;
  human: boolean;
  doneWhenMet: boolean;
  prs: readonly NeoWorkPr[];
  wake: Pick<NeoWorkWake, 'wakes' | 'continuedWake' | 'stalled'> | null;
}

export function neoCardWakeProgress(
  progress: string,
  ask: Pick<NeoAsk, 'doneItems'> | null
): string {
  const met = (ask?.doneItems ?? []).filter((item) => !item.removed && item.state === 'met');
  return `${progress}|${met.length}`;
}

export function isNeoHumanInputSince(lastAskedAt: number | null, since: number): boolean {
  return lastAskedAt !== null && lastAskedAt > since;
}

const APPROVAL_ONLY = /^needs \d+ approving reviews?, has \d+$/;

export function isNeoCardPrRoutine(pr: NeoWorkPr): boolean {
  if (pr.state !== 'OPEN') return false;
  if (pr.checks === 'pending') return true;
  if (pr.checks === 'failing' || pr.review !== 'none') return false;
  return (pr.blockers ?? []).every((blocker) => APPROVAL_ONLY.test(blocker));
}

export function isNeoCardDoneWhenMet(
  work: Pick<NeoWork, 'report'>,
  ask: Pick<NeoAsk, 'doneItems'> | null
): boolean {
  if (isNeoWorkClosedDone(work.report)) return true;
  const items = (ask?.doneItems ?? []).filter((item) => !item.removed);
  return items.length > 0 && items.every((item) => item.state === 'met');
}

export function neoContinueFacts(turn: NeoContinueTurn, continued: NeoWorkContinue | null) {
  return {
    done_when_met: turn.doneWhenMet,
    prior_sends: continued?.count ?? 0,
    last_send: continued ? { at: continued.continuedAt, message: continued.lastMessage } : null,
    progress: continued?.progress ?? null,
  };
}
