import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { withBusyRetry } from '../../../../storage/busy-retry.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { Logger } from '../../../logger.ts';
import { type SpawnFn, spawnProcess } from '../../../runtime-spawn/index.ts';
import { NEO_WORK_PR_READ_MS } from './work-prs.ts';

type MergeValue = { state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeCommit: string | null };
type Unreadable = 'failed' | 'partial' | 'rate_limited' | 'not_authorized';
type Observation = { value: MergeValue; source: string } | { reason: Unreadable };
const log = new Logger('NeoCodingLedger');
const Merge = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  mergeCommit: z.object({ oid: z.string().min(1) }).nullable(),
});
const pending = new WeakMap<
  Database,
  Map<string, Promise<ReturnType<CodingMergeFactsRepository['read']>>>
>();
type Row = {
  factRevision: number;
  observationRevision: number;
  value: string | null;
  source: string | null;
  observedAt: number | null;
  attemptedAt: number;
  reason: Unreadable | null;
};

function canonicalRepo(db: Database, repo: string): string {
  const lower = repo.toLowerCase();
  const alias = db
    .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias = ?')
    .get(lower) as { canonical: string } | undefined;
  return alias?.canonical.toLowerCase() ?? lower;
}

function loadMergeFact(db: Database, repo: string, number: number): Row | undefined {
  return db
    .prepare(`SELECT fact_revision AS factRevision, observation_revision AS observationRevision,
    value_json AS value, source, observed_at AS observedAt, attempted_at AS attemptedAt, reason
    FROM pack_coding_merge_facts WHERE repo = ? AND number = ?`)
    .get(repo, number) as Row | undefined;
}

function projectMergeFact(
  repo: string,
  number: number,
  row: Row | undefined,
  now: number,
  maxAgeMs: number
) {
  const identity = {
    repo,
    number,
    factRevision: row?.factRevision ?? 0,
    observationRevision: row?.observationRevision ?? 0,
  };
  if (!row)
    return { ...identity, merge: { status: 'unknown' as const, reason: 'missing' as const } };
  const reason =
    row.reason ?? (row.observedAt === null || now - row.observedAt > maxAgeMs ? 'stale' : null);
  if (reason)
    return {
      ...identity,
      merge: {
        status: 'unknown' as const,
        reason,
        attemptedAt: row.attemptedAt,
        ...(row.observedAt !== null ? { observedAt: row.observedAt } : {}),
      },
    };
  return {
    ...identity,
    merge: {
      status: 'known' as const,
      value: JSON.parse(row.value!) as MergeValue,
      observedAt: row.observedAt!,
      source: row.source!,
    },
  };
}

const readMergeFacts = (superpipe({})('coding-ledger-merge-facts-read') as PipelineAPI)
  .input(['db', 'repo', 'number', 'now', 'maxAgeMs'])
  .pipe(canonicalRepo, ['db', 'repo'], 'repo')
  .pipe(loadMergeFact, ['db', 'repo', 'number'], 'row')
  .pipe(projectMergeFact, ['repo', 'number', 'row', 'now', 'maxAgeMs'], 'facts')
  .end('facts') as (
  db: Database,
  repo: string,
  number: number,
  now: number,
  maxAgeMs: number
) => ReturnType<typeof projectMergeFact>;

export class CodingMergeFactsRepository {
  constructor(private readonly db: Database) {}

  read(repo: string, number: number, now: number, maxAgeMs: number) {
    return readMergeFacts(this.db, repo, number, now, maxAgeMs);
  }

  refresh(repo: string, number: number, spawn: SpawnFn = spawnProcess, now = Date.now) {
    const canonical = canonicalRepo(this.db, repo),
      current = this.read(canonical, number, now(), NEO_WORK_PR_READ_MS);
    if (current.merge.status === 'known') return Promise.resolve(current);
    let active = pending.get(this.db);
    if (!active) {
      active = new Map();
      pending.set(this.db, active);
    }
    const key = JSON.stringify([canonical, number]),
      held = active.get(key);
    if (held) return held;
    const request = collectMergeFacts(
      this,
      canonical,
      number,
      current.observationRevision,
      spawn,
      now
    ).finally(() => active.delete(key));
    active.set(key, request);
    return request;
  }

  record(
    repo: string,
    number: number,
    observation: Observation,
    at: number,
    expectedRevision: number
  ): boolean {
    return this.db.transaction(() => {
      const canonical = canonicalRepo(this.db, repo);
      const before = loadMergeFact(this.db, canonical, number);
      if ((before?.observationRevision ?? 0) !== expectedRevision) return false;
      const success = 'value' in observation;
      const value = success
        ? JSON.stringify({
            state: observation.value.state,
            mergeCommit: observation.value.mergeCommit,
          })
        : (before?.value ?? null);
      const factRevision =
        (before?.factRevision ?? 0) + (success && value !== (before?.value ?? null) ? 1 : 0);
      this.db
        .prepare(`INSERT INTO pack_coding_merge_facts
        (repo, number, fact_revision, observation_revision, value_json, source, observed_at, attempted_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, number) DO UPDATE SET fact_revision = excluded.fact_revision,
        observation_revision = excluded.observation_revision, value_json = excluded.value_json,
        source = excluded.source, observed_at = excluded.observed_at,
        attempted_at = excluded.attempted_at, reason = excluded.reason`)
        .run(
          canonical,
          number,
          factRevision,
          expectedRevision + 1,
          value,
          success ? observation.source : (before?.source ?? null),
          success ? at : (before?.observedAt ?? null),
          at,
          success ? null : observation.reason
        );
      return true;
    }, 'immediate')();
  }
}

const collectMergeFacts = (superpipe({})('coding-ledger-merge-facts-refresh') as PipelineAPI)
  .input(['facts', 'repo', 'number', 'revision', 'spawn', 'now'])
  .pipe(
    async (repo: string, number: number, spawn: SpawnFn): Promise<Observation> => {
      const path = repo.split('/').length === 2 ? `github.com/${repo}` : repo;
      const outcome = await runGhJson(
        ['gh', 'pr', 'view', `https://${path}/pull/${number}`, '--json', 'state,mergeCommit'],
        homedir(),
        spawn
      );
      const parsed = outcome.ok ? Merge.safeParse(outcome.data) : null;
      log.info('PR ledger merge GitHub read', {
        repo,
        number,
        lookups: 1,
        ok: parsed?.success === true,
      });
      if (!outcome.ok) return { reason: 'failed' };
      return parsed?.success
        ? {
            value: {
              state: parsed.data.state,
              mergeCommit: parsed.data.mergeCommit?.oid ?? null,
            },
            source: 'github-pr-detail',
          }
        : { reason: 'partial' };
    },
    ['repo', 'number', 'spawn'],
    'observation'
  )
  .pipe(
    (
      facts: CodingMergeFactsRepository,
      repo: string,
      number: number,
      observation: Observation,
      now: () => number,
      revision: number
    ) => withBusyRetry(() => facts.record(repo, number, observation, now(), revision)),
    ['facts', 'repo', 'number', 'observation', 'now', 'revision'],
    'recorded'
  )
  .pipe(
    (facts: CodingMergeFactsRepository, repo: string, number: number, now: () => number) =>
      facts.read(repo, number, now(), NEO_WORK_PR_READ_MS),
    ['facts', 'repo', 'number', 'now'],
    'read'
  )
  .endAsync('read') as (
  facts: CodingMergeFactsRepository,
  repo: string,
  number: number,
  revision: number,
  spawn: SpawnFn,
  now: () => number
) => Promise<ReturnType<CodingMergeFactsRepository['read']>>;
