import type { WorkRef } from '../../../drivers/types.ts';
import { Logger } from '../../../logger.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { CodingPrTransition } from './pr-ledger.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';
import {
  codingUnownedPrKey,
  planCodingUnownedNotice,
  type CodingUnownedNotice,
  type CodingUnownedPr,
} from './pr-unowned.ts';

const log = new Logger('NeoPrSweep');

const head = (row: CodingPrTransition) => row.head.slice(0, 7);
const pr = (row: CodingPrTransition) => `${row.repo}#${row.number} "${row.title}"`;

export function planCodingPrEvent(row: CodingPrTransition): { key: string; text: string } | null {
  const owner = (text: string) => ({
    key: `neo-pr-event:${row.repo}#${row.number}:${row.head}:${row.state}`,
    text: `${pr(row)} ${text}`,
  });
  if (row.state === 'merged') return owner(`was merged on head ${head(row)}.`);
  if (row.state === 'closed') return owner(`was closed without merging on head ${head(row)}.`);
  if (row.state === 'failing')
    return owner(`has failing CI on head ${head(row)}. Fix it and push.`);
  if (row.state === 'changes_requested')
    return owner(`has requested changes on head ${head(row)}. Address the review and push.`);
  if (row.state === 'dirty')
    return owner('now conflicts with its base. Merge the base branch in and push.');
  if (row.state === 'approved_green')
    return owner(
      `is approved and green on head ${head(row)}. Merge it now with a manual squash on this head.`
    );
  if (
    row.from === 'failing' &&
    row.ci === 'SUCCESS' &&
    ['waiting_review', 'waiting_ci', 'waiting_human'].includes(row.state)
  )
    return owner(`has green CI again on head ${head(row)}.`);
  return null;
}

export class CodingPrEventRepository {
  constructor(private readonly db: Database) {}

  pendingUnowned(now: number): CodingUnownedNotice | null {
    return this.db.transaction(() => {
      const pending = this.db
        .prepare(
          'SELECT pending_key AS key, pending_text AS text FROM pack_coding_pr_unowned_state WHERE id = 1'
        )
        .get() as CodingUnownedNotice;
      if (pending.key) return pending;
      const rows = this.db
        .prepare(
          `SELECT l.repo, l.number, l.title FROM pack_coding_pr_ledger l
           JOIN pack_coding_pr_unowned_state s ON s.id = 1
          WHERE l.owner IS NULL AND l.closed_at IS NULL AND l.state NOT IN ('draft', 'merged', 'closed')
            AND l.author_is_bot = 0 AND l.created_at > s.activated_at AND l.read_at = ?
            AND NOT EXISTS (SELECT 1 FROM pack_coding_pr_unowned n
              WHERE n.key = 'neo-pr-unowned:' || l.repo || '#' || l.number)
          ORDER BY l.repo, l.number`
        )
        .all(now) as CodingUnownedPr[];
      const notice = planCodingUnownedNotice(rows);
      if (!notice) return null;
      const insert = this.db.prepare(
        'INSERT INTO pack_coding_pr_unowned (key, listed_at) VALUES (?, ?)'
      );
      for (const row of rows) insert.run(codingUnownedPrKey(row), now);
      this.db
        .prepare(
          'UPDATE pack_coding_pr_unowned_state SET pending_key = ?, pending_text = ? WHERE id = 1'
        )
        .run(notice.key, notice.text);
      return notice;
    })();
  }

  unownedDelivered(key: string): void {
    this.db
      .prepare(
        'UPDATE pack_coding_pr_unowned_state SET pending_key = NULL, pending_text = NULL WHERE id = 1 AND pending_key = ?'
      )
      .run(key);
  }

  route(row: CodingPrTransition): { owner: WorkRef | null } {
    const found = this.db
      .prepare(
        `SELECT owner
           FROM pack_coding_pr_ledger l WHERE l.repo = ? AND l.number = ?`
      )
      .get(row.repo, row.number) as { owner: string | null } | null;
    return {
      owner: found?.owner ? (JSON.parse(found.owner) as WorkRef) : null,
    };
  }
}

export async function deliverCodingPrEvents(
  repo: CodingPrEventRepository,
  transitions: readonly CodingPrTransition[],
  deps: CodingSweepDeps
): Promise<void> {
  for (const row of transitions) {
    const event = planCodingPrEvent(row);
    const route = event ? repo.route(row) : null;
    if (!event || !route?.owner) continue;
    const told = await deps.tell(route.owner, event.key, event.text).catch(() => false);
    log.warn(
      `PR event ${event.key} to ${route.owner.adapter}:${route.owner.id}: ${told ? 'told' : 'not told'}`
    );
  }
}
