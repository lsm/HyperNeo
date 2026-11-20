import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { codingReviewAfter } from './stage-preferences.ts';
import { codingRepoWatched } from './watched-repos.ts';

export type CodingReviewAfterDue = { repo: string; number: number; title: string; head: string };
type Due = CodingReviewAfterDue;

export class CodingReviewAfterRepository {
  constructor(private readonly db: Database) {}

  observe(now: number): void {
    const eligible = (
      this.db
        .prepare(
          `SELECT repo, number, title, head FROM pack_coding_pr_ledger
            WHERE closed_at IS NULL AND state IN ('approved_green', 'waiting_cross_review')`
        )
        .all() as Due[]
    ).filter(
      (row) =>
        codingRepoWatched(this.db, row.repo) && codingReviewAfter(this.db, row.repo) === 'approved'
    );
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO pack_coding_review_after (repo, number, head, title, observed_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const row of eligible) insert.run(row.repo, row.number, row.head, row.title, now);
  }

  due(): Due[] {
    return this.db
      .prepare(
        'SELECT repo, number, title, head FROM pack_coding_review_after WHERE delivered_at IS NULL ORDER BY observed_at'
      )
      .all() as Due[];
  }

  mark(row: Due, now: number): void {
    this.db
      .prepare(
        'UPDATE pack_coding_review_after SET delivered_at = ? WHERE repo = ? AND number = ? AND head = ?'
      )
      .run(now, row.repo, row.number, row.head);
  }
}

export const codingReviewAfterReads = defineRepositoryOp(
  'coding.reviewAfter.reads',
  'read',
  CodingReviewAfterRepository,
  ['due']
);
export const codingReviewAfterWrites = defineRepositoryOp(
  'coding.reviewAfter.writes',
  'write',
  CodingReviewAfterRepository,
  ['observe', 'mark']
);
