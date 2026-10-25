import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { callCodingBranchDb } from './branch-facts-db.ts';
import { codingAncestryReads, codingAncestryWrites } from './ancestry-facts-db.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { Logger } from '../../../logger.ts';
import { type SpawnFn, spawnProcess } from '../../../runtime-spawn/index.ts';

type Subject = { repo: string; baseOid: string; headOid: string };
const Status = z.enum(['ahead', 'identical', 'behind', 'diverged']);
const Compare = z.object({ status: Status });
type Observation = { status: z.infer<typeof Status> } | { reason: 'failed' | 'partial' };
type Row = {
  status: z.infer<typeof Status> | null;
  fact_revision: number;
  observation_revision: number;
  observed_at: number | null;
  attempted_at: number;
  reason: 'failed' | 'partial' | null;
};
const log = new Logger('NeoCodingLedger');
const pending = new WeakMap<
  Database,
  Map<string, Promise<ReturnType<CodingAncestryFactsRepository['read']>>>
>();

export class CodingAncestryFactsRepository {
  constructor(private readonly db: Database) {}

  private canonical(subject: Subject): Subject {
    const repo = subject.repo.toLowerCase();
    const alias = this.db
      .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?')
      .get(repo) as { canonical: string } | null;
    return {
      repo: alias?.canonical.toLowerCase() ?? repo,
      baseOid: subject.baseOid,
      headOid: subject.headOid,
    };
  }

  private row(subject: Subject): Row | null {
    return this.db
      .prepare(
        'SELECT * FROM pack_coding_ancestry_facts WHERE repo=? AND base_oid=? AND head_oid=?'
      )
      .get(subject.repo, subject.baseOid, subject.headOid) as Row | null;
  }

  read(input: Subject) {
    const subject = this.canonical(input),
      row = this.row(subject);
    const reason = !row ? 'missing' : (row.reason ?? (row.status === null ? 'partial' : null));
    return {
      subject,
      factRevision: row?.fact_revision ?? 0,
      observationRevision: row?.observation_revision ?? 0,
      ancestry: reason
        ? {
            status: 'unknown' as const,
            reason,
            observedAt: row?.observed_at ?? null,
            attemptedAt: row?.attempted_at ?? null,
          }
        : {
            status: 'known' as const,
            comparison: row!.status!,
            contains: row!.status === 'ahead' || row!.status === 'identical',
            observedAt: row!.observed_at!,
            source: 'github-compare' as const,
          },
    };
  }

  refresh(input: Subject, spawn: SpawnFn = spawnProcess, now = Date.now) {
    let active = pending.get(this.db);
    if (!active) {
      active = new Map();
      pending.set(this.db, active);
    }
    const key = `request:${JSON.stringify([input.repo.toLowerCase(), input.baseOid, input.headOid])}`;
    const held = active.get(key);
    if (held) return held;
    const request = this.collectCurrent(input, active, spawn, now).finally(() =>
      active.delete(key)
    );
    active.set(key, request);
    return request;
  }

  private async collectCurrent(
    input: Subject,
    active: Map<string, Promise<ReturnType<CodingAncestryFactsRepository['read']>>>,
    spawn: SpawnFn,
    now: () => number
  ) {
    const current = await callCodingBranchDb(
        () => gatewayFor(this.db).call(codingAncestryReads, 'read', input),
        'coding.ancestry.db'
      ),
      subject = current.subject;
    if (current.ancestry.status === 'known') return current;
    const key = JSON.stringify(subject),
      held = active.get(key);
    if (held) return held;
    const request = collectAncestry(this, subject, current.observationRevision, spawn, now).finally(
      () => active.delete(key)
    );
    active.set(key, request);
    return request;
  }

  observe(input: Subject, observation: Observation, at: number, revision: number) {
    this.persist(input, observation, at, revision);
    return this.read(input);
  }

  observeCurrent(input: Subject, observation: Observation, at: number, revision: number) {
    return callCodingBranchDb(
      () =>
        gatewayFor(this.db).call(codingAncestryWrites, 'observe', input, observation, at, revision),
      'coding.ancestry.db'
    );
  }

  private persist(input: Subject, observation: Observation, at: number, revision: number) {
    const subject = this.canonical(input),
      before = this.row(subject);
    if ((before?.observation_revision ?? 0) !== revision) return false;
    const success = 'status' in observation;
    const status = success ? observation.status : (before?.status ?? null);
    this.db
      .prepare(`INSERT INTO pack_coding_ancestry_facts
    (repo,base_oid,head_oid,status,fact_revision,observation_revision,observed_at,attempted_at,reason)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,base_oid,head_oid) DO UPDATE SET
    status=excluded.status,fact_revision=excluded.fact_revision,observation_revision=excluded.observation_revision,
    observed_at=excluded.observed_at,attempted_at=excluded.attempted_at,reason=excluded.reason`)
      .run(
        subject.repo,
        subject.baseOid,
        subject.headOid,
        status,
        (before?.fact_revision ?? 0) + (success && status !== before?.status ? 1 : 0),
        revision + 1,
        success ? at : (before?.observed_at ?? null),
        at,
        success ? null : observation.reason
      );
    return true;
  }
}

const collectAncestry = (superpipe({})('coding-ledger-ancestry-refresh') as PipelineAPI)
  .input(['facts', 'subject', 'revision', 'spawn', 'now'])
  .pipe(
    async (subject: Subject, spawn: SpawnFn): Promise<Observation> => {
      const parts = subject.repo.split('/');
      const host = parts.length === 2 ? 'github.com' : parts.shift()!;
      const outcome = await runGhJson(
        [
          'gh',
          'api',
          `repos/${parts.join('/')}/compare/${subject.baseOid}...${subject.headOid}`,
          '--hostname',
          host,
        ],
        homedir(),
        spawn
      );
      const parsed = outcome.ok ? Compare.safeParse(outcome.data) : null;
      log.info('PR ledger ancestry GitHub read', {
        repo: subject.repo,
        lookups: 1,
        ok: parsed?.success === true,
      });
      return !outcome.ok
        ? { reason: 'failed' }
        : parsed?.success
          ? { status: parsed.data.status }
          : { reason: 'partial' };
    },
    ['subject', 'spawn'],
    'observation'
  )
  .pipe(
    (
      facts: CodingAncestryFactsRepository,
      subject: Subject,
      observation: Observation,
      now: () => number,
      revision: number
    ) => facts.observeCurrent(subject, observation, now(), revision),
    ['facts', 'subject', 'observation', 'now', 'revision'],
    'read'
  )
  .endAsync('read') as (
  facts: CodingAncestryFactsRepository,
  subject: Subject,
  revision: number,
  spawn: SpawnFn,
  now: () => number
) => Promise<ReturnType<CodingAncestryFactsRepository['read']>>;
