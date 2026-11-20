import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { Logger } from '../../../logger.ts';
import { type CodingAttend, codingPrHeadEvent } from './attention.ts';
import {
  type CodingReviewAfterDue as Due,
  codingReviewAfterReads,
  codingReviewAfterWrites,
} from './review-after-worker.ts';
const log = new Logger('NeoCodingReviewAfter');

export const codingReviewAfterText = (row: Due, url: string) =>
  `${row.repo}#${row.number} "${row.title}" was approved on head ${row.head.slice(0, 7)}. This repository's coding preference review.after is "approved": add a todo that reviews ${url} at exactly ${row.head}, with named.workKind "coding.review" and target start so the daemon picks the reviewer line from the coding.review routes. It is done when the posted review link exists. Whether the review holds the merge stays with crossModelReview.`;

export async function deliverCodingReviewAfterApproval(
  db: Database,
  host: string,
  attend: CodingAttend,
  now = Date.now()
): Promise<void> {
  await gatewayFor(db).call(codingReviewAfterWrites, 'observe', now);
  for (const row of await gatewayFor(db).call(codingReviewAfterReads, 'due')) {
    const url = `https://${host}/${row.repo}/pull/${row.number}`;
    const woken = await attend(
      codingPrHeadEvent(
        'coding.review_after_approval',
        { url, head: row.head },
        0,
        codingReviewAfterText(row, url)
      )
    ).catch(() => false);
    if (woken) await gatewayFor(db).call(codingReviewAfterWrites, 'mark', row, now);
    else log.warn(`Review after approval for ${url}@${row.head.slice(0, 7)} not woken; retrying`);
  }
}
