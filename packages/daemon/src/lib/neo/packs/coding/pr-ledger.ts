import { getNeoPackPreference } from '../preferences.ts';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { Logger } from '../../../logger.ts';
import { isRateLimitError } from '../../../session/rate-limit-detector.ts';
import type { NeoSessionFacts } from '../../pack-contract.ts';
import { codingPrKey } from './todo-prs.ts';
import type { CodingLedgerRead } from './pr-ledger-source.ts';

export {
  codingLedgerArgs,
  readCodingLedgerRepo,
  type CodingLedgerRead,
} from './pr-ledger-source.ts';

export type CodingPrState =
  | 'draft'
  | 'waiting_review'
  | 'unreviewed'
  | 'waiting_ci'
  | 'waiting_human'
  | 'changes_requested'
  | 'failing'
  | 'dirty'
  | 'approved_pending'
  | 'approved_green'
  | 'merged'
  | 'closed';

export const CODING_LEDGER_MIN_RATE = 500;
export const CODING_LEDGER_KEEP_MS = 7 * 24 * 60 * 60_000;
export const CODING_LEDGER_WARN_SKIPS = 3;
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
        z.object({
          state: z.string(),
          commit: z.object({ oid: z.string() }).nullable(),
          author: z.object({ login: z.string() }).nullable().optional(),
        })
      ),
    })
    .default({ nodes: [] }),
  closedAt: z.string().nullable(),
  createdAt: z.string().nullable().default(null),
  author: z
    .object({ login: z.string(), __typename: z.string().optional() })
    .nullable()
    .default(null),
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
            statusCheckRollup: z.object({ state: z.string() }).nullable(),
            checkSuites: z.object({ totalCount: z.number() }).optional(),
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

export function codingPrReplyAt(pr: Node): number | null {
  const by = pr.author?.login;
  const times = [
    ...pr.comments.nodes.map((item) => ({ login: item.author?.login, at: item.createdAt })),
    ...pr.replies.nodes.map((item) => ({ login: item.author?.login, at: item.submittedAt })),
  ].flatMap((item) => (by && item.login === by && item.at ? [Date.parse(item.at)] : []));
  return times.length ? Math.max(...times) : null;
}

export interface CodingMergePolicy {
  mergePolicy?: 'review_bot' | 'ci_only' | 'human';
  reviewBot?: string;
  humanSignoff?: readonly string[];
}

export function codingPrState(
  pr: Node,
  repoHasCi = false,
  policy: CodingMergePolicy = {}
): CodingPrState {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING') return 'dirty';
  const head = pr.commits.nodes[0]?.commit;
  const ci = head?.statusCheckRollup?.state ?? null;
  const noCi = ci === null && !repoHasCi && (head?.checkSuites?.totalCount ?? 0) === 0;
  if (ci === 'FAILURE' || ci === 'ERROR') return 'failing';
  const review =
    pr.reviews.nodes.filter((item) => item.commit?.oid === pr.headRefOid).at(-1)?.state ??
    pr.reviewDecision;
  if (review === 'CHANGES_REQUESTED') return 'changes_requested';
  if (!policy.mergePolicy) return 'waiting_human';
  const readyCi = noCi || ci === 'SUCCESS';
  if (policy.mergePolicy === 'human' || (policy.mergePolicy === 'review_bot' && !policy.reviewBot))
    return readyCi ? 'waiting_human' : 'waiting_ci';
  if (policy.mergePolicy === 'review_bot') {
    const bot = pr.reviews.nodes
      .filter(
        (item) =>
          item.commit?.oid === pr.headRefOid &&
          item.author?.login.toLowerCase() === policy.reviewBot!.toLowerCase()
      )
      .at(-1);
    if (bot?.state !== 'APPROVED') return 'waiting_review';
    if (policy.humanSignoff?.length) return 'waiting_human';
    return readyCi ? 'approved_green' : 'approved_pending';
  }
  return readyCi
    ? policy.humanSignoff?.length
      ? 'waiting_human'
      : 'approved_green'
    : 'waiting_ci';
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
  createdAt?: number | null;
  authorIsBot?: boolean;
};

export function planCodingLedgerRead(
  raw: unknown,
  now: number,
  readPolicy: (repo: string) => CodingMergePolicy = () => ({})
): { repo: string; rows: CodingLedgerRow[]; remaining: number } | null {
  const parsed = Response.safeParse(raw);
  if (!parsed.success || parsed.data.errors?.length) return null;
  const { open, done, nameWithOwner } = parsed.data.data.repository;
  if (open.pageInfo.hasNextPage) return null;
  const canonical = nameWithOwner.toLowerCase();
  const repoHasCi = open.nodes.some(
    (pr) =>
      !!pr.commits.nodes[0]?.commit.statusCheckRollup ||
      (pr.commits.nodes[0]?.commit.checkSuites?.totalCount ?? 0) > 0
  );
  const policy = readPolicy(canonical);
  const rows = [...open.nodes, ...done.nodes]
    .map((pr) => ({
      repo: canonical,
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      head: pr.headRefOid,
      state: codingPrState(pr, repoHasCi, policy),
      ci: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      replyAt: codingPrReplyAt(pr),
      closedAt: pr.closedAt ? Date.parse(pr.closedAt) : null,
      createdAt: pr.createdAt ? Date.parse(pr.createdAt) : null,
      authorIsBot: pr.author?.__typename !== 'User',
    }))
    .filter((row) => row.closedAt === null || now - row.closedAt < CODING_LEDGER_KEEP_MS);
  return { repo: canonical, rows, remaining: parsed.data.data.rateLimit.remaining };
}

type CodingSessionLinks = {
  ref: string;
  repos: string[];
  branches: string[];
  owned: string[];
  prs: string[];
  dismissed: string[];
  sidebar?: boolean;
};

export function codingRemoteRepo(remote: string): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/*$/i.exec(remote.trim());
  return match ? match[1].toLowerCase() : null;
}

export function planCodingPrOwner(
  row: { repo: string; number: number; branch: string; owner: string | null },
  claims: ReadonlyMap<string, string>,
  sessions: readonly CodingSessionLinks[]
): string | null {
  const url = `https://github.com/${row.repo.toLowerCase()}/pull/${row.number}`;
  const claim = claims.get(url);
  if (claim) return claim;
  const owned = sessions.filter((session) => session.owned.includes(url));
  const linked = sessions.filter(
    (session) =>
      session.prs.includes(url) &&
      (session.sidebar === false ||
        (JSON.parse(session.ref) as { adapter: string }).adapter !== 'claude-desktop')
  );
  const branched = sessions.filter(
    (session) =>
      !session.dismissed.includes(url) &&
      session.repos.includes(row.repo.toLowerCase()) &&
      session.branches.includes(row.branch)
  );
  const candidates = [owned, linked, branched].find((tier) => tier.length) ?? [];
  if (candidates.some((session) => session.ref === row.owner)) return row.owner;
  if (candidates.length) return candidates[0].ref;
  return sessions.some((session) => session.ref === row.owner) ? null : row.owner;
}

type CodingLedgerSnapshotRow = {
  repo: string;
  number: number;
  title: string;
  state: CodingPrState;
  since: number;
  owner: string | null;
};

function codingLedgerSnapshotRow(row: CodingLedgerSnapshotRow) {
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
}

export class CodingPrLedgerRepository {
  constructor(private readonly db: Database) {}

  policy(repo: string): CodingMergePolicy {
    const read = (key: string) => {
      const scope = this.db
        .prepare(`SELECT scope_key FROM neo_pack_preferences
        WHERE pack = 'coding' AND scope_kind = 'repo' AND scope_key = ? COLLATE NOCASE AND key = ?`)
        .get(repo, key) as { scope_key: string } | undefined;
      return getNeoPackPreference(
        this.db,
        'coding',
        { kind: 'repo', key: scope?.scope_key ?? repo },
        key
      )?.value;
    };
    return {
      mergePolicy: read('mergePolicy') as CodingMergePolicy['mergePolicy'],
      reviewBot: read('reviewBot') as string | undefined,
      humanSignoff: read('humanSignoff') as string[] | undefined,
    };
  }

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
         (repo, number, title, branch, head, state, state_since, closed_at, read_at, reply_at, created_at, author_is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         created_at = excluded.created_at, author_is_bot = excluded.author_is_bot,
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
        row.replyAt ?? null,
        row.createdAt ?? null,
        row.authorIsBot === false ? 0 : 1
      );
  }

  observeSessions(sessions: readonly NeoSessionFacts[], now: number): void {
    const upsert = this.db.prepare(
      `INSERT INTO pack_coding_session_facts
         (ref, repos, branches, linked, linked_window, owned, opened, dismissed, active_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         repos = (SELECT json_group_array(DISTINCT value) FROM
           (SELECT value FROM json_each(repos) UNION SELECT value FROM json_each(excluded.repos))),
         branches = (SELECT json_group_array(DISTINCT value) FROM
           (SELECT value FROM json_each(branches) UNION SELECT value FROM json_each(excluded.branches))),
         opened = (SELECT json_group_array(DISTINCT value) FROM
           (SELECT value FROM json_each(opened) UNION SELECT value FROM json_each(excluded.opened))),
         linked = CASE WHEN excluded.linked_window AND linked IS NOT NULL THEN
           (SELECT json_group_array(DISTINCT value) FROM
             (SELECT value FROM json_each(linked) UNION SELECT value FROM json_each(excluded.linked))
            WHERE value NOT IN (SELECT value FROM json_each(excluded.dismissed)))
           ELSE excluded.linked END,
         owned = (SELECT json_group_array(DISTINCT value) FROM
             (SELECT value FROM json_each(owned) UNION SELECT value FROM json_each(excluded.owned))
            WHERE value NOT IN (SELECT value FROM json_each(excluded.dismissed))),
         linked_window = excluded.linked_window, dismissed = excluded.dismissed,
         active_at = excluded.active_at, seen_at = excluded.seen_at`
    );
    const keys = (urls: readonly string[]) => urls.flatMap((url) => codingPrKey(url) ?? []);
    for (const session of sessions)
      upsert.run(
        JSON.stringify(session.ref),
        JSON.stringify(session.remotes.flatMap((remote) => codingRemoteRepo(remote) ?? [])),
        JSON.stringify(session.branches),
        session.linkedPrs
          ? JSON.stringify(
              keys(session.linkedPrs.filter((pr) => !pr.dismissed).map((pr) => pr.url))
            )
          : null,
        session.linkedPrsWindow ? 1 : 0,
        JSON.stringify(
          keys(
            (session.linkedPrs ?? []).filter((pr) => pr.own && !pr.dismissed).map((pr) => pr.url)
          )
        ),
        JSON.stringify(keys(session.openedPrs)),
        JSON.stringify(
          keys((session.linkedPrs ?? []).filter((pr) => pr.dismissed).map((pr) => pr.url))
        ),
        session.lastActivityAt,
        now
      );
    this.assignOwners();
  }

  assignOwners(): void {
    const claims = new Map(
      (
        this.db
          .prepare(
            `SELECT c.url, s.ref FROM pack_coding_pr_claims c
               JOIN neo_todo_sessions s ON s.todo_id = c.todo_id
               JOIN neo_todos t ON t.id = c.todo_id
              WHERE s.ref IS NOT NULL
              ORDER BY t.state IN ('todo', 'doing'), COALESCE(t.started_at, 0)`
          )
          .all() as { url: string; ref: string }[]
      ).map((row) => [row.url, row.ref])
    );
    const sessions = (
      this.db
        .prepare(
          `SELECT ref, repos, branches, linked, owned, opened, dismissed FROM pack_coding_session_facts
            ORDER BY active_at DESC`
        )
        .all() as (Record<
        'ref' | 'repos' | 'branches' | 'owned' | 'opened' | 'dismissed',
        string
      > & {
        linked: string | null;
      })[]
    ).map((row) => ({
      ref: row.ref,
      repos: JSON.parse(row.repos) as string[],
      branches: JSON.parse(row.branches) as string[],
      owned: JSON.parse(row.owned) as string[],
      prs: JSON.parse(row.linked ?? row.opened) as string[],
      sidebar: row.linked !== null,
      dismissed: JSON.parse(row.dismissed) as string[],
    }));
    const rows = this.db
      .prepare('SELECT repo, number, branch, owner FROM pack_coding_pr_ledger')
      .all() as { repo: string; number: number; branch: string; owner: string | null }[];
    const update = this.db.prepare(
      'UPDATE pack_coding_pr_ledger SET owner = ? WHERE repo = ? AND number = ?'
    );
    for (const row of rows) {
      const owner = planCodingPrOwner(row, claims, sessions);
      if (owner !== row.owner) update.run(owner, row.repo, row.number);
    }
  }

  pruneSessions(now: number): void {
    this.db
      .prepare('DELETE FROM pack_coding_session_facts WHERE seen_at < ?')
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

  stateOf(url: string): CodingPrState | null {
    const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url);
    if (!match) return null;
    const row = this.db
      .prepare('SELECT state FROM pack_coding_pr_ledger WHERE repo = ? AND number = ?')
      .get(match[1].toLowerCase(), Number(match[2])) as { state: CodingPrState } | null;
    return row?.state ?? null;
  }

  recordAlias(alias: string, canonical: string): void {
    this.db
      .prepare(
        `INSERT INTO pack_coding_repo_aliases (alias, canonical) VALUES (?, ?)
         ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical`
      )
      .run(alias, canonical);
  }

  dropRepo(repo: string): void {
    this.db.prepare('DELETE FROM pack_coding_pr_ledger WHERE repo = ?').run(repo);
  }

  snapshot(
    repos: readonly string[] | null,
    now: number,
    pinned: readonly { todoId: string; url: string; state: string | null }[] = []
  ): Record<string, string | number | null>[] {
    const select =
      'SELECT repo, number, title, state, state_since AS since, owner FROM pack_coding_pr_ledger';
    const own = pinned.flatMap((claim) => {
      const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(claim.url);
      if (!match) return [];
      const repo = match[1].toLowerCase();
      const row = this.db
        .prepare(
          `${select} WHERE number = ?2 AND (repo = ?1
            OR repo IN (SELECT canonical FROM pack_coding_repo_aliases WHERE alias = ?1))`
        )
        .get(repo, Number(match[2])) as CodingLedgerSnapshotRow | null;
      return [
        {
          todoId: claim.todoId,
          ...(row
            ? codingLedgerSnapshotRow(row)
            : {
                pr: `${repo}#${match[2]}`,
                title: null,
                state: claim.state?.toLowerCase() ?? null,
                since: null,
                ownerAdapter: null,
                ownerId: null,
                ownerDaemon: null,
              }),
        },
      ];
    });
    const owned = new Set(own.map((row) => row.pr));
    const rows = this.db
      .prepare(
        `${select}
          WHERE (closed_at IS NULL OR closed_at > ?)
            AND (? IS NULL OR repo IN (SELECT value FROM json_each(?))
              OR repo IN (SELECT canonical FROM pack_coding_repo_aliases
                           WHERE alias IN (SELECT value FROM json_each(?))))
          ORDER BY state_since LIMIT 100`
      )
      .all(
        now - CODING_LEDGER_SNAPSHOT_CLOSED_MS,
        repos ? 1 : null,
        JSON.stringify(repos ?? []),
        JSON.stringify(repos ?? [])
      ) as CodingLedgerSnapshotRow[];
    return [...own, ...rows.map(codingLedgerSnapshotRow).filter((row) => !owned.has(row.pr))];
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
    const planned = planCodingLedgerRead(raw, now, (canonical) => ledger.policy(canonical));
    const error = (raw as { error?: unknown } | null)?.error;
    const skipped = planned ? 0 : (skips.get(repo) ?? 0) + 1;
    skips.set(repo, skipped);
    if (skipped === CODING_LEDGER_WARN_SKIPS)
      log.warn(
        `PR ledger read for ${repo} failed or was partial ${skipped} times in a row${typeof error === 'string' ? `: ${error.slice(0, 200)}` : ''}`
      );
    if (typeof error === 'string' && isRateLimitError(error)) break;
    if (planned) ledger.recordAlias(repo.toLowerCase(), planned.repo);
    if (planned && planned.repo !== repo.toLowerCase()) ledger.dropRepo(repo.toLowerCase());
    if (planned && !seen.has(planned.repo))
      transitions.push(...ledger.replace(planned.repo, planned.rows, now));
    if (planned) seen.add(planned.repo);
    if (planned && planned.remaining < CODING_LEDGER_MIN_RATE) break;
  }
  ledger.prune([...repos, ...seen], now);
  ledger.pruneSessions(now);
  ledger.assignOwners();
  return transitions;
}
