import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  isNeoWorkClosedDone,
  type NeoAsk,
  type NeoWorkPr,
  type NeoWorkWake,
} from '@hyperneo/shared/types/neo-snapshot';

type Rejection = { ok: false; reason: string };

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

export function neoCardStalledWakes(
  wake: Pick<NeoWorkWake, 'stalled'> | null,
  human: boolean
): number {
  return human ? 0 : (wake?.stalled ?? 0);
}

export function isNeoHumanInputSince(lastAskedAt: number | null, since: number): boolean {
  return lastAskedAt !== null && lastAskedAt > since;
}

const APPROVAL_ONLY = /^needs \d+ approving reviews?, has \d+$/;

export function isNeoCardPrAwaited(pr: NeoWorkPr): boolean {
  if (pr.state !== 'OPEN') return false;
  if (pr.checks === 'pending') return true;
  if (pr.checks === 'failing' || pr.review !== 'none') return false;
  const blockers = pr.blockers ?? [];
  return blockers.length > 0 && blockers.every((blocker) => APPROVAL_ONLY.test(blocker));
}

export function isNeoCardDoneWhenMet(
  work: Pick<NeoWork, 'report'>,
  ask: Pick<NeoAsk, 'doneItems'> | null
): boolean {
  if (isNeoWorkClosedDone(work.report)) return true;
  const items = (ask?.doneItems ?? []).filter((item) => !item.removed);
  return items.length > 0 && items.every((item) => item.state === 'met');
}

const refuse = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export function requireNeoContinueTurn<T>(
  target: T,
  turn: NeoContinueTurn
): { value: T } | { reason: Rejection } {
  if (!turn.guarded) return { value: target };
  if (turn.doneWhenMet)
    return refuse(
      "done_when_met: this card's doneWhen is met; settle or close it instead of continuing. New scope is a new card."
    );
  const awaited = turn.prs.find(isNeoCardPrAwaited);
  if (awaited)
    return refuse(
      `waiting_on_pr: ${awaited.url} is waiting on ${awaited.checks === 'pending' ? 'CI' : 'review'}; the daemon wakes you when its verdict changes. Do not continue the card meanwhile.`
    );
  const wake = turn.wake;
  if (!turn.human && wake && wake.wakes > 0 && wake.continuedWake === wake.wakes)
    return refuse(
      'already_continued: this card was already continued in this wake; wait for its next report.'
    );
  return { value: target };
}
