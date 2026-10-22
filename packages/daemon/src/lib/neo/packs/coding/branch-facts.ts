import { homedir } from 'node:os';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { Logger } from '../../../logger.ts';
import { isRateLimitError } from '../../../session/rate-limit-detector.ts';
import { NEO_WORK_PR_READ_MS } from './work-prs.ts';
import { CODING_BRANCH_PR_LIMIT } from './branch-prs.ts';

const log = new Logger('NeoCodingLedger');
const Membership = z.array(z.object({ url: z.string().url() })).max(CODING_BRANCH_PR_LIMIT);
type Reason = 'failed' | 'partial' | 'rate_limited' | 'not_authorized';
type Row = {
  fact_revision: number;
  observation_revision: number;
  urls_json: string | null;
  observed_at: number | null;
  attempted_at: number;
  retry_at: number;
  reason: Reason | null;
  coverage_limit: number;
};
type Observation = { urls: string[] } | { reason: Reason; retryMs: number };
const pending = new WeakMap<
  Database,
  Map<string, Promise<ReturnType<CodingBranchFactsRepository['read']>>>
>();

export class CodingBranchFactsRepository {
  constructor(private readonly db: Database) {}

  private canonical(repo: string): string {
    return (
      (
        this.db
          .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?')
          .get(repo.toLowerCase()) as { canonical: string } | null
      )?.canonical.toLowerCase() ?? repo.toLowerCase()
    );
  }

  private row(repo: string, branch: string): Row | null {
    return this.db
      .prepare('SELECT * FROM pack_coding_branch_facts WHERE repo=? AND branch=?')
      .get(repo, branch) as Row | null;
  }

  read(repo: string, branch: string, now = Date.now()) {
    const canonical = this.canonical(repo),
      row = this.row(canonical, branch);
    const identity = {
      repo: canonical,
      branch,
      factRevision: row?.fact_revision ?? 0,
      observationRevision: row?.observation_revision ?? 0,
      coverage: { state: 'all' as const, limit: CODING_BRANCH_PR_LIMIT },
    };
    const reason = !row
      ? 'missing'
      : (row.reason ??
        (row.coverage_limit !== CODING_BRANCH_PR_LIMIT ? 'partial' : null) ??
        (row.observed_at === null || now - row.observed_at >= NEO_WORK_PR_READ_MS
          ? 'stale'
          : null));
    return {
      ...identity,
      membership: reason
        ? {
            status: 'unknown' as const,
            reason,
            observedAt: row?.observed_at ?? null,
            attemptedAt: row?.attempted_at ?? null,
          }
        : {
            status: 'known' as const,
            source: 'github-branch-list' as const,
            urls: JSON.parse(row!.urls_json!) as string[],
            observedAt: row!.observed_at!,
          },
    };
  }

  refresh(
    repo: string,
    branch: string,
    spawn: SpawnFn = spawnProcess,
    now = Date.now
  ): Promise<ReturnType<CodingBranchFactsRepository['read']>> {
    const canonical = this.canonical(repo),
      current = this.read(canonical, branch, now());
    if (
      current.membership.status === 'known' ||
      (this.row(canonical, branch)?.retry_at ?? 0) > now()
    )
      return Promise.resolve(current);
    let reads = pending.get(this.db);
    if (!reads) {
      reads = new Map();
      pending.set(this.db, reads);
    }
    const key = JSON.stringify([canonical, branch]),
      held = reads.get(key);
    if (held) return held;
    const request = this.collect(
      canonical,
      branch,
      current.observationRevision,
      spawn,
      now
    ).finally(() => reads!.delete(key));
    reads.set(key, request);
    return request;
  }

  private async collect(
    repo: string,
    branch: string,
    revision: number,
    spawn: SpawnFn,
    now: () => number
  ) {
    let observation: Observation;
    try {
      let requests = 0;
      const measured: SpawnFn = (args, options) => {
        requests++;
        return spawn(args, options);
      };
      const result = await runGhJson(
        [
          'gh',
          'pr',
          'list',
          '--repo',
          repo,
          '--head',
          branch,
          '--state',
          'all',
          '--json',
          'url',
          '--limit',
          String(CODING_BRANCH_PR_LIMIT),
        ],
        homedir(),
        measured,
        { resourceHint: 'graphql', stripGHRepo: true }
      );
      log.info('PR ledger branch GitHub read', { repo, lookups: requests, ok: result.ok });
      const parsed = result.ok ? Membership.safeParse(result.data) : null;
      observation = parsed?.success
        ? { urls: parsed.data.map((pr) => pr.url) }
        : result.ok
          ? { reason: 'partial', retryMs: 0 }
          : {
              reason: isRateLimitError(result.error)
                ? 'rate_limited'
                : /HTTP (401|403)/.test(result.error)
                  ? 'not_authorized'
                  : 'failed',
              retryMs: result.retryAfterMs ?? 0,
            };
    } catch {
      observation = { reason: 'failed', retryMs: 0 };
    }
    this.db.transaction(() => {
      const before = this.row(repo, branch);
      if ((before?.observation_revision ?? 0) !== revision) return;
      const observed = observation;
      const at = now(),
        success = 'urls' in observed;
      const urls = success ? JSON.stringify(observed.urls) : (before?.urls_json ?? null);
      this.db
        .prepare(`INSERT INTO pack_coding_branch_facts
        (repo,branch,fact_revision,observation_revision,urls_json,observed_at,attempted_at,retry_at,reason,coverage_limit)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,branch) DO UPDATE SET
        fact_revision=excluded.fact_revision, observation_revision=excluded.observation_revision,
        urls_json=excluded.urls_json, observed_at=excluded.observed_at, attempted_at=excluded.attempted_at,
        retry_at=excluded.retry_at, reason=excluded.reason, coverage_limit=excluded.coverage_limit`)
        .run(
          repo,
          branch,
          (before?.fact_revision ?? 0) + (success && urls !== before?.urls_json ? 1 : 0),
          revision + 1,
          urls,
          success ? at : (before?.observed_at ?? null),
          at,
          success ? 0 : at + observed.retryMs,
          success ? null : observed.reason,
          CODING_BRANCH_PR_LIMIT
        );
    }, 'immediate')();
    return this.read(repo, branch, now());
  }
}
