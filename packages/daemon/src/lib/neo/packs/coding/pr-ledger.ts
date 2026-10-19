import { homedir } from 'node:os';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';

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

const Node = z.object({
  number: z.number().int(),
  title: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  mergeable: z.string(),
  reviewDecision: z.string().nullable(),
  closedAt: z.string().nullable(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }),
      })
    ),
  }),
});
type Node = z.infer<typeof Node>;

const Response = z.object({
  data: z.object({
    rateLimit: z.object({ remaining: z.number() }),
    repository: z.object({
      open: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(Node) }),
      done: z.object({ nodes: z.array(Node) }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

const FIELDS = `number title headRefName headRefOid state isDraft mergeable reviewDecision closedAt
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

export const CODING_LEDGER_QUERY = `query($o: String!, $n: String!) {
  rateLimit { remaining }
  repository(owner: $o, name: $n) {
    open: pullRequests(states: OPEN, first: 100) { pageInfo { hasNextPage } nodes { ${FIELDS} } }
    done: pullRequests(states: [MERGED, CLOSED], first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${FIELDS} } }
  }
}`;

export function codingPrState(pr: Node): CodingPrState {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING') return 'dirty';
  const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  if (ci === 'FAILURE' || ci === 'ERROR') return 'failing';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (pr.reviewDecision === 'APPROVED')
    return ci === null || ci === 'SUCCESS' ? 'approved_green' : 'approved_pending';
  return 'waiting_review';
}

export type CodingLedgerRow = {
  repo: string;
  number: number;
  title: string;
  branch: string;
  head: string;
  state: CodingPrState;
  closedAt: number | null;
};

export function planCodingLedgerRead(
  repo: string,
  raw: unknown,
  now: number
): { rows: CodingLedgerRow[]; remaining: number } | null {
  const parsed = Response.safeParse(raw);
  if (!parsed.success || parsed.data.errors?.length) return null;
  const { open, done } = parsed.data.data.repository;
  if (open.pageInfo.hasNextPage) return null;
  const rows = [...open.nodes, ...done.nodes]
    .map((pr) => ({
      repo,
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      head: pr.headRefOid,
      state: codingPrState(pr),
      closedAt: pr.closedAt ? Date.parse(pr.closedAt) : null,
    }))
    .filter((row) => row.closedAt === null || now - row.closedAt < CODING_LEDGER_KEEP_MS);
  return { rows, remaining: parsed.data.data.rateLimit.remaining };
}

export class CodingPrLedgerRepository {
  constructor(private readonly db: Database) {}

  upsert(rows: readonly CodingLedgerRow[], now: number): void {
    const insert = this.db.prepare(
      `INSERT INTO pack_coding_pr_ledger
         (repo, number, title, branch, head, state, state_since, closed_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, number) DO UPDATE SET
         title = excluded.title, branch = excluded.branch, closed_at = excluded.closed_at,
         read_at = excluded.read_at,
         nudges = CASE WHEN head = excluded.head AND state = excluded.state THEN nudges ELSE 0 END,
         state_since = CASE WHEN head = excluded.head AND state = excluded.state
           THEN state_since ELSE excluded.read_at END,
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
        now
      );
  }

  prune(now: number): void {
    this.db
      .prepare('DELETE FROM pack_coding_pr_ledger WHERE closed_at IS NOT NULL AND closed_at < ?')
      .run(now - CODING_LEDGER_KEEP_MS);
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
  return outcome.ok ? outcome.data : null;
};

export async function reconcileCodingPrLedger(
  ledger: CodingPrLedgerRepository,
  repos: readonly string[],
  read: CodingLedgerRead,
  now: number
): Promise<void> {
  for (const repo of repos) {
    const planned = planCodingLedgerRead(repo, await read(repo), now);
    if (planned) ledger.upsert(planned.rows, now);
    if (planned && planned.remaining < CODING_LEDGER_MIN_RATE) break;
  }
  ledger.prune(now);
}
