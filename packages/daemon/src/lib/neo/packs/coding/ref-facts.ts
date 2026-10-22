import type { Database } from '../../../../storage/sqlite-compat.ts';
import { withBusyRetry } from '../../../../storage/busy-retry.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { readGithubRefStates, type NeoRef, type NeoRefState } from './ask-prs.ts';

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
  Map<string, Promise<ReturnType<CodingRefFactsRepository['read']>>>
>();

export class CodingRefFactsRepository {
  constructor(private readonly db: Database) {}

  private canonical(ref: NeoRef): NeoRef {
    const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
    const alias = this.db
      .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?')
      .get(repo) as { canonical: string } | null;
    const [owner, name] = (alias?.canonical.toLowerCase() ?? repo).split('/');
    return { owner, repo: name, number: ref.number };
  }

  private row(key: string): Row | null {
    return this.db
      .prepare('SELECT * FROM pack_coding_ref_facts WHERE subject=?')
      .get(key) as Row | null;
  }

  read(ref: NeoRef, now = Date.now(), maxAgeMs = 120_000) {
    const canonical = this.canonical(ref),
      row = this.row(JSON.stringify(canonical));
    const identity = {
      ref: canonical,
      factRevision: row?.fact_revision ?? 0,
      observationRevision: row?.observation_revision ?? 0,
      coverage: 'ref-state-view' as const,
    };
    const reason = !row
      ? 'missing'
      : (row.reason ??
        (row.observed_at === null || now - row.observed_at >= maxAgeMs ? 'stale' : null));
    return {
      ...identity,
      view: reason
        ? {
            status: 'unknown' as const,
            reason,
            observedAt: row?.observed_at ?? null,
            attemptedAt: row?.attempted_at ?? null,
          }
        : {
            status: 'known' as const,
            value: JSON.parse(row!.value_json!) as NeoRefState,
            observedAt: row!.observed_at!,
            source: 'github-reference-view' as const,
          },
    };
  }

  refresh(
    ref: NeoRef,
    spawn: SpawnFn = spawnProcess,
    now = Date.now
  ): Promise<ReturnType<CodingRefFactsRepository['read']>> {
    const canonical = this.canonical(ref),
      key = JSON.stringify(canonical);
    let reads = pending.get(this.db);
    if (!reads) {
      reads = new Map();
      pending.set(this.db, reads);
    }
    const held = reads.get(key);
    if (held) return held;
    const revision = this.row(key)?.observation_revision ?? 0;
    const request = this.collect(canonical, revision, spawn, now).finally(() => reads!.delete(key));
    reads.set(key, request);
    return request;
  }

  private async collect(ref: NeoRef, revision: number, spawn: SpawnFn, now: () => number) {
    const key = JSON.stringify(ref);
    let value: NeoRefState | null = null,
      requests = 0;
    try {
      const measured: SpawnFn = (args, options) => {
        requests++;
        return spawn(args, options);
      };
      value = (await readGithubRefStates([ref], measured, true))?.[0] ?? null;
    } catch {}
    log.info('PR ledger reference GitHub read', { ref, lookups: requests, ok: value !== null });
    const persist = this.db.transaction(() => {
      const before = this.row(key);
      if ((before?.observation_revision ?? 0) !== revision) return;
      const at = now(),
        json = value ? JSON.stringify(value) : (before?.value_json ?? null);
      this.db
        .prepare(`INSERT INTO pack_coding_ref_facts
        (subject,fact_revision,observation_revision,value_json,observed_at,attempted_at,reason)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET
        fact_revision=excluded.fact_revision,observation_revision=excluded.observation_revision,
        value_json=excluded.value_json,observed_at=excluded.observed_at,
        attempted_at=excluded.attempted_at,reason=excluded.reason`)
        .run(
          key,
          (before?.fact_revision ?? 0) + (value && json !== before?.value_json ? 1 : 0),
          revision + 1,
          json,
          value ? at : (before?.observed_at ?? null),
          at,
          value ? null : 'failed'
        );
    }, 'immediate');
    withBusyRetry(persist);
    return this.read(ref, now());
  }
}
