import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoWorkPrVerdict, type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { ExternalEvent } from '../../../external-events/types.ts';
import {
  buildPrEventTopicPattern,
  githubUrlKey,
  parsePrUrl,
  pullRequestUrlOfTopic,
} from '../../../github/parse-pr-url.ts';
import type { NeoTodoCheckResult, NeoTodoPack } from '../types.ts';
import { neoStatusLine, type NeoStatusLine } from '../../status-codes.ts';
import { CODING_TODO_PR_REFS, createCodingPackTables } from './schema/coding-tables.ts';
import { extractNeoWorkPrUrls, type NeoWorkPrReader } from './work-prs.ts';

export type CodingPrClaim = 'named' | 'reported' | 'branch';
export type CodingPrClaimRow = {
  todoId: string;
  url: string;
  claim: CodingPrClaim;
  claimedAt: number;
};
export type CodingTodoWindow = { start: number | null; end: number | null };

export function codingPrKey(url: string): string | null {
  const parsed = parsePrUrl(url);
  return parsed
    ? githubUrlKey(`https://${parsed.host}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`)
    : null;
}

export class CodingTodoPrRepository {
  constructor(private readonly db: Database) {}

  claim(todoId: string, claims: readonly { url: string; claim: CodingPrClaim }[], now: number) {
    const keyed = claims.flatMap(({ url, claim }) => {
      const key = codingPrKey(url);
      return key ? [{ key, claim }] : [];
    });
    this.db
      .prepare(
        `DELETE FROM pack_coding_pr_claims WHERE todo_id = ? AND claim = 'reported'
           AND url NOT IN (SELECT value FROM json_each(?))`
      )
      .run(
        todoId,
        JSON.stringify(keyed.filter((item) => item.claim === 'reported').map((item) => item.key))
      );
    const insert = this.db.prepare(
      `INSERT INTO pack_coding_pr_claims (todo_id, url, claim, claimed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(todo_id, url) DO UPDATE SET claim = excluded.claim, claimed_at = excluded.claimed_at
        WHERE (claim = 'branch' AND excluded.claim != 'branch')
           OR (claim = 'reported' AND excluded.claim = 'named')`
    );
    for (const { key, claim } of keyed) insert.run(todoId, key, claim, now);
  }

  urls(todoId: string): string[] {
    return (
      this.db
        .prepare('SELECT url FROM pack_coding_pr_claims WHERE todo_id = ? ORDER BY claimed_at, url')
        .all(todoId) as { url: string }[]
    ).map((row) => row.url);
  }

  claimsOn(urls: readonly string[]): CodingPrClaimRow[] {
    return this.db
      .prepare(
        `SELECT todo_id AS todoId, url, claim, claimed_at AS claimedAt FROM pack_coding_pr_claims
          WHERE url IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(urls)) as CodingPrClaimRow[];
  }

  window(todoId: string): CodingTodoWindow {
    const row = this.db
      .prepare(
        `SELECT t.started_at AS start,
                (SELECT MIN(next.started_at) FROM neo_todo_sessions other
                   JOIN neo_todos next ON next.id = other.todo_id
                  WHERE other.ref = own.ref AND other.todo_id != t.id
                    AND next.started_at > t.started_at) AS end
           FROM neo_todos t LEFT JOIN neo_todo_sessions own ON own.todo_id = t.id
          WHERE t.id = ?`
      )
      .get(todoId) as CodingTodoWindow | null;
    return row ?? { start: null, end: null };
  }

  todosFor(urls: readonly string[]): string[] {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT todo_id AS todoId FROM pack_coding_pr_claims WHERE url IN (SELECT value FROM json_each(?))'
        )
        .all(JSON.stringify(urls.flatMap((url) => codingPrKey(url) ?? []))) as {
        todoId: string;
      }[]
    ).map((row) => row.todoId);
  }

  prs(todoId: string): NeoWorkPr[] {
    const row = this.db
      .prepare('SELECT prs_json AS prs FROM pack_coding_todo_prs WHERE todo_id = ?')
      .get(todoId) as { prs: string } | null;
    return row ? (JSON.parse(row.prs) as NeoWorkPr[]) : [];
  }

  latest(url: string): { pr: NeoWorkPr; readAt: number } | null {
    const key = codingPrKey(url);
    const rows = this.db
      .prepare(
        `SELECT prs_json AS prs, read_at AS readAt FROM pack_coding_todo_prs WHERE todo_id IN
           (SELECT todo_id FROM pack_coding_pr_claims WHERE url = ?) ORDER BY read_at DESC`
      )
      .all(key) as { prs: string; readAt: number }[];
    for (const row of rows) {
      const pr = (JSON.parse(row.prs) as NeoWorkPr[]).find((item) => codingPrKey(item.url) === key);
      if (pr) return { pr, readAt: row.readAt };
    }
    return null;
  }

  record(todoId: string, prs: readonly NeoWorkPr[], now: number): void {
    this.db
      .prepare(
        `INSERT INTO pack_coding_todo_prs (todo_id, prs_json, read_at) VALUES (?, ?, ?)
         ON CONFLICT(todo_id) DO UPDATE SET prs_json = excluded.prs_json, read_at = excluded.read_at`
      )
      .run(todoId, JSON.stringify(prs), now);
    this.db.prepare('DELETE FROM neo_todo_pr_refs WHERE todo_id = ?').run(todoId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO neo_todo_pr_refs (reference, number, todo_id) ${CODING_TODO_PR_REFS} AND r.todo_id = ?`
      )
      .run(todoId);
  }
}

export function planCodingTodoClaims(
  todo: Pick<NeoTodo, 'check' | 'startedAt'>,
  report: string | null,
  branchPrs: readonly NeoWorkPr[]
): { url: string; claim: CodingPrClaim }[] {
  const named = todo.check?.params.urls;
  return [
    ...(Array.isArray(named) ? named.filter((url) => typeof url === 'string') : []).map(
      (url: string) => ({ url, claim: 'named' as const })
    ),
    ...extractNeoWorkPrUrls(report).map((url) => ({ url, claim: 'reported' as const })),
    ...branchPrs
      .filter((pr) => todo.startedAt !== null && (pr.createdAt ?? 0) >= todo.startedAt)
      .map((pr) => ({ url: pr.url, claim: 'branch' as const })),
  ];
}

const CLAIM_RANK: Record<CodingPrClaim, number> = { named: 0, reported: 1, branch: 2 };

const outranks = (rival: CodingPrClaimRow, own: CodingPrClaimRow) =>
  CLAIM_RANK[rival.claim] < CLAIM_RANK[own.claim] ||
  (own.claim !== 'branch' &&
    rival.claim === own.claim &&
    (rival.claimedAt < own.claimedAt ||
      (rival.claimedAt === own.claimedAt && rival.todoId < own.todoId)));

const inWindow = (window: CodingTodoWindow, pr: NeoWorkPr) =>
  window.start !== null &&
  pr.createdAt !== undefined &&
  pr.createdAt >= window.start &&
  (window.end === null || pr.createdAt < window.end);

export function codingTodoOwnPrs(
  todo: Pick<NeoTodo, 'id' | 'startedAt'>,
  claims: readonly CodingPrClaimRow[],
  prs: readonly NeoWorkPr[],
  window: CodingTodoWindow
): NeoWorkPr[] {
  const mine = claims.filter(
    (row) =>
      row.todoId === todo.id &&
      !claims.some(
        (rival) => rival.todoId !== todo.id && rival.url === row.url && outranks(rival, row)
      )
  );
  const read = (row: CodingPrClaimRow) =>
    prs.filter((pr) => codingPrKey(pr.url) === row.url).slice(0, 1);
  const answered = mine
    .filter((row) => row.claim !== 'branch')
    .flatMap((row) =>
      read(row).filter(
        (pr) =>
          row.claim === 'named' ||
          todo.startedAt === null ||
          pr.mergedAt === undefined ||
          pr.mergedAt >= todo.startedAt
      )
    );
  if (answered.length) return answered;
  return mine
    .filter((row) => row.claim === 'branch')
    .flatMap(read)
    .filter((pr) => inWindow(window, pr))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(0, 1);
}

const prNumber = (pr: NeoWorkPr) => `#${pr.url.replace(/\/+$/, '').split('/').pop()}`;

export function codingTodoCheck(
  kind: string,
  prs: readonly NeoWorkPr[]
): NeoTodoCheckResult | null {
  const merged = prs.filter((pr) => pr.state === 'MERGED');
  if (kind === 'pr_merged')
    return prs.length && merged.length === prs.length
      ? { done: true, evidence: `${merged.map(prNumber).join(' ')} merged` }
      : { done: false, evidence: null };
  if (kind === 'pr_opened') {
    const opened = prs.filter((pr) => pr.state !== 'CLOSED');
    return opened.length
      ? { done: true, evidence: `${opened.map(prNumber).join(' ')} opened` }
      : { done: false, evidence: null };
  }
  return null;
}

const CODING_TODO_STATUS_EN = {
  'todo.pr.merged': '{pr} merged',
  'todo.pr.closed': '{pr} closed',
  'todo.pr.ciFailing': '{pr} CI failing',
  'todo.pr.changesRequested': '{pr} needs changes',
  'todo.pr.waitingCi': '{pr} open, waiting on CI',
  'todo.pr.approved': '{pr} approved, waiting to merge',
  'todo.pr.waitingReview': '{pr} open, waiting on review',
  'todo.reportedNoPr': 'Session says it is done; no PR found',
} as const;

const PR_CODES = {
  done: 'todo.pr.merged',
  failed: 'todo.pr.ciFailing',
  waiting: 'todo.pr.waitingCi',
  ready: 'todo.pr.approved',
  pending: 'todo.pr.waitingReview',
} as const;

function prCode(pr: NeoWorkPr): keyof typeof CODING_TODO_STATUS_EN {
  if (pr.state === 'CLOSED') return 'todo.pr.closed';
  if (pr.state === 'OPEN' && pr.checks === 'failing') return 'todo.pr.ciFailing';
  if (pr.state === 'OPEN' && pr.review === 'changes_requested') return 'todo.pr.changesRequested';
  return PR_CODES[neoWorkPrVerdict(pr)];
}

export function codingTodoStatusLine(
  todo: Pick<NeoTodo, 'state' | 'report' | 'evidence'>,
  prs: readonly NeoWorkPr[]
): NeoStatusLine | null {
  if (prs.length)
    return neoStatusLine(
      CODING_TODO_STATUS_EN,
      prs.map((pr) => ({ code: prCode(pr), params: { pr: prNumber(pr) } }))
    );
  return todo.state === 'done' && todo.report && !todo.evidence
    ? neoStatusLine(CODING_TODO_STATUS_EN, [{ code: 'todo.reportedNoPr', params: {} }])
    : null;
}

export function createCodingTodoPack(
  repo: CodingTodoPrRepository,
  readPrs: NeoWorkPrReader
): NeoTodoPack {
  const claimsOf = (todo: NeoTodo) => {
    const recorded = new Set(repo.prs(todo.id).flatMap((pr) => codingPrKey(pr.url) ?? []));
    return [
      ...planCodingTodoClaims(todo, todo.report, []),
      ...repo.claimsOn([...recorded]).filter((row) => row.todoId === todo.id),
    ];
  };
  return {
    schema: createCodingPackTables,
    openedPrs: (todo, urls) =>
      repo.claim(
        todo.id,
        [...claimsOf(todo), ...urls.map((url) => ({ url, claim: 'branch' as const }))],
        Date.now()
      ),
    check: async (todo) => {
      if (todo.check && todo.check.pack !== 'coding') return null;
      repo.claim(todo.id, claimsOf(todo), Date.now());
      const urls = repo.urls(todo.id);
      if (!urls.length) return todo.check ? codingTodoCheck(todo.check.kind, []) : null;
      const read = await readPrs(urls);
      if (!read || urls.some((url) => !read.some((pr) => codingPrKey(pr.url) === url))) return null;
      const prs = codingTodoOwnPrs(todo, repo.claimsOn(urls), read, repo.window(todo.id));
      repo.record(todo.id, prs, Date.now());
      return todo.check ? codingTodoCheck(todo.check.kind, prs) : null;
    },
    statusLine: (todo) => codingTodoStatusLine(todo, repo.prs(todo.id)),
    topics: (todo) =>
      repo.urls(todo.id).flatMap((url) => {
        const parsed = (repo.latest(url)?.pr.state ?? 'OPEN') === 'OPEN' ? parsePrUrl(url) : null;
        return parsed ? [buildPrEventTopicPattern(parsed)] : [];
      }),
    event: (event: ExternalEvent) => {
      const url = pullRequestUrlOfTopic(event.topic);
      return url ? repo.todosFor([url]) : [];
    },
  };
}
