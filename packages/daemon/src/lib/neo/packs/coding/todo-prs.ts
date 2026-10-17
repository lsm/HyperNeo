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
import { createCodingPackTables } from './schema/coding-tables.ts';
import { extractNeoWorkPrUrls, type NeoWorkPrReader } from './work-prs.ts';

export type CodingPrClaim = 'named' | 'reported' | 'branch';

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
      'INSERT OR IGNORE INTO pack_coding_pr_claims (todo_id, url, claim, claimed_at) VALUES (?, ?, ?, ?)'
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

  record(todoId: string, prs: readonly NeoWorkPr[], now: number): void {
    this.db
      .prepare(
        `INSERT INTO pack_coding_todo_prs (todo_id, prs_json, read_at) VALUES (?, ?, ?)
         ON CONFLICT(todo_id) DO UPDATE SET prs_json = excluded.prs_json, read_at = excluded.read_at`
      )
      .run(todoId, JSON.stringify(prs), now);
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

const prNumber = (pr: NeoWorkPr) => `#${pr.url.replace(/\/+$/, '').split('/').pop()}`;

export function codingTodoCheck(
  kind: string,
  prs: readonly NeoWorkPr[]
): NeoTodoCheckResult | null {
  const merged = prs.filter((pr) => pr.state === 'MERGED');
  if (kind === 'pr_merged')
    return prs.length && merged.length === prs.length
      ? { done: true, evidence: `${merged.map(prNumber).join(' ')} 已合并` }
      : { done: false, evidence: null };
  if (kind === 'pr_opened') {
    const opened = prs.filter((pr) => pr.state !== 'CLOSED');
    return opened.length
      ? { done: true, evidence: `${opened.map(prNumber).join(' ')} 已开出` }
      : { done: false, evidence: null };
  }
  return null;
}

const PR_LINES = {
  done: '已合并',
  failed: '',
  waiting: '开着，等 CI',
  ready: '已批准，等合并',
  pending: '开着，等 review',
} as const;

function prLine(pr: NeoWorkPr): string {
  if (pr.state === 'CLOSED') return `${prNumber(pr)} 已关闭`;
  if (pr.state === 'OPEN' && pr.checks === 'failing') return `${prNumber(pr)} CI 没过`;
  if (pr.state === 'OPEN' && pr.review === 'changes_requested') return `${prNumber(pr)} 要改`;
  return `${prNumber(pr)} ${PR_LINES[neoWorkPrVerdict(pr)]}`;
}

export function codingTodoStatusLine(
  todo: Pick<NeoTodo, 'state' | 'report' | 'evidence'>,
  prs: readonly NeoWorkPr[]
): string | null {
  if (prs.length) return prs.map(prLine).join('，');
  return todo.state === 'done' && todo.report && !todo.evidence ? '会话说做完了，没查到 PR' : null;
}

export function createCodingTodoPack(
  repo: CodingTodoPrRepository,
  readPrs: NeoWorkPrReader
): NeoTodoPack {
  return {
    schema: createCodingPackTables,
    openedPrs: (todo, urls) =>
      repo.claim(
        todo.id,
        [
          ...planCodingTodoClaims(todo, todo.report, []),
          ...urls.map((url) => ({ url, claim: 'branch' as const })),
        ],
        Date.now()
      ),
    check: async (todo) => {
      if (todo.check?.pack !== 'coding') return null;
      repo.claim(todo.id, planCodingTodoClaims(todo, todo.report, []), Date.now());
      const urls = repo.urls(todo.id);
      if (!urls.length) return codingTodoCheck(todo.check.kind, []);
      const prs = await readPrs(urls);
      if (!prs || urls.some((url) => !prs.some((pr) => codingPrKey(pr.url) === url))) return null;
      repo.record(todo.id, prs, Date.now());
      return codingTodoCheck(todo.check.kind, prs);
    },
    statusLine: (todo) => codingTodoStatusLine(todo, repo.prs(todo.id)),
    topics: (todo) =>
      repo.urls(todo.id).flatMap((url) => {
        const parsed = parsePrUrl(url);
        return parsed ? [buildPrEventTopicPattern(parsed)] : [];
      }),
    event: (event: ExternalEvent) => {
      const url = pullRequestUrlOfTopic(event.topic);
      return url ? repo.todosFor([url]) : [];
    },
  };
}
