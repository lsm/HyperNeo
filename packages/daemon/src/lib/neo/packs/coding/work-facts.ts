import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { withBusyRetry } from '../../../../storage/busy-retry.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { NEO_WORK_PR_READ_MS, readGithubPrs } from './work-prs.ts';

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
  Map<string, Promise<ReturnType<CodingWorkFactsRepository['read']>>>
>();

export class CodingWorkFactsRepository {
  constructor(private readonly db: Database) {}

  private canonical(url: string): string | null {
    const pr = parsePrUrl(url.toLowerCase());
    if (!pr) return null;
    const repo = `${pr.owner}/${pr.repo}`;
    const alias =
      pr.host === 'github.com'
        ? (this.db
            .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?')
            .get(repo) as { canonical: string } | null)
        : null;
    return `https://${pr.host}/${alias?.canonical.toLowerCase() ?? repo}/pull/${pr.number}`;
  }

  private row(url: string): Row | null {
    return this.db
      .prepare('SELECT * FROM pack_coding_work_facts WHERE url=?')
      .get(url) as Row | null;
  }

  read(url: string, now = Date.now(), maxAgeMs = NEO_WORK_PR_READ_MS) {
    const canonical = this.canonical(url),
      row = canonical ? this.row(canonical) : null;
    const identity = {
      url: canonical ?? url,
      factRevision: row?.fact_revision ?? 0,
      observationRevision: row?.observation_revision ?? 0,
      coverage: 'work-pr-view' as const,
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
            value: JSON.parse(row!.value_json!) as NeoWorkPr,
            observedAt: row!.observed_at!,
            source: 'github-work-view' as const,
          },
    };
  }

  refresh(
    url: string,
    spawn: SpawnFn = spawnProcess,
    now = Date.now
  ): Promise<ReturnType<CodingWorkFactsRepository['read']>> {
    const canonical = this.canonical(url);
    if (!canonical) return Promise.resolve(this.read(url, now()));
    let reads = pending.get(this.db);
    if (!reads) {
      reads = new Map();
      pending.set(this.db, reads);
    }
    const held = reads.get(canonical);
    if (held) return held;
    const revision = this.row(canonical)?.observation_revision ?? 0;
    const request = this.collect(canonical, revision, spawn, now).finally(() =>
      reads!.delete(canonical)
    );
    reads.set(canonical, request);
    return request;
  }

  private async collect(url: string, revision: number, spawn: SpawnFn, now: () => number) {
    let value: NeoWorkPr | null = null,
      requests = 0;
    try {
      const measured: SpawnFn = (args, options) => {
        requests++;
        return spawn(args, options);
      };
      value = (await readGithubPrs([url], measured))?.[0] ?? null;
    } catch {}
    log.info('PR ledger work GitHub read', { url, lookups: requests, ok: value !== null });
    const persist = this.db.transaction(() => {
      const before = this.row(url);
      if ((before?.observation_revision ?? 0) !== revision) return;
      const at = now(),
        json = value ? JSON.stringify(value) : (before?.value_json ?? null);
      this.db
        .prepare(`INSERT INTO pack_coding_work_facts
        (url,fact_revision,observation_revision,value_json,observed_at,attempted_at,reason)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET
        fact_revision=excluded.fact_revision,observation_revision=excluded.observation_revision,
        value_json=excluded.value_json,observed_at=excluded.observed_at,
        attempted_at=excluded.attempted_at,reason=excluded.reason`)
        .run(
          url,
          (before?.fact_revision ?? 0) + (value && json !== before?.value_json ? 1 : 0),
          revision + 1,
          json,
          value ? at : (before?.observed_at ?? null),
          at,
          value ? null : 'failed'
        );
    }, 'immediate');
    withBusyRetry(persist);
    return this.read(url, now());
  }
}
