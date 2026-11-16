import { codingCanonicalRepo } from './watched-repos.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { LedgerQuota } from './ledger-quota.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';

type ReadError = 'rate_limited' | 'partial' | 'lookup_failed';

export type RepoHealthCycle = {
  at: number;
  outcome: 'complete' | 'partial' | 'failed' | 'not_reached' | 'cooldown';
  retryAt?: number;
  error?: ReadError;
  quota?: LedgerQuota;
};
type ReadDiagnostics = {
  readAt: number;
  completeAt: number | null;
  nextRetryAt: number | null;
  lastError: ReadError | null;
  lastErrorAt: number | null;
};
type Health = {
  quota?: LedgerQuota;
  lastError?: ReadError | null;
  lastErrorAt?: number | null;
  cycleAt: number;
  attemptedAt: number | null;
  completeAt: number | null;
  misses: number;
  firstMissAt: number | null;
  reason: RepoHealthCycle['outcome'];
  nextRetryAt: number | null;
  incident: { key: string; raisedAt: number; resolvedAt: number | null } | null;
};

export function codingPendingDiagnostics(readAt: number, health?: Health | null): ReadDiagnostics {
  return {
    readAt,
    completeAt: health?.completeAt ?? null,
    nextRetryAt: health?.nextRetryAt ?? null,
    lastError: health?.lastError ?? null,
    lastErrorAt: health?.lastErrorAt ?? null,
  };
}

function admitCycle(before: Health | null, cycle: RepoHealthCycle) {
  if (!Number.isSafeInteger(cycle.at) || cycle.at < 0)
    throw new Error('Health cycle time must be a nonnegative safe integer');
  if (
    (cycle.outcome === 'cooldown' || cycle.retryAt !== undefined) &&
    (!Number.isSafeInteger(cycle.retryAt) || cycle.retryAt! <= cycle.at)
  )
    throw new Error('Health cooldown requires a later retry time');
  return before && cycle.at <= before.cycleAt ? { reason: before } : { value: cycle };
}

function projectHealth(repo: string, before: Health | null, cycle: RepoHealthCycle): Health {
  const complete = cycle.outcome === 'complete';
  const cooldown = cycle.outcome === 'cooldown';
  const misses = complete ? 0 : (before?.misses ?? 0) + (cooldown ? 0 : 1);
  const firstMissAt = complete ? null : (before?.firstMissAt ?? (cooldown ? null : cycle.at));
  let incident = before?.incident ?? null;
  if (complete && incident && incident.resolvedAt === null)
    incident = { ...incident, resolvedAt: cycle.at };
  if (!complete && !cooldown && misses >= 3 && (!incident || incident.resolvedAt !== null))
    incident = {
      key: `github-health:${repo}:${firstMissAt}`,
      raisedAt: cycle.at,
      resolvedAt: null,
    };
  return {
    lastError: cycle.error ?? before?.lastError ?? null,
    lastErrorAt:
      cycle.error &&
      (cycle.outcome !== 'cooldown' ||
        before?.lastError !== cycle.error ||
        before?.lastErrorAt == null)
        ? cycle.at
        : (before?.lastErrorAt ?? null),
    cycleAt: cycle.at,
    attemptedAt:
      cooldown || cycle.outcome === 'not_reached' ? (before?.attemptedAt ?? null) : cycle.at,
    completeAt: complete ? cycle.at : (before?.completeAt ?? null),
    misses,
    firstMissAt,
    reason: cycle.outcome,
    nextRetryAt: cycle.retryAt ?? null,
    incident,
    ...(cycle.quota ? { quota: cycle.quota } : {}),
  };
}

const reduceHealth = (superpipe({})('coding-repository-health') as PipelineAPI)
  .input(['repo', 'before', 'cycle'])
  .pipe(admitCycle, ['before', 'cycle'], 'result:health')
  .pipe(projectHealth, ['repo', 'before', 'health'], 'health')
  .end('health') as (repo: string, before: Health | null, cycle: RepoHealthCycle) => Health;

export class CodingRepoHealthRepository {
  constructor(private readonly db: Database) {}

  read(repo: string): Health | null {
    const row = this.db
      .prepare(`SELECT health_json FROM pack_coding_repo_health
        WHERE repo = ?1 OR repo IN
          (SELECT alias FROM pack_coding_repo_aliases WHERE canonical = ?1)
        ORDER BY json_extract(health_json, '$.cycleAt') DESC, repo = ?1 DESC LIMIT 1`)
      .get(codingCanonicalRepo(this.db, repo)) as { health_json: string } | undefined;
    return row ? (JSON.parse(row.health_json) as Health) : null;
  }

  record(repo: string, cycle: RepoHealthCycle): Health {
    const canonical = codingCanonicalRepo(this.db, repo);
    return this.db.transaction(() => {
      const before = this.read(canonical);
      const health = reduceHealth(canonical, before, cycle);
      if (health !== before)
        this.db
          .prepare(`INSERT INTO pack_coding_repo_health (repo,health_json) VALUES (?,?)
            ON CONFLICT(repo) DO UPDATE SET health_json=excluded.health_json`)
          .run(canonical, JSON.stringify(health));
      return health;
    }, 'immediate')();
  }
}
