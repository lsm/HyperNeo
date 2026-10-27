import { isRateLimitError } from '../../../session/rate-limit-detector.ts';
import { codingCanonicalRepo, codingRepoWatched, codingWatchedRepos } from './watched-repos.ts';
import { posix } from 'node:path';
import {
  CodingStageFactsRepository,
  codingReviewerPolicy,
  type CodingStageFact,
  type CodingActor,
} from './stage-facts.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { CodingPollFactsRepository } from './poll-facts.ts';
import {
  codingPendingDiagnostics,
  CodingRepoHealthRepository,
  type RepoHealthCycle,
} from './health-state.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { CodingAncestryFactsRepository } from './ancestry-facts.ts';
import { CodingRefFactsRepository } from './ref-facts.ts';
import { CodingQueryFactsRepository } from './query-facts.ts';
import { CodingWorkFactsRepository } from './work-facts.ts';
import { CodingBranchFactsRepository } from './branch-facts.ts';
import { CodingMergeFactsRepository } from './merge-facts.ts';
import { getNeoPackPreference } from '../../preferences.ts';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { Logger } from '../../../logger.ts';
import type { LedgerQuota } from './ledger-quota.ts';
import type { NeoSessionFacts } from '../../pack-contract.ts';
import { CodingTodoPrRepository, codingPrKey } from './todo-prs.ts';
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

export const Node = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().default(''),
  headRefName: z.string(),
  headRefOid: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  mergeable: z.string(),
  reviewDecision: z.string().nullable(),
  files: z
    .object({
      nodes: z.array(z.object({ path: z.string() })),
      pageInfo: z.object({ hasNextPage: z.boolean() }),
    })
    .nullish(),
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
    rateLimit: z.object({ remaining: z.number().nullable() }),
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
  provenance?: boolean;
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
  const humanSignoff =
    !!policy.humanSignoff?.length &&
    (!pr.files ||
      pr.files.pageInfo.hasNextPage ||
      policy.humanSignoff.some((pattern) => pattern.startsWith('label:')) ||
      pr.files.nodes.some((file) =>
        policy.humanSignoff!.some((pattern) => posix.matchesGlob(file.path, pattern))
      ));
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
    if (humanSignoff) return 'waiting_human';
    return readyCi ? 'approved_green' : 'approved_pending';
  }
  return readyCi ? (humanSignoff ? 'waiting_human' : 'approved_green') : 'waiting_ci';
}

export type CodingPrTransition = CodingLedgerRow & { from: CodingPrState };

export type CodingLedgerRow = {
  repo: string;
  number: number;
  title: string;
  body?: string;
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
): { repo: string; rows: CodingLedgerRow[]; remaining: number | null } | null {
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
      ...(pr.body ? { body: pr.body } : {}),
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
  opened?: string[];
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
  const opened = sessions.filter(
    (session) =>
      session.opened?.includes(url) &&
      !session.dismissed.includes(url) &&
      (session.sidebar === false ||
        (JSON.parse(session.ref) as { adapter: string }).adapter !== 'claude-desktop')
  );
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
  const candidates = [owned, opened, linked, branched].find((tier) => tier.length) ?? [];
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
  readAt: number;
  owner: string | null;
};

function codingLedgerSnapshotRow(
  row: CodingLedgerSnapshotRow,
  health?: ReturnType<CodingRepoHealthRepository['read']>
) {
  const owner = row.owner
    ? (JSON.parse(row.owner) as { adapter: string; id: string; daemon?: string })
    : null;
  return {
    pr: `${row.repo}#${row.number}`,
    title: row.title.slice(0, 80),
    state: row.state,
    ...(row.state === 'approved_pending' ? codingPendingDiagnostics(row.readAt, health) : {}),
    since: new Date(row.since).toISOString(),
    ownerAdapter: owner?.adapter ?? null,
    ownerId: owner?.id ?? null,
    ownerDaemon: owner?.daemon ?? null,
  };
}

export class CodingPrLedgerRepository {
  readonly health: CodingRepoHealthRepository;
  readonly stageFacts: CodingStageFactsRepository;
  readonly pollFacts: CodingPollFactsRepository;
  readonly mergeFacts: CodingMergeFactsRepository;
  readonly ancestryFacts: CodingAncestryFactsRepository;
  readonly branchFacts: CodingBranchFactsRepository;
  readonly refFacts: CodingRefFactsRepository;
  readonly workFacts: CodingWorkFactsRepository;
  readonly queryFacts: CodingQueryFactsRepository;

  constructor(private readonly db: Database) {
    this.health = new CodingRepoHealthRepository(db);
    this.stageFacts = new CodingStageFactsRepository(db);
    this.pollFacts = new CodingPollFactsRepository(db);
    this.mergeFacts = new CodingMergeFactsRepository(db);
    this.ancestryFacts = new CodingAncestryFactsRepository(db);
    this.branchFacts = new CodingBranchFactsRepository(db);
    this.refFacts = new CodingRefFactsRepository(db);
    this.workFacts = new CodingWorkFactsRepository(db);
    this.queryFacts = new CodingQueryFactsRepository(db);
  }

  write<K extends CodingLedgerWrite>(
    method: K,
    ...args: Parameters<CodingPrLedgerRepository[K]>
  ): Promise<ReturnType<CodingPrLedgerRepository[K]>> {
    return gatewayFor(this.db).run(codingLedgerWrites, { method, args }) as Promise<
      ReturnType<CodingPrLedgerRepository[K]>
    >;
  }

  read(method: 'lastReads'): Promise<ReturnType<CodingPrLedgerRepository['lastReads']>>;
  read(method: 'list'): Promise<ReturnType<CodingPrLedgerRepository['list']>>;
  read(method: 'lastReads' | 'list') {
    return gatewayFor(this.db).call(codingLedgerReads, method);
  }

  recordStage(fact: CodingStageFact): boolean {
    return this.stageFacts.record(fact);
  }

  readHealthCurrent(repo: string) {
    return gatewayFor(this.db).call(codingLedgerReads, 'readHealth', repo);
  }

  readHealth(repo: string) {
    return this.health.read(repo);
  }

  recordHealth(repo: string, cycle: RepoHealthCycle) {
    return this.health.record(repo, cycle);
  }

  acceptHealthNotice(repo: string, key: string, at: number) {
    this.health.accept(repo, key, at);
  }

  reviewerPolicy(repo: string, body: string, reviewer: z.infer<typeof CodingActor>) {
    return codingReviewerPolicy(this.policy(repo).provenance !== false, body, reviewer);
  }

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
      provenance: read('provenance') as boolean | undefined,
      mergePolicy: read('mergePolicy') as CodingMergePolicy['mergePolicy'],
      reviewBot: read('reviewBot') as string | undefined,
      humanSignoff: read('humanSignoff') as string[] | undefined,
    };
  }

  replace(
    repo: string,
    rows: readonly CodingLedgerRow[],
    now: number,
    observedAt = now
  ): CodingPrTransition[] {
    return this.db.transaction(() => {
      const before = new Map(
        (
          this.db
            .prepare('SELECT number, state FROM pack_coding_pr_ledger WHERE repo = ?')
            .all(repo) as { number: number; state: CodingPrState }[]
        ).map((row) => [row.number, row.state])
      );
      this.upsert(rows, now, observedAt);
      new CodingTodoPrRepository(this.db).claimClosingIssues(rows, now);
      this.db
        .prepare(
          `DELETE FROM pack_coding_pr_ledger WHERE repo = ? AND closed_at IS NULL
           AND number NOT IN (SELECT value FROM json_each(?))`
        )
        .run(repo, JSON.stringify(rows.map((row) => row.number)));
      const activation = this.db
        .prepare('SELECT activated_at FROM pack_coding_pr_event_state WHERE id=1')
        .get() as { activated_at: number };
      for (const row of rows) {
        const from = before.get(row.number);
        if (
          from === row.state ||
          (!from &&
            (!['merged', 'closed'].includes(row.state) ||
              row.closedAt === null ||
              row.closedAt < activation.activated_at))
        )
          continue;
        this.db
          .prepare(
            'UPDATE pack_coding_pr_ledger SET terminal_event_json = ?, told_at = NULL WHERE repo = ? AND number = ?'
          )
          .run(JSON.stringify({ ...row, from: from ?? row.state }), row.repo, row.number);
      }
      return rows.flatMap((row) => {
        const from = before.get(row.number);
        return from && from !== row.state ? [{ ...row, from }] : [];
      });
    })();
  }

  acceptTerminalEvent(row: CodingPrTransition, owner: string, now: number): void {
    this.db
      .prepare(`UPDATE pack_coding_pr_ledger SET terminal_event_json = NULL, told_at = ?
      WHERE repo = ? AND number = ? AND head = ? AND state = ? AND owner = ? AND terminal_event_json = ?`)
      .run(now, row.repo, row.number, row.head, row.state, owner, JSON.stringify(row));
  }

  private upsert(rows: readonly CodingLedgerRow[], now: number, observedAt: number): void {
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
         terminal_event_json = CASE WHEN head = excluded.head AND state = excluded.state
           THEN terminal_event_json ELSE NULL END,
         head = excluded.head, state = excluded.state`
    );
    for (const row of rows) {
      this.stageFacts.observeHead(
        `https://github.com/${row.repo}/pull/${row.number}`,
        row.head,
        observedAt
      );
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
    const keys = (urls: readonly string[]) =>
      urls.flatMap((url) => {
        const key = codingPrKey(url);
        const repo = key && /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(key)?.[1];
        return key && repo && codingRepoWatched(this.db, repo) ? [key] : [];
      });
    for (const session of sessions) {
      const remotes = session.remotes.flatMap((remote) => {
        const repo = codingRemoteRepo(remote);
        return repo && codingRepoWatched(this.db, repo) ? [repo] : [];
      });
      const ref = JSON.stringify(session.ref);
      const previous = this.db
        .prepare('SELECT repos FROM pack_coding_session_facts WHERE ref = ?')
        .get(ref) as { repos: string } | undefined;
      const knownRepos = JSON.parse(previous?.repos ?? '[]') as string[];
      if (
        !remotes.length &&
        !keys(session.openedPrs).length &&
        !keys((session.linkedPrs ?? []).map((pr) => pr.url)).length &&
        codingWatchedRepos(this.db) !== null &&
        !knownRepos.some((repo) => this.watches(repo))
      )
        continue;
      upsert.run(
        ref,
        JSON.stringify(remotes),
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
    }
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
              WHERE s.ref IS NOT NULL AND t.state <> 'removed'
              ORDER BY c.claim = 'named', t.state IN ('todo', 'doing'), COALESCE(t.started_at, 0)`
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
      opened: JSON.parse(row.opened) as string[],
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
      if (!this.watches(row.repo)) continue;
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
          .prepare(`SELECT repo, MAX(readAt) AS readAt FROM (
            SELECT repo, MAX(read_at) AS readAt FROM pack_coding_pr_ledger GROUP BY repo
            UNION ALL SELECT repo, json_extract(health_json, '$.attemptedAt') AS readAt
              FROM pack_coding_repo_health) GROUP BY repo HAVING readAt IS NOT NULL`)
          .all() as { repo: string; readAt: number }[]
      ).map((row) => [row.repo, row.readAt])
    );
  }

  canonicalRepo(repo: string): string {
    return codingCanonicalRepo(this.db, repo);
  }

  watches(repo: string): boolean {
    return codingRepoWatched(this.db, repo);
  }

  stateOf(url: string): CodingPrState | null {
    const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url);
    if (!match || !this.watches(match[1])) return null;
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
    for (const table of ['pack_coding_stage_facts', 'pack_coding_stage_heads'])
      this.db
        .prepare(`DELETE FROM ${table} WHERE substr(url, 1, length(?)) = ?`)
        .run(
          `https://github.com/${repo.toLowerCase()}/pull/`,
          `https://github.com/${repo.toLowerCase()}/pull/`
        );
  }

  snapshot(
    repos: readonly string[] | null,
    now: number,
    pinned: readonly { todoId: string; url: string; state: string | null }[] = []
  ): Record<string, string | number | null>[] {
    const select =
      'SELECT repo, number, title, state, state_since AS since, read_at AS readAt, owner FROM pack_coding_pr_ledger';
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
            ? codingLedgerSnapshotRow(row, this.health.read(row.repo))
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
    return [
      ...own,
      ...rows
        .map((row) => codingLedgerSnapshotRow(row, this.health.read(row.repo)))
        .filter((row) => !owned.has(row.pr)),
    ].filter((row) => this.watches(row.pr.split('#')[0]));
  }

  prune(repos: readonly string[], now: number): void {
    this.db
      .prepare(
        codingWatchedRepos(this.db) === null
          ? `DELETE FROM pack_coding_pr_ledger WHERE closed_at < ? OR read_at < ? OR repo NOT IN (SELECT value FROM json_each(?))`
          : `DELETE FROM pack_coding_pr_ledger WHERE (closed_at < ? OR read_at < ?) AND repo IN (SELECT value FROM json_each(?))`
      )
      .run(now - CODING_LEDGER_KEEP_MS, now - CODING_LEDGER_KEEP_MS, JSON.stringify(repos));
    this.db
      .prepare('DELETE FROM pack_coding_stage_heads WHERE observed_at < ?')
      .run(now - CODING_LEDGER_KEEP_MS);
    this.db.exec(
      'DELETE FROM pack_coding_stage_facts WHERE url NOT IN (SELECT url FROM pack_coding_stage_heads)'
    );
  }

  list(): (CodingLedgerRow & { stateSince: number; readAt: number })[] {
    const rows = this.db
      .prepare(
        `SELECT repo, number, title, branch, head, state, closed_at AS closedAt,
                state_since AS stateSince, read_at AS readAt
           FROM pack_coding_pr_ledger ORDER BY repo, number`
      )
      .all() as (CodingLedgerRow & { stateSince: number; readAt: number })[];
    return rows.filter((row) => this.watches(row.repo));
  }
}

const planLedgerHealth = (superpipe({})('coding-ledger-cycle-outcome') as PipelineAPI)
  .input(['raw', 'complete', 'now'])
  .pipe(
    (raw: unknown, complete: boolean, now: number) => {
      const value = raw as {
        error?: unknown;
        retryAt?: number;
        data?: unknown;
        quota?: LedgerQuota;
      } | null;
      const retryAt = value?.retryAt ?? value?.quota?.retryAt ?? NaN;
      return {
        at: now,
        outcome: complete
          ? 'complete'
          : value?.quota?.deferred
            ? 'cooldown'
            : value?.data
              ? 'partial'
              : 'failed',
        ...(!complete
          ? {
              error:
                value?.quota?.deferred ||
                (typeof value?.error === 'string' && isRateLimitError(value.error))
                  ? 'rate_limited'
                  : value?.data
                    ? 'partial'
                    : 'lookup_failed',
            }
          : {}),
        ...(Number.isSafeInteger(retryAt) && retryAt > now ? { retryAt } : {}),
        ...(value?.quota ? { quota: value.quota } : {}),
      };
    },
    ['raw', 'complete', 'now'],
    'observation'
  )
  .end('observation') as (raw: unknown, complete: boolean, now: number) => RepoHealthCycle;

export async function reconcileCodingPrLedger(
  ledger: CodingPrLedgerRepository,
  repos: readonly string[],
  read: CodingLedgerRead,
  now: number
): Promise<CodingPrTransition[]> {
  const seen = new Set<string>();
  const transitions: CodingPrTransition[] = [];
  const last = await ledger.read('lastReads');
  const pending = (await ledger.read('list')).filter((row) => row.state === 'approved_pending');
  const pendingFor = (repo: string) => {
    const canonical = ledger.canonicalRepo(repo);
    return pending.filter((row) => row.repo === canonical);
  };
  const order = repos
    .filter((repo) => ledger.watches(repo))
    .sort(
      (a, b) => (last.get(ledger.canonicalRepo(a)) ?? 0) - (last.get(ledger.canonicalRepo(b)) ?? 0)
    );
  for (const repo of order) {
    if (!ledger.watches(repo)) continue;
    const before = ledger.health.read(repo);
    const observedAt = Date.now();
    const raw = await read(repo, before?.quota);
    if (!ledger.watches(repo)) continue;
    const planned = planCodingLedgerRead(raw, now, (canonical) => ledger.policy(canonical));
    const cycle = planLedgerHealth(raw, planned !== null, now);
    if (planned) await ledger.write('recordAlias', repo.toLowerCase(), planned.repo);
    const health = await ledger.write('recordHealth', repo, {
      ...cycle,
      pending: pendingFor(repo),
    });
    if (health.misses === CODING_LEDGER_WARN_SKIPS && before?.misses !== health.misses)
      log.warn('PR ledger coverage missed three eligible cycles', { repo, reason: health.reason });
    if (planned && planned.repo !== repo.toLowerCase())
      await ledger.write('dropRepo', repo.toLowerCase());
    if (planned && !seen.has(planned.repo))
      transitions.push(
        ...(await ledger.write('replace', planned.repo, planned.rows, now, observedAt))
      );
    if (planned) seen.add(planned.repo);
  }
  await ledger.write('prune', [...repos, ...seen], now);
  await ledger.write('pruneSessions', now);
  await ledger.write('assignOwners');
  return transitions;
}

type CodingLedgerWrite =
  | 'acceptTerminalEvent'
  | 'acceptHealthNotice'
  | 'recordHealth'
  | 'readHealth'
  | 'recordStage'
  | 'recordAlias'
  | 'dropRepo'
  | 'replace'
  | 'prune'
  | 'pruneSessions'
  | 'assignOwners'
  | 'observeSessions';

export const codingLedgerWrites = defineRepositoryOp<CodingPrLedgerRepository, CodingLedgerWrite>(
  'coding.ledgerWrites',
  'write',
  CodingPrLedgerRepository,
  [
    'acceptTerminalEvent',
    'acceptHealthNotice',
    'recordHealth',
    'readHealth',
    'recordStage',
    'recordAlias',
    'dropRepo',
    'replace',
    'prune',
    'pruneSessions',
    'assignOwners',
    'observeSessions',
  ]
);

export const codingLedgerReads = defineRepositoryOp(
  'coding.ledger.read',
  'read',
  CodingPrLedgerRepository,
  ['lastReads', 'list', 'readHealth'] as const
);
