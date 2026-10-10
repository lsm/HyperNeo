import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE, type NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef, WorkStatus } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { isNeoAskLive } from './done-check.ts';
import { readDriverFollowUp, readDriverLive } from './driver-work.ts';

type Gate<T> = { value: T } | { reason: null };

const NEO_WORK_FOLLOW_READ_MS = 2 * 60_000;
const NEO_WORK_FOLLOW_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const NEO_WORK_REPORT_MAX = 12_000;

const NEO_WORK_LIVE_FINAL: readonly WorkStatus[] = ['done', 'failed', 'stopped'];

type NeoWorkFollowCard = {
  ref: WorkRef | null;
  goal: boolean;
  ask: Pick<NeoAsk, 'status'> | null;
  readAt: number | null;
  superseded: boolean;
  live: WorkStatus | null;
};

const followsUp = (work: Pick<NeoWork, 'report'>, card: NeoWorkFollowCard) =>
  card.goal && isNeoAskLive(card.ask) && work.report !== NEO_WORK_CLOSED_DONE;

export function requireNeoWorkFollow(
  work: NeoWork,
  card: NeoWorkFollowCard,
  now: number
): Gate<WorkRef> {
  const due = card.readAt === null || now - card.readAt >= NEO_WORK_FOLLOW_READ_MS;
  const liveOpen = card.live !== null && !NEO_WORK_LIVE_FINAL.includes(card.live);
  return work.status === 'reported' &&
    work.report !== NEO_WORK_CLOSED_DONE &&
    card.ref &&
    !card.superseded &&
    (followsUp(work, card) || liveOpen) &&
    due &&
    now - work.updatedAt < NEO_WORK_FOLLOW_MAX_AGE_MS
    ? { value: card.ref }
    : { reason: null };
}

export function requireNeoWorkFollowUp(
  work: Pick<NeoWork, 'report'>,
  card: NeoWorkFollowCard
): Gate<WorkRef> {
  return card.ref && followsUp(work, card) ? { value: card.ref } : { reason: null };
}

export function planNeoWorkFollowLive(read: {
  outcome: OperationOutcome;
}): { status: WorkStatus; link?: string; remoteLink?: string } | null {
  const live = readDriverLive(read.outcome);
  return live ? { status: live.status, link: live.link, remoteLink: live.remoteLink } : null;
}

export function planNeoWorkFollow(
  work: Pick<NeoWork, 'updatedAt' | 'report'>,
  read: { outcome: OperationOutcome },
  card: { since: number }
): Gate<string> {
  const said = readDriverFollowUp(read.outcome, card.since);
  if (!said) return { reason: null };
  const report = `${said}\n\nEarlier report:\n${work.report ?? ''}`;
  return { value: report.slice(0, NEO_WORK_REPORT_MAX) };
}
