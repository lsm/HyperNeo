import type { Database } from '../../../../storage/sqlite-compat.ts';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';

export function readCodingReviewCommentMark(db: Database, url: string): string | null {
  const row = db
    .prepare('SELECT marker FROM pack_coding_review_comments WHERE url = ?')
    .get(githubUrlKey(url)) as { marker: string } | undefined;
  return row?.marker ?? null;
}

export function recordCodingReviewCommentMark(db: Database, url: string, marker: string): void {
  db.prepare(
    `INSERT INTO pack_coding_review_comments (url, marker) VALUES (?, ?)
    ON CONFLICT(url) DO UPDATE SET marker = excluded.marker`
  ).run(githubUrlKey(url), marker);
}
