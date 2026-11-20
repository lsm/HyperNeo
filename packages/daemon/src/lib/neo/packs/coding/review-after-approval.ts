import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { JobQueueRepository } from '../../../../storage/repositories/job-queue-repository.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { Logger } from '../../../logger.ts';
import { type CodingAttend, codingPrHeadEvent } from './attention.ts';
import { codingReviewAfter } from './stage-preferences.ts';
import { codingRepoWatched } from './watched-repos.ts';

type Due = { repo: string; number: number; title: string; head: string };
const log = new Logger('NeoCodingReviewAfter');
const receipt = (row: Due) => `coding.review_after_approval:${row.repo}#${row.number}@${row.head}`;

export class CodingReviewAfterRepository {
  constructor(private readonly db: Database) {}

  due(): Due[] {
    const receipts = new JobQueueRepository(this.db);
    return (
      this.db
        .prepare(
          `SELECT repo, number, title, head FROM pack_coding_pr_ledger
            WHERE closed_at IS NULL AND state IN ('approved_green', 'waiting_cross_review')`
        )
        .all() as Due[]
    ).filter(
      (row) =>
        codingRepoWatched(this.db, row.repo) &&
        codingReviewAfter(this.db, row.repo) === 'approved' &&
        receipts.submissionReceipt(receipt(row), receipt(row)) === null
    );
  }

  mark(row: Due): void {
    const receipts = new JobQueueRepository(this.db);
    if (receipts.submissionReceipt(receipt(row), receipt(row)) === null)
      receipts.recordSubmissionReceipt(receipt(row), receipt(row), {});
  }
}

const reads = defineRepositoryOp('coding.reviewAfter.reads', 'read', CodingReviewAfterRepository, [
  'due',
]);
const writes = defineRepositoryOp(
  'coding.reviewAfter.writes',
  'write',
  CodingReviewAfterRepository,
  ['mark']
);

export const codingReviewAfterText = (row: Due, url: string) =>
  `${row.repo}#${row.number} "${row.title}" was approved on head ${row.head.slice(0, 7)}. This repository's coding preference review.after is "approved": add a todo that reviews ${url} at exactly ${row.head}, with named.workKind "coding.review" and target start so the daemon picks the reviewer line from the coding.review routes. It is done when the posted review link exists. Whether the review holds the merge stays with crossModelReview.`;

export async function deliverCodingReviewAfterApproval(
  db: Database,
  host: string,
  attend: CodingAttend
): Promise<void> {
  for (const row of await gatewayFor(db).call(reads, 'due')) {
    const url = `https://${host}/${row.repo}/pull/${row.number}`;
    const woken = await attend(
      codingPrHeadEvent(
        'coding.review_after_approval',
        { url, head: row.head },
        0,
        codingReviewAfterText(row, url)
      )
    ).catch(() => false);
    if (woken) await gatewayFor(db).call(writes, 'mark', row);
    else log.warn(`Review after approval for ${url}@${row.head.slice(0, 7)} not woken; retrying`);
  }
}
