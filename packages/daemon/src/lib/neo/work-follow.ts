import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE, type NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { NEO_DRIVER_NO_REPLY, readDriverSettlement } from './driver-work.ts';

type Gate<T> = { value: T } | { reason: null };

const NEO_WORK_FOLLOW_READ_MS = 2 * 60_000;
const NEO_WORK_FOLLOW_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const NEO_WORK_REPORT_MAX = 12_000;

export function requireNeoWorkFollow(
  work: NeoWork,
  card: {
    ref: WorkRef | null;
    goal: boolean;
    ask: Pick<NeoAsk, 'status'> | null;
    readAt: number | null;
  },
  now: number
): Gate<WorkRef> {
  const live = !!card.ask && card.ask.status !== 'achieved' && card.ask.status !== 'abandoned';
  const due = card.readAt === null || now - card.readAt >= NEO_WORK_FOLLOW_READ_MS;
  return work.status === 'reported' &&
    work.report !== NEO_WORK_CLOSED_DONE &&
    card.ref &&
    card.goal &&
    live &&
    due &&
    now - work.updatedAt < NEO_WORK_FOLLOW_MAX_AGE_MS
    ? { value: card.ref }
    : { reason: null };
}

export function planNeoWorkFollow(
  work: Pick<NeoWork, 'updatedAt' | 'report'>,
  read: { outcome: OperationOutcome },
  now: number,
  card: { since: number }
): Gate<string> {
  const settled = readDriverSettlement(work, read.outcome, now, card.since, true);
  if (settled?.status !== 'reported' || settled.report === NEO_DRIVER_NO_REPLY)
    return { reason: null };
  const report = `${settled.report}\n\nEarlier report:\n${work.report ?? ''}`;
  return { value: report.slice(0, NEO_WORK_REPORT_MAX) };
}
