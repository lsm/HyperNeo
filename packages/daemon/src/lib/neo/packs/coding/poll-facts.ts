import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { callCodingBranchDb } from './branch-facts-db.ts';
import { codingPollPageReads, codingPollPageWrites } from './poll-http-db.ts';
import { collectPollHttp } from './poll-http.ts';
import { pollHttpMetadata, type CodingPollHttpMetadata } from './poll-http-metadata.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { canonicalJson } from '../../../agent/prompt-comparison.ts';

type Subject = {
  credentialId: string;
  url: string;
  accept: string;
  apiVersion: string;
  headOid?: string;
  baseOid?: string;
};
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Reason = 'failed' | 'partial' | 'rate_limited' | 'not_authorized';
type Observation =
  | { value: Json; etag: string | null; next: string | null; http?: CodingPollHttpMetadata }
  | { notModified: string; http?: CodingPollHttpMetadata }
  | { reason: Reason };
type Row = {
  http_json: string | null;
  fact_revision: number;
  observation_revision: number;
  value_json: string | null;
  etag: string | null;
  next_url: string | null;
  observed_at: number | null;
  attempted_at: number;
  reason: Reason | null;
};

const acquisitions = new WeakMap<Database, Map<string, Promise<Response>>>();

function pageKey(subject: Subject): string {
  return JSON.stringify([
    subject.credentialId,
    subject.url,
    subject.accept,
    subject.apiVersion,
    subject.headOid ?? null,
    subject.baseOid ?? null,
  ]);
}
function loadPage(db: Database, key: string): Row | undefined {
  return db.prepare('SELECT * FROM pack_coding_poll_facts WHERE subject=?').get(key) as
    | Row
    | undefined;
}
function projectPage(subject: Subject, row: Row | undefined, now: number, maxAgeMs: number) {
  const reason = !row
    ? 'missing'
    : (row.reason ??
      (row.observed_at === null || now - row.observed_at > maxAgeMs ? 'stale' : null));
  return {
    subject,
    factRevision: row?.fact_revision ?? 0,
    observationRevision: row?.observation_revision ?? 0,
    page: reason
      ? {
          status: 'unknown' as const,
          reason,
          observedAt: row?.observed_at ?? null,
          attemptedAt: row?.attempted_at ?? null,
        }
      : {
          status: 'known' as const,
          http: row!.http_json ? (JSON.parse(row!.http_json) as CodingPollHttpMetadata) : null,
          value: JSON.parse(row!.value_json!) as Json,
          etag: row!.etag,
          next: row!.next_url,
          observedAt: row!.observed_at!,
        },
  };
}
const readPage = (superpipe({})('coding-ledger-poll-page-read') as PipelineAPI)
  .input(['db', 'subject', 'now', 'maxAgeMs'])
  .pipe(pageKey, ['subject'], 'key')
  .pipe(loadPage, ['db', 'key'], 'row')
  .pipe(projectPage, ['subject', 'row', 'now', 'maxAgeMs'], 'facts')
  .end('facts') as (
  db: Database,
  subject: Subject,
  now: number,
  maxAgeMs: number
) => ReturnType<typeof projectPage>;

export class CodingPollFactsRepository {
  constructor(
    private readonly db: Database,
    private readonly externalEventPollIntervalMs = 0
  ) {}

  read(subject: Subject, now: number, maxAgeMs: number) {
    return readPage(this.db, subject, now, maxAgeMs);
  }

  readCurrent(subject: Subject, at: number, maxAgeMs: number) {
    return callCodingBranchDb(
      () => gatewayFor(this.db).call(codingPollPageReads, 'read', subject, at, maxAgeMs),
      'coding.pollPage.db'
    );
  }

  observeCurrent(subject: Subject, observation: Observation, at: number, revision: number) {
    return callCodingBranchDb(
      () =>
        gatewayFor(this.db).call(
          codingPollPageWrites,
          'observe',
          subject,
          observation,
          at,
          revision
        ),
      'coding.pollPage.db'
    );
  }

  collect(
    subject: Subject,
    cycle: string,
    validator: string | null,
    request: (validator: string | null) => Promise<Response>,
    now = Date.now
  ) {
    return collectPollHttp(this, subject, cycle, validator, request, now);
  }

  async collectExternalEventPage(...args: Parameters<CodingPollFactsRepository['collect']>) {
    const [subject, cycle, validator, request, now = Date.now] = args;
    await callCodingBranchDb(
      () =>
        gatewayFor(this.db).call(
          codingPollPageWrites,
          'prune',
          now() - Math.max(15 * 60_000, 2 * this.externalEventPollIntervalMs)
        ),
      'coding.pollPage.prune'
    );
    return this.collect(
      { ...subject, credentialId: `external-event-page:v1:${subject.credentialId}` },
      cycle,
      validator,
      request,
      now
    );
  }

  pruneExternalEventPages(before: number) {
    return this.db
      .prepare(`DELETE FROM pack_coding_poll_facts WHERE attempted_at < ?
      AND json_extract(subject,'$[0]') GLOB 'external-event-page:v1:*'`)
      .run(before).changes;
  }

  async acquire(
    subject: Subject,
    validator: string | null,
    request: () => Promise<Response>
  ): Promise<Response> {
    return this.shareResponse(JSON.stringify(['request', pageKey(subject), validator]), request);
  }

  acquireObservation(subject: Subject, validator: string | null, request: () => Promise<Response>) {
    return this.shareResponse(
      JSON.stringify(['observation', pageKey(subject), validator]),
      request
    );
  }

  private async shareResponse(key: string, request: () => Promise<Response>): Promise<Response> {
    const active = acquisitions.get(this.db) ?? new Map<string, Promise<Response>>();
    acquisitions.set(this.db, active);
    let pending = active.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(request)
        .finally(() => active.delete(key));
      active.set(key, pending);
    }
    return (await pending).clone() as Response;
  }

  record(
    subject: Subject,
    observation: Observation,
    at: number,
    expectedRevision: number
  ): boolean {
    return this.db.transaction(() => {
      const key = pageKey(subject),
        before = loadPage(this.db, key);
      if ((before?.observation_revision ?? 0) !== expectedRevision) return false;
      const fresh = 'value' in observation;
      const validated =
        'notModified' in observation &&
        !!observation.notModified &&
        before?.value_json != null &&
        before.etag === observation.notModified;
      const success = fresh || validated;
      const beforeHttp = before?.http_json
        ? (JSON.parse(before.http_json) as CodingPollHttpMetadata)
        : null;
      const inputHttp = 'http' in observation ? observation.http : undefined;
      const http = fresh
        ? (inputHttp ?? null)
        : validated && inputHttp
          ? {
              ...inputHttp,
              status: beforeHttp?.status ?? 200,
              headers: {
                ...Object.fromEntries(
                  Object.entries(beforeHttp?.headers ?? {}).filter(
                    ([name]) => name === 'etag' || name === 'last-modified'
                  )
                ),
                ...inputHttp.headers,
              },
            }
          : beforeHttp;
      const cleanedHttp = http ? pollHttpMetadata(http.cycle, http.status, http.headers) : null;
      const value = fresh ? canonicalJson(observation.value) : (before?.value_json ?? null);
      const next = fresh ? observation.next : (before?.next_url ?? null);
      const changed = fresh && (value !== before?.value_json || next !== before?.next_url);
      this.db
        .prepare(`INSERT INTO pack_coding_poll_facts
        (subject,fact_revision,observation_revision,value_json,etag,next_url,observed_at,attempted_at,reason,http_json)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET
        fact_revision=excluded.fact_revision, observation_revision=excluded.observation_revision,
        value_json=excluded.value_json, etag=excluded.etag, next_url=excluded.next_url,
        observed_at=excluded.observed_at, attempted_at=excluded.attempted_at, reason=excluded.reason, http_json=excluded.http_json`)
        .run(
          key,
          (before?.fact_revision ?? 0) + (changed ? 1 : 0),
          expectedRevision + 1,
          value,
          fresh
            ? observation.etag
            : validated
              ? (cleanedHttp?.headers.etag ?? before?.etag ?? null)
              : (before?.etag ?? null),
          next,
          success ? at : (before?.observed_at ?? null),
          at,
          success ? null : 'reason' in observation ? observation.reason : 'partial',
          cleanedHttp ? JSON.stringify(cleanedHttp) : null
        );
      return true;
    }, 'immediate')();
  }
}
