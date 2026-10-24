import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNeoCodingReaders } from '../../../../../src/lib/neo/packs/runtime.ts';

test('ledger connector PR acquisition preserves payload, freshness and failure history', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'connector-pr-ledger-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../../.claude/skills/verify/github-ledger-connector-get-pr.ts',
            import.meta.url
          )
        ),
        run,
      ],
      {
        env: {
          HOME: join(run, 'home'),
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    const proof = JSON.parse(readFileSync(join(run, 'evidence/connector-pr.json'), 'utf8'));
    expect(proof.verified).toBe(true);
    expect(proof.coldReads).toBe(1);
    expect(proof.historyPreserved).toBe(true);
    expect(proof.productionConnectorWired).toBe(false);
    expect(proof.counts).toEqual({
      cold: 1,
      repeat: 1,
      merged: 1,
      failed: 1,
      partial: 1,
      recovered: 1,
      alias: 1,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('invalid and foreign PR identities fail before DB or GitHub access', async () => {
  const read = createNeoCodingReaders(() => {
    throw new Error('Unexpected database access');
  }).readConnectorPr;
  for (const url of ['not-a-pr', 'https://untrusted.invalid/synthetic/repo/pull/7']) {
    const result = await read(url, '/tmp');
    expect(result.ok).toBe(false);
  }
});

import { createCodingConnectorPrReader } from '../../../../../src/lib/neo/packs/coding/connector-pr-reader.ts';
import { CodingPollFactsRepository } from '../../../../../src/lib/neo/packs/coding/poll-facts.ts';
import { createCodingPackTables } from '../../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ledger/pull/7';
const view = { url, state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
const subject = {
  credentialId: 'github-connector',
  url,
  accept: 'application/vnd.hyperneo.pr-basic+json',
  apiVersion: 'v1',
};
function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  return { db, facts: new CodingPollFactsRepository(db) };
}
function response(data: unknown, exitCode = 0, stderr = ''): ReturnType<SpawnFn> {
  return {
    stdout: new Response(JSON.stringify(data)).body!,
    stderr: new Response(stderr).body!,
    exited: Promise.resolve(exitCode),
    pid: 12345,
    kill() {},
  } as ReturnType<SpawnFn>;
}

test('mismatched PR identity cannot certify the requested subject', async () => {
  const { db, facts } = fixture();
  try {
    const read = createCodingConnectorPrReader(
      () => db,
      () => response({ ...view, url: 'https://github.com/synthetic/ledger/pull/8' }),
      () => 100
    );
    expect(await read(url, '/tmp')).toEqual({
      ok: false,
      error: 'GitHub connector PR facts unavailable: partial',
    });
    expect(facts.read(subject, 100, Infinity).page.status).toBe('unknown');
  } finally {
    db.close();
  }
});

test('unchanged UNKNOWN mergeability is data and survives reader reconstruction', async () => {
  const { db, facts } = fixture();
  try {
    const spawn: SpawnFn = () => response(view);
    expect(
      await createCodingConnectorPrReader(
        () => db,
        spawn,
        () => 100
      )(url, '/tmp')
    ).toEqual({ ok: true, data: view });
    const before = facts.read(subject, 100, Infinity);
    expect(
      await createCodingConnectorPrReader(
        () => db,
        spawn,
        () => 200
      )(url, '/tmp')
    ).toEqual({ ok: true, data: view });
    const after = facts.read(subject, 200, Infinity);
    expect(after.factRevision).toBe(before.factRevision);
    expect(after.observationRevision).toBe(before.observationRevision + 1);
    expect(after.page.status).toBe('known');
    expect(after.page.observedAt).toBe(200);
  } finally {
    db.close();
  }
});

test('rate-limited acquisition keeps the existing retryable connector outcome', async () => {
  const { db, facts } = fixture();
  let calls = 0;
  try {
    const spawn: SpawnFn = () =>
      ++calls === 1
        ? response(null, 1, 'HTTP 403: rate limit exceeded')
        : response({ resources: { graphql: { reset: 0 } } });
    const result = await createCodingConnectorPrReader(
      () => db,
      spawn,
      () => 100
    )(url, '/tmp');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    expect(facts.read(subject, 100, Infinity).page.status).toBe('unknown');
  } finally {
    db.close();
  }
});

test('a delayed acquisition cannot replace a newer persisted observation', async () => {
  const { db, facts } = fixture();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    called = new Promise<void>((resolve) => {
      started = resolve;
    });
  const spawn: SpawnFn = () => {
    started();
    return { ...response(view), exited: held.then(() => 0) };
  };
  try {
    const pending = createCodingConnectorPrReader(
      () => db,
      spawn,
      () => 100
    )(url, '/tmp');
    await called;
    const newer = { ...view, state: 'MERGED' };
    expect(facts.record(subject, { value: newer, etag: null, next: null }, 200, 0)).toBe(true);
    release();
    expect(await pending).toEqual({
      ok: false,
      error: 'GitHub connector PR observation superseded',
    });
    const saved = facts.read(subject, 200, Infinity);
    expect(saved.page.status).toBe('known');
    if (saved.page.status === 'known') expect(saved.page.value).toEqual(newer);
  } finally {
    release();
    db.close();
  }
});
