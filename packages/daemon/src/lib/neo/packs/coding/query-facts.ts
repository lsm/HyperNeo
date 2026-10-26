import type { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { callCodingBranchDb } from './branch-facts-db.ts';
import { codingQueryReads, codingQueryWrites } from './query-facts-db.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import {
  listNeoGithub,
  NeoGithubQueryItems,
  planNeoGithubQuery,
  type NeoGithubCollection,
} from './github-query.ts';

type Row = {
  coverage_json: string;
  fact_revision: number;
  observation_revision: number;
  value_json: string | null;
  observed_at: number | null;
  attempted_at: number;
  reason: 'failed' | null;
};
const log = new Logger('NeoCodingLedger');
const pending = new WeakMap<
  Database,
  Map<string, Promise<ReturnType<CodingQueryFactsRepository['read']>>>
>();

export class CodingQueryFactsRepository {
  constructor(private readonly db: Database) {}

  private coverage(input: NeoGithubCollection): NeoGithubCollection {
    const repo = input.repo.toLowerCase();
    const alias = this.db
      .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?')
      .get(repo) as { canonical: string } | null;
    return {
      repo: alias?.canonical.toLowerCase() ?? repo,
      kind: input.kind,
      state: input.state,
      by: input.by,
      since: input.since,
      until: input.until,
      limit: input.limit,
      withinHours: input.withinHours,
    };
  }

  private subject(coverage: NeoGithubCollection) {
    return JSON.stringify({
      ...coverage,
      since: coverage.withinHours ? undefined : coverage.since,
    });
  }

  private row(subject: string): Row | null {
    return this.db
      .prepare('SELECT * FROM pack_coding_query_facts WHERE subject=?')
      .get(subject) as Row | null;
  }

  read(input: NeoGithubCollection, now = Date.now(), maxAgeMs = 120_000) {
    const coverage = this.coverage(input),
      row = this.row(this.subject(coverage));
    const reason = !row
      ? 'missing'
      : (row.reason ??
        (row.observed_at === null || now - row.observed_at >= maxAgeMs ? 'stale' : null));
    const value = row?.value_json
      ? (JSON.parse(row.value_json) as z.infer<typeof NeoGithubQueryItems>)
      : null;
    return {
      coverage: {
        kind: 'bounded-query' as const,
        query: row ? (JSON.parse(row.coverage_json) as NeoGithubCollection) : coverage,
      },
      factRevision: row?.fact_revision ?? 0,
      observationRevision: row?.observation_revision ?? 0,
      view: reason
        ? {
            status: 'unknown' as const,
            reason,
            observedAt: row?.observed_at ?? null,
            attemptedAt: row?.attempted_at ?? null,
          }
        : {
            status: 'known' as const,
            value: value!,
            truncated: value!.length > coverage.limit,
            observedAt: row!.observed_at!,
            source: 'github-query-list' as const,
          },
    };
  }

  snapshot(input: NeoGithubCollection) {
    const coverage = this.coverage(input),
      subject = this.subject(coverage);
    return { coverage, subject, revision: this.row(subject)?.observation_revision ?? 0 };
  }

  refresh(
    input: NeoGithubCollection,
    spawn: SpawnFn = spawnProcess,
    now = Date.now
  ): Promise<ReturnType<CodingQueryFactsRepository['read']>> {
    let reads = pending.get(this.db);
    if (!reads) {
      reads = new Map();
      pending.set(this.db, reads);
    }
    const key = `request:${JSON.stringify([
      input.repo.toLowerCase(),
      input.kind,
      input.state,
      input.by,
      input.withinHours ? undefined : input.since,
      input.until,
      input.limit,
      input.withinHours,
    ])}`;
    const held = reads.get(key);
    if (held) return held;
    const request = this.collectCurrent(input, reads, spawn, now).finally(() => reads.delete(key));
    reads.set(key, request);
    return request;
  }

  private async collectCurrent(
    input: NeoGithubCollection,
    reads: Map<string, Promise<ReturnType<CodingQueryFactsRepository['read']>>>,
    spawn: SpawnFn,
    now: () => number
  ) {
    const { coverage, subject, revision } = await callCodingBranchDb(
      () => gatewayFor(this.db).call(codingQueryReads, 'snapshot', input),
      'coding.query.db'
    );
    const held = reads.get(subject);
    if (held) return held;
    const request = this.collect(coverage, subject, revision, spawn, now).finally(() =>
      reads.delete(subject)
    );
    reads.set(subject, request);
    return request;
  }

  private async collect(
    coverage: NeoGithubCollection,
    subject: string,
    revision: number,
    spawn: SpawnFn,
    now: () => number
  ) {
    let value: z.infer<typeof NeoGithubQueryItems> | null = null;
    try {
      const plan = planNeoGithubQuery({ ...coverage, withinHours: undefined });
      if ('value' in plan) {
        const parsed = NeoGithubQueryItems.safeParse(await listNeoGithub(plan.value.args, spawn));
        if (parsed.success) value = parsed.data;
      }
    } catch {}
    log.info('PR ledger query GitHub read', {
      repo: coverage.repo,
      kind: coverage.kind,
      ok: value !== null,
    });
    return callCodingBranchDb(
      () =>
        gatewayFor(this.db).call(
          codingQueryWrites,
          'observe',
          coverage,
          subject,
          revision,
          value,
          now()
        ),
      'coding.query.db'
    );
  }

  observe(
    coverage: NeoGithubCollection,
    subject: string,
    revision: number,
    value: z.infer<typeof NeoGithubQueryItems> | null,
    at: number
  ) {
    const before = this.row(subject);
    if ((before?.observation_revision ?? 0) !== revision) return this.read(coverage, at);
    const json = value ? JSON.stringify(value) : (before?.value_json ?? null),
      covered = value
        ? JSON.stringify(coverage)
        : (before?.coverage_json ?? JSON.stringify(coverage));
    this.db
      .prepare(`INSERT INTO pack_coding_query_facts
      (subject,coverage_json,fact_revision,observation_revision,value_json,observed_at,attempted_at,reason)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET
      coverage_json=excluded.coverage_json,
      fact_revision=excluded.fact_revision,observation_revision=excluded.observation_revision,
      value_json=excluded.value_json,observed_at=excluded.observed_at,
      attempted_at=excluded.attempted_at,reason=excluded.reason`)
      .run(
        subject,
        covered,
        (before?.fact_revision ?? 0) +
          (value && (json !== before?.value_json || covered !== before?.coverage_json) ? 1 : 0),
        revision + 1,
        json,
        value ? at : (before?.observed_at ?? null),
        at,
        value ? null : 'failed'
      );
    return this.read(coverage, at);
  }
}
