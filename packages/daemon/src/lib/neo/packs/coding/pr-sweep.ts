import { createHash } from 'node:crypto';
import { codingRepoWatched } from './watched-repos.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { planNudge } from '../../nudge.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import { Logger } from '../../../logger.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { JobQueueRepository } from '../../../../storage/repositories/job-queue-repository.ts';
import { type CodingAttend, codingPrHeadEvent } from './attention.ts';
import { CodingPrLedgerRepository, type CodingPrState } from './pr-ledger.ts';
import { CodingStageFactsRepository, codingCrossModelFindings } from './stage-facts.ts';
import { readCodingReviewThreads } from './connector-review-thread-reader.ts';

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
  mergeBy?: 'owner' | 'daemon';
  findings?: string[];
};

export type CodingSweepDeps = {
  host: string;
  human?(key: string, text: string): Promise<boolean>;
  tell(
    ref: WorkRef,
    key: string,
    text: string,
    pr?: string,
    findings?: readonly string[]
  ): Promise<boolean>;
  wake(key: string, text: string): Promise<boolean>;
};

export const STATE_TEXT: Partial<Record<CodingPrState, string>> = {
  approved_green: 'approved and green',
  dirty: 'in conflict with its base',
  failing: 'failing CI',
  changes_requested: 'waiting on requested changes',
  waiting_review: 'waiting for review',
  approved_pending: 'approved with CI still pending',
  waiting_ci: 'waiting for CI',
  waiting_cross_review: 'waiting for a cross-model review',
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
  if (row.state === 'approved_green' && row.mergeBy === 'daemon') return null;
  if (!STATE_TEXT[row.state] || now - row.readAt > CODING_PR_FRESH_MS) return null;
  if (!row.owner && row.state !== 'waiting_cross_review') return null;
  return planNudge({ since: row.stateSince, nudges: row.nudges }, now);
}

const minutesSince = (row: CodingSweepRow, now: number) =>
  Math.round((now - row.stateSince) / 60_000);

const owned = (ref: WorkRef) => `${ref.adapter}:${ref.id}${ref.daemon ? `@${ref.daemon}` : ''}`;

const TRUNCATED = ' … (truncated; ask Neo for the full cross-model review of this head)';

export function codingFindingsText(findings: readonly string[] = [], budget = Infinity): string {
  const text = findings.length ? ` Review findings: ${findings.join(' ')}` : '';
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return '';
  const kept = text.slice(0, budget - TRUNCATED.length);
  return `${kept.isWellFormed() ? kept : kept.slice(0, -1)}${TRUNCATED}`;
}

export const codingReviewKey = (findings: readonly string[] = []) =>
  findings.length ? ':review' : '';

export const codingDeliveryKey = (key: string) =>
  key.length <= 200
    ? key
    : `${key.slice(0, 100)}:${createHash('sha256').update(key).digest('hex')}`;

export const codingFailingReviewKey = (
  row: Pick<CodingSweepRow, 'repo' | 'number' | 'head' | 'findings'>
) =>
  codingDeliveryKey(
    `neo-pr-event:${row.repo}#${row.number}:${row.head}:failing:review:${createHash('sha256')
      .update(JSON.stringify([...new Set(row.findings)].sort()))
      .digest('hex')}`
  );

export const codingFailingText = (
  row: Pick<CodingSweepRow, 'repo' | 'number' | 'title' | 'head'>
) =>
  `${row.repo}#${row.number} "${row.title}" has failing CI on head ${row.head.slice(0, 7)}. Fix it and push.`;

export function codingPrNudgeText(row: CodingSweepRow, now: number): string {
  return `${row.repo}#${row.number} "${row.title}" has been ${STATE_TEXT[row.state] ?? row.state} for ${minutesSince(row, now)} min on head ${row.head.slice(0, 7)}. ${NEXT_STEP[row.state] ?? ''}`;
}

export function codingPrEscalationText(row: CodingSweepRow): string {
  const since = new Date(row.stateSince).toISOString();
  if (row.state === 'waiting_cross_review')
    return `PR sweep: ${row.repo}#${row.number} "${row.title}" has been ${STATE_TEXT[row.state]} since ${since} on head ${row.head.slice(0, 7)}. Assign a Review by a different model than its Agent line (a non-Claude reviewer for a Claude author) with neo.coding.assign.`;
  return `PR sweep: ${row.repo}#${row.number} "${row.title}" has been ${STATE_TEXT[row.state] ?? row.state} since ${since} on head ${row.head.slice(0, 7)}, and its owner ${owned(row.owner!)} could not be reached or has made no progress. Reassign it to a free session.${row.state === 'approved_green' ? ' If its owner is gone, complete the required merge gates before a SHA-pinned manual merge.' : ''}`;
}

export class CodingPrSweepRepository {
  constructor(private readonly db: Database) {}

  rowsAsync(): Promise<CodingSweepRow[]> {
    return gatewayFor(this.db).call(codingSweepReads, 'rows');
  }

  rows(): CodingSweepRow[] {
    return (
      this.db
        .prepare(
          `SELECT repo, number, title, head, state, state_since AS stateSince, read_at AS readAt,
                  nudges, owner FROM pack_coding_pr_ledger
            WHERE (owner IS NOT NULL OR state = 'waiting_cross_review') AND closed_at IS NULL`
        )
        .all() as (Omit<CodingSweepRow, 'owner'> & { owner: string | null })[]
    )
      .filter((row) => codingRepoWatched(this.db, row.repo))
      .map((row) => ({
        ...row,
        mergeBy: new CodingPrLedgerRepository(this.db).policy(row.repo).mergeBy,
        owner: row.owner ? (JSON.parse(row.owner) as WorkRef) : null,
        findings: ['changes_requested', 'failing'].includes(row.state)
          ? [
              ...codingCrossModelFindings(
                row.head,
                new CodingStageFactsRepository(this.db).read(
                  `https://${process.env.GH_HOST ?? 'github.com'}/${row.repo}/pull/${row.number}`
                )
              ),
              ...(() => {
                const threads = readCodingReviewThreads(
                  this.db,
                  `https://${process.env.GH_HOST ?? 'github.com'}/${row.repo}/pull/${row.number}`,
                  Date.now()
                );
                return threads?.headOid === row.head ? threads.unresolvedThreadUrls : [];
              })(),
            ]
          : [],
      }));
  }

  markLater(row: CodingSweepRow, nudges: number, now: number): Promise<void> {
    return gatewayFor(this.db).call(codingSweepWrites, 'mark', row, nudges, now);
  }

  reviewSentLater(key: string): Promise<boolean> {
    return gatewayFor(this.db).call(codingSweepReads, 'reviewSent', key);
  }

  markReviewLater(key: string): Promise<void> {
    return gatewayFor(this.db).call(codingSweepWrites, 'markReview', key);
  }

  reviewSent(key: string): boolean {
    return new JobQueueRepository(this.db).submissionReceipt(key, key) !== null;
  }

  markReview(key: string): void {
    const receipts = new JobQueueRepository(this.db);
    if (receipts.submissionReceipt(key, key) === null)
      receipts.recordSubmissionReceipt(key, key, {});
  }

  mark(row: CodingSweepRow, nudges: number, now: number): void {
    this.db
      .prepare(
        `UPDATE pack_coding_pr_ledger SET nudges = ?, told_at = ?
          WHERE repo = ? AND number = ? AND head = ? AND state = ? AND state_since = ?`
      )
      .run(nudges, now, row.repo, row.number, row.head, row.state, row.stateSince);
  }
}

export const codingPrUrl = (host: string, row: { repo: string; number: number }) =>
  `https://${host}/${row.repo}/pull/${row.number}`;

export async function sweepCodingPrs(
  repo: CodingPrSweepRepository,
  deps: Pick<CodingSweepDeps, 'host' | 'tell'> & { attend: CodingAttend },
  now: number
): Promise<void> {
  for (const row of await repo.rowsAsync()) {
    if (
      row.state === 'failing' &&
      row.owner &&
      row.findings?.length &&
      now - row.readAt <= CODING_PR_FRESH_MS
    ) {
      const key = codingFailingReviewKey(row);
      const told =
        !(await repo.reviewSentLater(key)) &&
        (await deps
          .tell(row.owner, key, codingFailingText(row), codingPrUrl(deps.host, row), row.findings)
          .catch(() => false));
      if (told) await repo.markReviewLater(key);
    }
    const nudge = planCodingPrNudge(row, now);
    if (!nudge) continue;
    const key = codingDeliveryKey(
      `neo-pr-sweep:${row.repo}#${row.number}:${row.head}:${row.state}${codingReviewKey(row.findings)}:${nudge.nudges}`
    );
    const told =
      nudge.kind === 'remind' &&
      row.state !== 'waiting_cross_review' &&
      (await deps
        .tell(
          row.owner!,
          key,
          codingPrNudgeText(row, now),
          codingPrUrl(deps.host, row),
          row.findings
        )
        .catch(() => false));
    if (nudge.kind === 'remind' && row.state !== 'waiting_cross_review')
      log.warn(`PR sweep ${key} to ${owned(row.owner!)}: ${told ? 'told' : 'not told'}`);
    if (told) {
      await repo.markLater(row, nudge.nudges, now);
      continue;
    }
    const woken = await deps
      .attend(
        codingPrHeadEvent(
          'coding.pr_sweep',
          { url: codingPrUrl(deps.host, row), head: row.head },
          row.stateSince,
          codingPrEscalationText(row)
        )
      )
      .catch(() => false);
    log.warn(
      `PR sweep ${key} escalated to Neo (${row.state === 'waiting_cross_review' ? 'review needed' : nudge.kind === 'remind' ? 'owner unreachable' : 'no progress'}): ${woken ? 'woken' : 'not woken'}`
    );
    if (woken) await repo.markLater(row, CODING_PR_REMINDERS + 1, now);
  }
}

export const codingSweepWrites = defineRepositoryOp(
  'coding.sweepWrites',
  'write',
  CodingPrSweepRepository,
  ['mark', 'markReview']
);

export const codingSweepReads = defineRepositoryOp(
  'coding.sweep.read',
  'read',
  CodingPrSweepRepository,
  ['rows', 'reviewSent'] as const
);
