import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkGoal, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoDoneCheckMessageId, neoWorkReturnMessageId } from './ask-origin.ts';
import { isNeoWorkPrWaiting } from './packs/coding/work-prs.ts';

type Gate<T> = { value: T } | { reason: boolean };

export const isNeoAskSettled = (ask: Pick<NeoAsk, 'status'>) =>
  ask.status === 'achieved' || ask.status === 'abandoned';

export const isNeoAskLive = (ask: Pick<NeoAsk, 'status'> | null) => !!ask && !isNeoAskSettled(ask);

export function requireNeoDoneCheck(
  work: Pick<NeoWork, 'status'>,
  card: {
    goal: NeoWorkGoal | null;
    driver: boolean;
    session: boolean;
    ask: Pick<NeoAsk, 'status'> | null;
  }
): Gate<NeoWorkGoal> {
  if (work.status === 'reported' && card.ask && isNeoAskSettled(card.ask)) return { reason: true };
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

export function neoWorkReturnToldIds(
  work: Pick<NeoWork, 'id' | 'updatedAt'>,
  card: { retries: number; continued: number; prRevision: number | undefined }
): string[] {
  return [
    neoWorkReturnMessageId(work.id, card.retries, card.continued),
    ...neoDoneCheckToldIds(work, card.continued, undefined, false),
    ...(card.prRevision ? neoDoneCheckToldIds(work, card.continued, card.prRevision, false) : []),
  ];
}

export function requireNeoWorkReturnUntold(told: {
  told: boolean;
}): { value: true } | { reason: null } {
  return told.told ? { reason: null } : { value: true };
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
