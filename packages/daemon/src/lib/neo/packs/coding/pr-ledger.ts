import { homedir } from 'node:os';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';
import { isRateLimitError } from '../../../session/rate-limit-detector.ts';
import { codingPrKey } from './todo-prs.ts';

export type CodingPrState =
  | 'draft'
  | 'waiting_review'
  | 'changes_requested'
  | 'failing'
  | 'dirty'
  | 'approved_pending'
  | 'approved_green'
  | 'merged'
  | 'closed';

export type CodingLedgerRead = (repo: string) => Promise<unknown | null>;

export const CODING_LEDGER_MIN_RATE = 500;
export const CODING_LEDGER_KEEP_MS = 7 * 24 * 60 * 60_000;
export const CODING_LEDGER_WARN_SKIPS = 3;
export const CODING_LEDGER_CI_GRACE_MS = 10 * 60_000;
export const CODING_LEDGER_SNAPSHOT_CLOSED_MS = 24 * 60 * 60_000;

const log = new Logger('NeoCodingLedger');

const Node = z.object({
  number: z.number().int(),
  title: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  mergeable: z.string(),
  reviewDecision: z.string().nullable(),
  reviews: z
    .object({
      nodes: z.array(
        z.object({ state: z.string(), commit: z.object({ oid: z.string() }).nullable() })
      ),
    })
    .default({ nodes: [] }),
  closedAt: z.string().nullable(),
  author: z.object({ login: z.string() }).nullable().default(null),
  comments: z
    .object({
      nodes: z.array(
        z.object({ author: z.object({ login: z.string() }).nullable(), createdAt: z.string() })
      ),
    })
    .default({ nodes: [] }),
  replies: z
    .object({
      nodes: z.array(
        z.object({
          author: z.object({ login: z.string() }).nullable(),
          submittedAt: z.string().nullable(),
        })
      ),
    })
    .default({ nodes: [] }),
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z.object({
            committedDate: z.string().optional(),
            statusCheckRollup: z.object({ state: z.string() }).nullable(),
          }),
        })
      ),
    })
    .default({ nodes: [] }),
});
type Node = z.infer<typeof Node>;

const Response = z.object({
  data: z.object({
    rateLimit: z.object({ remaining: z.number() }),
    repository: z.object({
      nameWithOwner: z.string(),
      open: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(Node) }),
      done: z.object({ nodes: z.array(Node) }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

const DONE_FIELDS =
  'number title headRefName headRefOid state isDraft mergeable reviewDecision closedAt';

const FIELDS = `${DONE_FIELDS}
  reviews(last: 30, states: [APPROVED, CHANGES_REQUESTED]) { nodes { state commit { oid } } }
  author { login }
  comments(last: 10) { nodes { author { login } createdAt } }
  replies: reviews(last: 10, states: [COMMENTED]) { nodes { author { login } submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }`;

export const CODING_LEDGER_QUERY = `query($o: String!, $n: String!) {
  rateLimit { remaining }
  repository(owner: $o, name: $n) {
    nameWithOwner
    open: pullRequests(states: OPEN, first: 100) { pageInfo { hasNextPage } nodes { ${FIELDS} } }
    done: pullRequests(states: [MERGED, CLOSED], first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${DONE_FIELDS} } }
  }
}`;

export function codingPrReplyAt(pr: Node): number | null {
  const by = pr.author?.login;
  const times = [
    ...pr.comments.nodes.map((item) => ({ login: item.author?.login, at: item.createdAt })),
    ...pr.replies.nodes.map((item) => ({ login: item.author?.login, at: item.submittedAt })),
  ].flatMap((item) => (by && item.login === by && item.at ? [Date.parse(item.at)] : []));
  return times.length ? Math.max(...times) : null;
}

export function codingPrState(pr: Node, now = Date.now()): CodingPrState {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING') return 'dirty';
  const head = pr.commits.nodes[0]?.commit;
  const ci = head?.statusCheckRollup?.state ?? null;
  const settled =
    ci !== null ||
    !head?.committedDate ||
    now - Date.parse(head.committedDate) >= CODING_LEDGER_CI_GRACE_MS;
  if (ci === 'FAILURE' || ci === 'ERROR') return 'failing';
  const review =
    pr.reviews.nodes.filter((item) => item.commit?.oid === pr.headRefOid).at(-1)?.state ??
    pr.reviewDecision;
  if (review === 'CHANGES_REQUESTED') return 'changes_requested';
  if (review === 'APPROVED')
    return (ci === null && settled) || ci === 'SUCCESS' ? 'approved_green' : 'approved_pending';
  return 'waiting_review';
}

export type CodingPrTransition = CodingLedgerRow & { from: CodingPrState };

export type CodingLedgerRow = {
  repo: string;
  number: number;
  title: string;
  branch: string;
  head: string;
  state: CodingPrState;
  closedAt: number | null;
  ci?: string | null;
  replyAt?: number | null;
};

export function planCodingLedgerRead(
  raw: unknown,
  now: number
): { repo: string; rows: CodingLedgerRow[]; remaining: number } | null {
  const parsed = Response.safeParse(raw);
  if (!parsed.success || parsed.data.errors?.length) return null;
  const { open, done, nameWithOwner } = parsed.data.data.repository;
  if (open.pageInfo.hasNextPage) return null;
  const canonical = nameWithOwner.toLowerCase();
  const rows = [...open.nodes, ...done.nodes]
    .map((pr) => ({
      repo: canonical,
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      head: pr.headRefOid,
      state: codingPrState(pr, now),
      ci: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      replyAt: codingPrReplyAt(pr),
      closedAt: pr.closedAt ? Date.parse(pr.closedAt) : null,
    }))
    .filter((row) => row.closedAt === null || now - row.closedAt < CODING_LEDGER_KEEP_MS);
  return { repo: canonical, rows, remaining: parsed.data.data.rateLimit.remaining };
}

export class CodingPrLedgerRepository {
  constructor(private readonly db: Database) {}

  replace(repo: string, rows: readonly CodingLedgerRow[], now: number): CodingPrTransition[] {
    const before = new Map(
      (
        this.db
          .prepare('SELECT number, state FROM pack_coding_pr_ledger WHERE repo = ?')
          .all(repo) as { number: number; state: CodingPrState }[]
      ).map((row) => [row.number, row.state])
    );
    this.upsert(rows, now);
    this.db
      .prepare(
        `DELETE FROM pack_coding_pr_ledger WHERE repo = ? AND closed_at IS NULL
           AND number NOT IN (SELECT value FROM json_each(?))`
      )
      .run(repo, JSON.stringify(rows.map((row) => row.number)));
    return rows.flatMap((row) => {
      const from = before.get(row.number);
      return from && from !== row.state ? [{ ...row, from }] : [];
    });
  }

  private upsert(rows: readonly CodingLedgerRow[], now: number): void {
    const insert = this.db.prepare(
      `INSERT INTO pack_coding_pr_ledger
         (repo, number, title, branch, head, state, state_since, closed_at, read_at, reply_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, number) DO UPDATE SET
         title = excluded.title, branch = excluded.branch, closed_at = excluded.closed_at,
         read_at = excluded.read_at,
         nudges = CASE WHEN head = excluded.head AND state = excluded.state
             AND NOT (reply_at IS NOT NULL AND COALESCE(excluded.reply_at, 0) > reply_at)
           THEN nudges ELSE 0 END,
         state_since = CASE WHEN head <> excluded.head OR state <> excluded.state
             THEN excluded.read_at
           WHEN reply_at IS NOT NULL AND COALESCE(excluded.reply_at, 0) > reply_at
             THEN MAX(state_since, excluded.reply_at)
           ELSE state_since END,
         reply_at = COALESCE(excluded.reply_at, reply_at),
         head = excluded.head, state = excluded.state`
    );
    for (const row of rows)
      insert.run(
        row.repo,
        row.number,
        row.title,
        row.branch,
        row.head,
        row.state,
        now,
        row.closedAt,
        now,
        row.replyAt ?? null
      );
  }

  recordSessionPrs(links: readonly { ref: unknown; urls: readonly string[] }[], now: number): void {
    const insert = this.db.prepare(
      'INSERT INTO pack_coding_session_prs (url, ref, seen_at) VALUES (?, ?, ?) ON CONFLICT(url) DO NOTHING'
    );
    for (const link of links)
      for (const url of link.urls) {
        const key = codingPrKey(url);
        if (key?.startsWith('https://github.com/')) insert.run(key, JSON.stringify(link.ref), now);
      }
    this.db.exec(`UPDATE pack_coding_pr_ledger SET owner = (
        SELECT s.ref FROM pack_coding_session_prs s
         WHERE s.url = 'https://github.com/' || pack_coding_pr_ledger.repo || '/pull/'
                 || pack_coding_pr_ledger.number)
      WHERE owner IS NULL`);
  }

  pruneSessionPrs(now: number): void {
    this.db
      .prepare(
        `DELETE FROM pack_coding_session_prs WHERE seen_at < ? AND url NOT IN
           (SELECT 'https://github.com/' || repo || '/pull/' || number FROM pack_coding_pr_ledger)`
      )
      .run(now - CODING_LEDGER_KEEP_MS);
  }

  lastReads(): Map<string, number> {
    return new Map(
      (
        this.db
          .prepare('SELECT repo, MAX(read_at) AS readAt FROM pack_coding_pr_ledger GROUP BY repo')
          .all() as { repo: string; readAt: number }[]
      ).map((row) => [row.repo, row.readAt])
    );
  }

  dropRepo(repo: string): void {
    this.db.prepare('DELETE FROM pack_coding_pr_ledger WHERE repo = ?').run(repo);
  }

  linkOwners(): void {
    this.db.exec(`UPDATE pack_coding_pr_ledger SET owner = COALESCE((
        SELECT s.ref FROM pack_coding_pr_claims c
          JOIN neo_todo_sessions s ON s.todo_id = c.todo_id
          JOIN neo_todos t ON t.id = c.todo_id
         WHERE c.url = 'https://github.com/' || lower(pack_coding_pr_ledger.repo) || '/pull/'
                 || pack_coding_pr_ledger.number
           AND s.ref IS NOT NULL
         ORDER BY t.state IN ('todo', 'doing') DESC, COALESCE(t.started_at, 0) DESC
         LIMIT 1), owner)`);
  }

  snapshot(repos: readonly string[] | null, now: number): Record<string, string | number | null>[] {
    const rows = this.db
      .prepare(
        `SELECT repo, number, title, state, state_since AS since, owner FROM pack_coding_pr_ledger
          WHERE (closed_at IS NULL OR closed_at > ?)
            AND (? IS NULL OR repo IN (SELECT value FROM json_each(?)))
          ORDER BY state_since LIMIT 100`
      )
      .all(
        now - CODING_LEDGER_SNAPSHOT_CLOSED_MS,
        repos ? 1 : null,
        JSON.stringify(repos ?? [])
      ) as {
      repo: string;
      number: number;
      title: string;
      state: CodingPrState;
      since: number;
      owner: string | null;
    }[];
    return rows.map((row) => {
      const owner = row.owner
        ? (JSON.parse(row.owner) as { adapter: string; id: string; daemon?: string })
        : null;
      return {
        pr: `${row.repo}#${row.number}`,
        title: row.title.slice(0, 80),
        state: row.state,
        since: new Date(row.since).toISOString(),
        ownerAdapter: owner?.adapter ?? null,
        ownerId: owner?.id ?? null,
        ownerDaemon: owner?.daemon ?? null,
      };
    });
  }

  prune(repos: readonly string[], now: number): void {
    this.db
      .prepare(
        `DELETE FROM pack_coding_pr_ledger WHERE closed_at < ? OR read_at < ?
           OR repo NOT IN (SELECT value FROM json_each(?))`
      )
      .run(now - CODING_LEDGER_KEEP_MS, now - CODING_LEDGER_KEEP_MS, JSON.stringify(repos));
  }

  list(): (CodingLedgerRow & { stateSince: number; readAt: number })[] {
    return this.db
      .prepare(
        `SELECT repo, number, title, branch, head, state, closed_at AS closedAt,
                state_since AS stateSince, read_at AS readAt
           FROM pack_coding_pr_ledger ORDER BY repo, number`
      )
      .all() as (CodingLedgerRow & { stateSince: number; readAt: number })[];
  }
}

export function codingLedgerArgs(repo: string): string[] {
  const [owner, name] = repo.split('/');
  return [
    'gh',
    'api',
    'graphql',
    '-f',
    `query=${CODING_LEDGER_QUERY}`,
    '-f',
    `o=${owner}`,
    '-f',
    `n=${name}`,
  ];
}

export const readCodingLedgerRepo: CodingLedgerRead = async (repo) => {
  const outcome = await runGhJson(codingLedgerArgs(repo), homedir(), spawnProcess, {
    resourceHint: 'graphql',
  });
  return outcome.ok ? outcome.data : { error: outcome.error };
};

export async function reconcileCodingPrLedger(
  ledger: CodingPrLedgerRepository,
  repos: readonly string[],
  read: CodingLedgerRead,
  now: number,
  skips: Map<string, number> = new Map()
): Promise<CodingPrTransition[]> {
  const seen = new Set<string>();
  const transitions: CodingPrTransition[] = [];
  const last = ledger.lastReads();
  const order = [...repos].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0));
  for (const repo of order) {
    const raw = await read(repo);
    const planned = planCodingLedgerRead(raw, now);
    const error = (raw as { error?: unknown } | null)?.error;
    const skipped = planned ? 0 : (skips.get(repo) ?? 0) + 1;
    skips.set(repo, skipped);
    if (skipped === CODING_LEDGER_WARN_SKIPS)
      log.warn(
        `PR ledger read for ${repo} failed or was partial ${skipped} times in a row${typeof error === 'string' ? `: ${error.slice(0, 200)}` : ''}`
      );
    if (typeof error === 'string' && isRateLimitError(error)) break;
    if (planned && planned.repo !== repo.toLowerCase()) ledger.dropRepo(repo.toLowerCase());
    if (planned && !seen.has(planned.repo))
      transitions.push(...ledger.replace(planned.repo, planned.rows, now));
    if (planned) seen.add(planned.repo);
    if (planned && planned.remaining < CODING_LEDGER_MIN_RATE) break;
  }
  ledger.prune([...repos, ...seen], now);
  ledger.linkOwners();
  ledger.recordSessionPrs([], now);
  ledger.pruneSessionPrs(now);
  return transitions;
}
