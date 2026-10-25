import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { callCodingBranchDb } from './branch-facts-db.ts';
import { codingRefReads, codingRefWrites } from './ref-facts-db.ts';
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

function refRequests(db: Database) {
  let reads = pending.get(db);
  if (!reads) {
    reads = new Map();
    pending.set(db, reads);
  }
  return reads;
}

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

  readCurrent(ref: NeoRef, at = Date.now(), maxAgeMs = 120_000) {
    return callCodingBranchDb(
      () => gatewayFor(this.db).call(codingRefReads, 'read', ref, at, maxAgeMs),
      'coding.ref.db'
    );
  }

  refresh(
    ref: NeoRef,
    spawn: SpawnFn = spawnProcess,
    now = Date.now,
    reuseTerminal = false
  ): Promise<ReturnType<CodingRefFactsRepository['read']>> {
    const reads = refRequests(this.db);
    const key = `${reuseTerminal ? 'read' : 'refresh'}:${JSON.stringify({
      owner: ref.owner.toLowerCase(),
      repo: ref.repo.toLowerCase(),
      number: ref.number,
    })}`;
    const held = reads.get(key);
    if (held) return held;
    const request = this.collectCurrent(ref, spawn, now, reuseTerminal).finally(() =>
      reads.delete(key)
    );
    reads.set(key, request);
    return request;
  }

  private async collectCurrent(
    ref: NeoRef,
    spawn: SpawnFn,
    now: () => number,
    reuseTerminal: boolean
  ) {
    const current = await this.readCurrent(ref, now());
    if (
      reuseTerminal &&
      current.view.status === 'known' &&
      current.view.value.kind === 'pr' &&
      current.view.value.done
    )
      return current;
    const canonical = current.ref,
      key = JSON.stringify(canonical);
    const reads = refRequests(this.db);
    const held = reads.get(key);
    if (held) return held;
    const revision = current.observationRevision;
    const request = this.collect(canonical, revision, spawn, now).finally(() => reads!.delete(key));
    reads.set(key, request);
    return request;
  }

  private async collect(ref: NeoRef, revision: number, spawn: SpawnFn, now: () => number) {
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
    return callCodingBranchDb(
      () => gatewayFor(this.db).call(codingRefWrites, 'observe', ref, revision, value, now()),
      'coding.ref.db'
    );
  }

  observe(ref: NeoRef, revision: number, value: NeoRefState | null, at: number) {
    const key = JSON.stringify(ref);
    const before = this.row(key);
    if ((before?.observation_revision ?? 0) !== revision) return this.read(ref, at);
    const json = value ? JSON.stringify(value) : (before?.value_json ?? null);
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
    return this.read(ref, at);
  }
}
