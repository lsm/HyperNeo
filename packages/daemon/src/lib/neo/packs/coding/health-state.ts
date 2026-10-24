import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';

export type RepoHealthCycle = {
  at: number;
  outcome: 'complete' | 'partial' | 'failed' | 'not_reached' | 'cooldown';
  retryAt?: number;
};
type Health = {
  cycleAt: number;
  attemptedAt: number | null;
  completeAt: number | null;
  misses: number;
  firstMissAt: number | null;
  reason: RepoHealthCycle['outcome'];
  nextRetryAt: number | null;
  incident: { key: string; raisedAt: number; resolvedAt: number | null } | null;
};

function admitCycle(before: Health | null, cycle: RepoHealthCycle) {
  if (!Number.isSafeInteger(cycle.at) || cycle.at <= 0)
    throw new Error('Health cycle time must be a positive safe integer');
  if (
    cycle.outcome === 'cooldown' &&
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
    cycleAt: cycle.at,
    attemptedAt:
      cooldown || cycle.outcome === 'not_reached' ? (before?.attemptedAt ?? null) : cycle.at,
    completeAt: complete ? cycle.at : (before?.completeAt ?? null),
    misses,
    firstMissAt,
    reason: cycle.outcome,
    nextRetryAt: cooldown ? cycle.retryAt! : null,
    incident,
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
      .prepare('SELECT health_json FROM pack_coding_repo_health WHERE repo=?')
      .get(repo.toLowerCase()) as { health_json: string } | undefined;
    return row ? (JSON.parse(row.health_json) as Health) : null;
  }

  record(repo: string, cycle: RepoHealthCycle): Health {
    const canonical = repo.toLowerCase();
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
