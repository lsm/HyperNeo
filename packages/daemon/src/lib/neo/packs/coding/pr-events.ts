import { readCodingUnownedClaims } from './unowned-claims-worker.ts';
import { codingPrEventReads } from './pr-event-routing-db.ts';
import { codingRepoWatched } from './watched-repos.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import { Logger } from '../../../logger.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { callCodingBranchDb } from './branch-facts-db.ts';
import {
  codingLedgerPrUrl,
  CodingPrLedgerRepository,
  type CodingPrTransition,
  planCodingLedgerTurnOwner,
} from './pr-ledger.ts';
import {
  CODING_MANUAL_MERGE_NEXT_STEP,
  codingDeliveryKey,
  codingFailingReviewKey,
  codingFailingReviewReceiptKey,
  codingFailingText,
  CodingPrSweepRepository,
  codingReviewKey,
  codingPrUrl,
  type CodingSweepDeps,
} from './pr-sweep.ts';
import {
  codingPrMayBeInRunningTurn,
  planCodingUnclaimedPrs,
  type CodingUnownedPr,
} from './pr-unowned.ts';
import { CodingTurnPrRepository } from './turn-prs.ts';

const log = new Logger('NeoPrSweep');

const head = (row: CodingPrTransition) => row.head.slice(0, 7);
const pr = (row: CodingPrTransition) => `${row.repo}#${row.number} "${row.title}"`;

export function planCodingPrEvent(
  row: CodingPrTransition
): { key: string; text: string; findings?: string[] } | null {
  const findings = ['changes_requested', 'failing'].includes(row.state) ? (row.findings ?? []) : [];
  const owner = (text: string) => ({
    key:
      row.state === 'failing' && findings.length
        ? codingFailingReviewKey({ ...row, findings })
        : codingDeliveryKey(
            `neo-pr-event:${row.repo}#${row.number}:${row.head}:${row.state}${codingReviewKey(findings)}`
          ),
    text: `${pr(row)} ${text}`,
    ...(findings.length ? { findings } : {}),
  });
  if (row.state === 'merged') return owner(`was merged on head ${head(row)}.`);
  if (row.state === 'closed') return owner(`was closed without merging on head ${head(row)}.`);
  if (row.state === 'failing')
    return {
      ...owner(`has failing CI on head ${head(row)}. Fix it and push.`),
      text: codingFailingText(row),
    };
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

  reviewSent(key: string): Promise<boolean> {
    return new CodingPrSweepRepository(this.db).reviewSentLater(key);
  }

  markReview(key: string): Promise<void> {
    return new CodingPrSweepRepository(this.db).markReviewLater(key);
  }

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

  private unclaimed<Row extends CodingUnownedPr>(rows: readonly Row[]) {
    try {
      return planCodingUnclaimedPrs(rows, readCodingUnownedClaims(this.db, rows));
    } catch (error) {
      log.warn('Unowned PR claim recheck unavailable', error);
      return [...rows];
    }
  }

  unowned(now: number) {
    const rows = this.db
      .prepare(
        `SELECT l.repo, l.number, l.title, l.created_at AS createdAt FROM pack_coding_pr_ledger l
           JOIN pack_coding_pr_unowned_state s ON s.id = 1
          WHERE l.owner IS NULL AND l.closed_at IS NULL AND l.state NOT IN ('draft', 'merged', 'closed')
            AND l.author_is_bot = 0 AND l.created_at > s.activated_at AND l.read_at = ?
          ORDER BY l.repo, l.number`
      )
      .all(now) as (CodingUnownedPr & { createdAt: number })[];
    const watched = this.unclaimed(rows.filter((row) => codingRepoWatched(this.db, row.repo)));
    const reads = new CodingTurnPrRepository(this.db);
    const mentions = reads.mentions(watched.map(codingLedgerPrUrl));
    const lastTurnEnds = reads.lastTurnEndsOfRunningWorkers();
    return watched.filter(
      (row) =>
        !codingPrMayBeInRunningTurn(row.createdAt, lastTurnEnds) &&
        planCodingLedgerTurnOwner(row, mentions).state === 'none'
    );
  }

  unownedLater(now: number) {
    return callCodingBranchDb(
      () => gatewayFor(this.db).call(codingPrEventReads, 'unowned', now),
      'coding.unowned.db'
    );
  }

  route(row: Pick<CodingPrTransition, 'repo' | 'number'>) {
    const found = this.db
      .prepare(
        `SELECT owner
           FROM pack_coding_pr_ledger l WHERE l.repo = ? AND l.number = ?`
      )
      .get(row.repo, row.number) as { owner: string | null } | null;
    return {
      mergeBy: new CodingPrLedgerRepository(this.db).policy(row.repo).mergeBy,
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
      const { owner, mergeBy } = await repo.routeLater(row);
      if (row.state === 'approved_green' && mergeBy === 'daemon') {
        if (owner) await repo.acceptEvent(row, owner);
        continue;
      }
      if (!owner) continue;
      const review =
        row.state === 'merged' || (row.state === 'failing' && !!event?.findings?.length);
      const receipt = event && review ? codingFailingReviewReceiptKey(event.key, owner) : null;
      const told = event
        ? (receipt !== null && (await repo.reviewSent(receipt))) ||
          (await deps
            .tell(owner, event.key, event.text, codingPrUrl(deps.host, row), event.findings)
            .catch(() => false))
        : true;
      if (told && receipt !== null) await repo.markReview(receipt);
      if (told) await repo.acceptEvent(row, owner);
      if (!event) continue;
      log.warn(
        `PR event ${event.key} to ${owner.adapter}:${owner.id}: ${told === 'gone' ? 'owner gone, dropped' : told ? 'told' : 'not told'}`
      );
    }
  });
}
