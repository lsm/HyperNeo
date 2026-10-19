import type { WorkRef } from '../../../drivers/types.ts';
import { Logger } from '../../../logger.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { CodingPrState } from './pr-ledger.ts';

export const CODING_PR_DEADLINE_MIN: Partial<Record<CodingPrState, number>> = {
  approved_green: 20,
  dirty: 20,
  failing: 30,
  changes_requested: 30,
  waiting_review: 30,
  approved_pending: 60,
};
export const CODING_PR_FRESH_MS = 15 * 60_000;
export const CODING_PR_REMINDERS = 2;

const log = new Logger('NeoPrSweep');

export type CodingSweepRow = {
  repo: string;
  number: number;
  title: string;
  head: string;
  state: CodingPrState;
  stateSince: number;
  readAt: number;
  nudges: number;
  owner: WorkRef | null;
};

export type CodingSweepDeps = {
  tell(ref: WorkRef, key: string, text: string): Promise<boolean>;
  wake(key: string, text: string): Promise<boolean>;
};

const STATE_TEXT: Partial<Record<CodingPrState, string>> = {
  approved_green: 'approved and green',
  dirty: 'in conflict with its base',
  failing: 'failing CI',
  changes_requested: 'waiting on requested changes',
  waiting_review: 'waiting for review',
  approved_pending: 'approved with CI still pending',
};

const NEXT_STEP: Partial<Record<CodingPrState, string>> = {
  approved_green: 'Merge it now with a manual squash on this head.',
  dirty: 'Merge the base branch in, resolve the conflicts and push.',
  failing: 'Fix the failing CI and push.',
  changes_requested: 'Address the review and push.',
  waiting_review: 'Get it reviewed; re-request the review bot if its review stalled.',
  approved_pending:
    'This is usually CI capacity, not something to fix; merge once CI is green, and look only if a check is stuck.',
};

export function planCodingPrNudge(
  row: CodingSweepRow,
  now: number
): { kind: 'remind' | 'escalate'; nudges: number } | null {
  const minutes = CODING_PR_DEADLINE_MIN[row.state];
  if (!minutes || !row.owner || now - row.readAt > CODING_PR_FRESH_MS) return null;
  const due = Math.floor((now - row.stateSince) / (minutes * 60_000));
  if (row.nudges > CODING_PR_REMINDERS || due <= row.nudges) return null;
  return row.nudges < CODING_PR_REMINDERS
    ? { kind: 'remind', nudges: row.nudges + 1 }
    : { kind: 'escalate', nudges: CODING_PR_REMINDERS + 1 };
}

const minutesSince = (row: CodingSweepRow, now: number) =>
  Math.round((now - row.stateSince) / 60_000);

const owned = (ref: WorkRef) => `${ref.adapter}:${ref.id}${ref.daemon ? `@${ref.daemon}` : ''}`;

export function codingPrNudgeText(row: CodingSweepRow, now: number): string {
  return `${row.repo}#${row.number} "${row.title}" has been ${STATE_TEXT[row.state] ?? row.state} for ${minutesSince(row, now)} min on head ${row.head.slice(0, 7)}. ${NEXT_STEP[row.state] ?? ''}`;
}

export function codingPrEscalationText(
  row: CodingSweepRow,
  now: number,
  unreachable: boolean
): string {
  const why = unreachable
    ? `its owner ${owned(row.owner!)} could not be reached`
    : `its owner ${owned(row.owner!)} was reminded ${CODING_PR_REMINDERS} times without progress`;
  return `PR sweep: ${row.repo}#${row.number} "${row.title}" has been ${STATE_TEXT[row.state] ?? row.state} for ${minutesSince(row, now)} min on head ${row.head.slice(0, 7)}, and ${why}. Reassign it to a free session, or merge it yourself if it is approved and green and the owner is gone.`;
}

export class CodingPrSweepRepository {
  constructor(private readonly db: Database) {}

  rows(): CodingSweepRow[] {
    return (
      this.db
        .prepare(
          `SELECT repo, number, title, head, state, state_since AS stateSince, read_at AS readAt,
                  nudges, owner FROM pack_coding_pr_ledger
            WHERE owner IS NOT NULL AND closed_at IS NULL`
        )
        .all() as (Omit<CodingSweepRow, 'owner'> & { owner: string })[]
    ).map((row) => ({ ...row, owner: JSON.parse(row.owner) as WorkRef }));
  }

  mark(row: CodingSweepRow, nudges: number, now: number): void {
    this.db
      .prepare(
        `UPDATE pack_coding_pr_ledger SET nudges = ?, told_at = ?
          WHERE repo = ? AND number = ? AND head = ? AND state = ?`
      )
      .run(nudges, now, row.repo, row.number, row.head, row.state);
  }
}

export async function sweepCodingPrs(
  repo: CodingPrSweepRepository,
  deps: CodingSweepDeps,
  now: number
): Promise<void> {
  for (const row of repo.rows()) {
    const nudge = planCodingPrNudge(row, now);
    if (!nudge) continue;
    const key = `neo-pr-sweep:${row.repo}#${row.number}:${row.head}:${row.state}:${nudge.nudges}`;
    const told =
      nudge.kind === 'remind' &&
      (await deps.tell(row.owner!, key, codingPrNudgeText(row, now)).catch(() => false));
    log.info(`PR sweep ${key} to ${owned(row.owner!)}: ${told ? 'told' : 'not told'}`);
    if (told) {
      repo.mark(row, nudge.nudges, now);
      continue;
    }
    const woken = await deps
      .wake(key, codingPrEscalationText(row, now, nudge.kind === 'remind'))
      .catch(() => false);
    log.info(`PR sweep ${key} escalated to Neo: ${woken ? 'woken' : 'not woken'}`);
    if (woken) repo.mark(row, CODING_PR_REMINDERS + 1, now);
  }
}
