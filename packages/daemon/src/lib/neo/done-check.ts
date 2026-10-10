import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkGoal, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoDoneCheckMessageId } from './ask-origin.ts';
import { isNeoWorkPrWaiting } from './work-prs.ts';

type Gate<T> = { value: T } | { reason: boolean };

export const isNeoAskLive = (ask: Pick<NeoAsk, 'status'> | null) =>
  !!ask && ask.status !== 'achieved' && ask.status !== 'abandoned';

export function requireNeoDoneCheck(
  work: Pick<NeoWork, 'status'>,
  card: {
    goal: NeoWorkGoal | null;
    driver: boolean;
    session: boolean;
    ask: Pick<NeoAsk, 'status'> | null;
  }
): Gate<NeoWorkGoal> {
  if (card.ask && !isNeoAskLive(card.ask)) return { reason: true };
  return work.status === 'reported' &&
    card.goal?.doneWhen &&
    card.driver &&
    card.session &&
    card.ask
    ? { value: card.goal }
    : { reason: false };
}

export function neoDoneCheckToldIds(
  work: Pick<NeoWork, 'id' | 'updatedAt'>,
  continued: number,
  revision: number | undefined,
  followed: boolean
): string[] {
  return (followed ? [work.updatedAt] : [undefined, work.updatedAt]).map((at) =>
    neoDoneCheckMessageId(work.id, continued, revision, at)
  );
}

export function requireNeoDoneCheckUntold<T>(read: { told: boolean }, value: T): Gate<T> {
  return read.told ? { reason: true } : { value };
}

export function requireNeoDoneCheckDue<T>(
  found: { row: { prs: readonly NeoWorkPr[] } | null },
  value: T
): Gate<T> {
  return found.row && isNeoWorkPrWaiting(found.row.prs) ? { reason: true } : { value };
}
