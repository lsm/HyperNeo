import { codingPrEventReads } from './pr-event-routing-db.ts';
import { codingRepoWatched } from './watched-repos.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import { Logger } from '../../../logger.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { callCodingBranchDb } from './branch-facts-db.ts';
import { codingUnownedWrites } from './unowned-db.ts';
import { CodingPrLedgerRepository, type CodingPrTransition } from './pr-ledger.ts';
import { CODING_MANUAL_MERGE_NEXT_STEP, type CodingSweepDeps } from './pr-sweep.ts';
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
      `has passing review and CI on head ${head(row)}. ${CODING_MANUAL_MERGE_NEXT_STEP}`
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

  private delivery: Promise<void> = Promise.resolve();

  exclusive(deliver: () => Promise<void>): Promise<void> {
    const run = this.delivery.then(deliver, deliver);
    this.delivery = run.catch(() => {});
    return run;
  }

  pendingEventsLater(): Promise<CodingPrTransition[]> {
    return gatewayFor(this.db).call(codingPrEventReads, 'pendingEvents');
  }

  routeLater(row: Pick<CodingPrTransition, 'repo' | 'number'>) {
    return gatewayFor(this.db).call(codingPrEventReads, 'route', {
      repo: row.repo,
      number: row.number,
    });
  }

  pendingEvents(): CodingPrTransition[] {
    return (
      this.db
        .prepare(`SELECT terminal_event_json AS event FROM pack_coding_pr_ledger
      WHERE terminal_event_json IS NOT NULL AND owner IS NOT NULL
      ORDER BY state_since, repo, number`)
        .all() as { event: string }[]
    )
      .map((row) => JSON.parse(row.event) as CodingPrTransition)
      .filter((row) => codingRepoWatched(this.db, row.repo));
  }

  acceptEvent(row: CodingPrTransition, owner: WorkRef): Promise<void> {
    return new CodingPrLedgerRepository(this.db).write(
      'acceptTerminalEvent',
      row,
      JSON.stringify(owner),
      Date.now()
    );
  }

  pendingUnowned(now: number): CodingUnownedNotice | null {
    return this.db.transaction(() => {
      const pending = this.db
        .prepare(
          'SELECT pending_key AS key, pending_text AS text, pending_rows AS rows FROM pack_coding_pr_unowned_state WHERE id = 1'
        )
        .get() as CodingUnownedNotice & { rows: string | null };
      if (pending.key && pending.rows) {
        const remaining = (JSON.parse(pending.rows) as CodingUnownedPr[]).filter((row) =>
          codingRepoWatched(this.db, row.repo)
        );
        const notice = planCodingUnownedNotice(remaining);
        if (notice) {
          this.db
            .prepare(
              'UPDATE pack_coding_pr_unowned_state SET pending_key = ?, pending_text = ?, pending_rows = ? WHERE id = 1'
            )
            .run(notice.key, notice.text, JSON.stringify(remaining));
          return notice;
        }
      }
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
      const watchedRows = rows.filter((row) => codingRepoWatched(this.db, row.repo));
      const notice = planCodingUnownedNotice(watchedRows);
      if (!notice) return null;
      const insert = this.db.prepare(
        'INSERT INTO pack_coding_pr_unowned (key, listed_at) VALUES (?, ?)'
      );
      for (const row of watchedRows) insert.run(codingUnownedPrKey(row), now);
      this.db
        .prepare(
          'UPDATE pack_coding_pr_unowned_state SET pending_key = ?, pending_text = ?, pending_rows = ? WHERE id = 1'
        )
        .run(notice.key, notice.text, JSON.stringify(watchedRows));
      return notice;
    })();
  }

  pendingUnownedLater(now: number): Promise<CodingUnownedNotice | null> {
    return callCodingBranchDb(
      () => gatewayFor(this.db).call(codingUnownedWrites, 'pending', now),
      'coding.unowned.db'
    );
  }

  unownedDeliveredLater(key: string): Promise<void> {
    return callCodingBranchDb(
      () => gatewayFor(this.db).call(codingUnownedWrites, 'acknowledge', key),
      'coding.unowned.db'
    );
  }

  unownedDelivered(key: string): void {
    this.db
      .prepare(
        'UPDATE pack_coding_pr_unowned_state SET pending_key = NULL, pending_text = NULL WHERE id = 1 AND pending_key = ?'
      )
      .run(key);
  }

  route(row: Pick<CodingPrTransition, 'repo' | 'number'>): { owner: WorkRef | null } {
    const found = this.db
      .prepare(
        `SELECT owner
           FROM pack_coding_pr_ledger l WHERE l.repo = ? AND l.number = ?`
      )
      .get(row.repo, row.number) as { owner: string | null } | null;
    return {
      owner:
        codingRepoWatched(this.db, row.repo) && found?.owner
          ? (JSON.parse(found.owner) as WorkRef)
          : null,
    };
  }
}

export async function deliverCodingPrEvents(
  repo: CodingPrEventRepository,
  transitions: readonly CodingPrTransition[],
  deps: CodingSweepDeps
): Promise<void> {
  return repo.exclusive(async () => {
    for (const row of transitions) {
      const event = planCodingPrEvent(row);
      if (event && !(await repo.routeLater(row)).owner)
        log.warn(`PR event ${event.key} skipped: ${row.repo}#${row.number} has no owner`);
    }
    for (const row of await repo.pendingEventsLater()) {
      const event = planCodingPrEvent(row);
      const owner = (await repo.routeLater(row)).owner;
      if (!owner) continue;
      const told = event ? await deps.tell(owner, event.key, event.text).catch(() => false) : true;
      if (told) await repo.acceptEvent(row, owner);
      if (!event) continue;
      log.warn(
        `PR event ${event.key} to ${owner.adapter}:${owner.id}: ${told ? 'told' : 'not told'}`
      );
    }
  });
}
