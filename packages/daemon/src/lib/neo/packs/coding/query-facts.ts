import type { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { withBusyRetry } from '../../../../storage/busy-retry.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import {
  listNeoGithub,
  NeoGithubQueryItems,
  planNeoGithubQuery,
  type NeoGithubCollection,
} from './github-query.ts';

type Row = {
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
    };
  }

  private row(subject: string): Row | null {
    return this.db
      .prepare('SELECT * FROM pack_coding_query_facts WHERE subject=?')
      .get(subject) as Row | null;
  }

  read(input: NeoGithubCollection, now = Date.now(), maxAgeMs = 120_000) {
    const coverage = this.coverage(input),
      row = this.row(JSON.stringify(coverage));
    const reason = !row
      ? 'missing'
      : (row.reason ??
        (row.observed_at === null || now - row.observed_at >= maxAgeMs ? 'stale' : null));
    const value = row?.value_json
      ? (JSON.parse(row.value_json) as z.infer<typeof NeoGithubQueryItems>)
      : null;
    return {
      coverage: { kind: 'bounded-query' as const, query: coverage },
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

  refresh(
    input: NeoGithubCollection,
    spawn: SpawnFn = spawnProcess,
    now = Date.now
  ): Promise<ReturnType<CodingQueryFactsRepository['read']>> {
    const coverage = this.coverage(input),
      subject = JSON.stringify(coverage);
    let reads = pending.get(this.db);
    if (!reads) {
      reads = new Map();
      pending.set(this.db, reads);
    }
    const held = reads.get(subject);
    if (held) return held;
    const revision = this.row(subject)?.observation_revision ?? 0;
    const request = this.collect(coverage, subject, revision, spawn, now).finally(() =>
      reads!.delete(subject)
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
      const plan = planNeoGithubQuery(coverage);
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
    const persist = this.db.transaction(() => {
      const before = this.row(subject);
      if ((before?.observation_revision ?? 0) !== revision) return;
      const at = now(),
        json = value ? JSON.stringify(value) : (before?.value_json ?? null);
      this.db
        .prepare(`INSERT INTO pack_coding_query_facts
        (subject,fact_revision,observation_revision,value_json,observed_at,attempted_at,reason)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET
        fact_revision=excluded.fact_revision,observation_revision=excluded.observation_revision,
        value_json=excluded.value_json,observed_at=excluded.observed_at,
        attempted_at=excluded.attempted_at,reason=excluded.reason`)
        .run(
          subject,
          (before?.fact_revision ?? 0) + (value && json !== before?.value_json ? 1 : 0),
          revision + 1,
          json,
          value ? at : (before?.observed_at ?? null),
          at,
          value ? null : 'failed'
        );
    }, 'immediate');
    withBusyRetry(persist);
    return this.read(coverage, now());
  }
}
