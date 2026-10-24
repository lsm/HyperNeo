import { codingRepoWatched } from './watched-repos.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { planNudge } from '../../nudge.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import { Logger } from '../../../logger.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { CodingPrState } from './pr-ledger.ts';

export const CODING_PR_FRESH_MS = 15 * 60_000;
export const CODING_PR_REMINDERS = 2;
export const CODING_MANUAL_MERGE_NEXT_STEP =
  'Complete all required merge gates, re-read the head, then squash-merge manually with --match-head-commit and the full approved head SHA.';

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
  waiting_ci: 'waiting for CI',
};

const NEXT_STEP: Partial<Record<CodingPrState, string>> = {
  approved_green: CODING_MANUAL_MERGE_NEXT_STEP,
  dirty: 'Merge the base branch in, resolve the conflicts and push.',
  failing: 'Fix the failing CI and push.',
  changes_requested: 'Address the review and push.',
  waiting_review: 'Get it reviewed; re-request the review bot if its review stalled.',
  waiting_ci: 'CI is still running; fix it if it fails.',
  approved_pending: 'CI is still running; fix it if it fails.',
};

export function planCodingPrNudge(
  row: CodingSweepRow,
  now: number
): { kind: 'remind' | 'escalate'; nudges: number } | null {
  if (!STATE_TEXT[row.state] || !row.owner || now - row.readAt > CODING_PR_FRESH_MS) return null;
  return planNudge({ since: row.stateSince, nudges: row.nudges }, now);
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
    : `its owner ${owned(row.owner!)} has made no progress`;
  return `PR sweep: ${row.repo}#${row.number} "${row.title}" has been ${STATE_TEXT[row.state] ?? row.state} for ${minutesSince(row, now)} min on head ${row.head.slice(0, 7)}, and ${why}. Reassign it to a free session.${row.state === 'approved_green' ? ' If its owner is gone, complete the required merge gates before a SHA-pinned manual merge.' : ''}`;
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
    )
      .filter((row) => codingRepoWatched(this.db, row.repo))
      .map((row) => ({ ...row, owner: JSON.parse(row.owner) as WorkRef }));
  }

  markLater(row: CodingSweepRow, nudges: number, now: number): Promise<void> {
    return gatewayFor(this.db).call(codingSweepWrites, 'mark', row, nudges, now);
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
    if (nudge.kind === 'remind')
      log.warn(`PR sweep ${key} to ${owned(row.owner!)}: ${told ? 'told' : 'not told'}`);
    if (told) {
      await repo.markLater(row, nudge.nudges, now);
      continue;
    }
    const woken = await deps
      .wake(key, codingPrEscalationText(row, now, nudge.kind === 'remind'))
      .catch(() => false);
    log.warn(`PR sweep ${key} escalated to Neo: ${woken ? 'woken' : 'not woken'}`);
    if (woken) await repo.markLater(row, CODING_PR_REMINDERS + 1, now);
  }
}

export const codingSweepWrites = defineRepositoryOp(
  'coding.sweepWrites',
  'write',
  CodingPrSweepRepository,
  ['mark']
);
