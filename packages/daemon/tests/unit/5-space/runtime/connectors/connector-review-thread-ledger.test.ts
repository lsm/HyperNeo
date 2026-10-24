import { expect, test, afterEach } from 'bun:test';
import { vi } from 'vitest';
import * as runtimeSpawn from '../../../../../src/lib/runtime-spawn/index.ts';
import type { ConnectorOutcome } from '../../../../../src/lib/github/connectors/connector.ts';

afterEach(() => vi.restoreAllMocks());
import { createNeoCodingReaders } from '../../../../../src/lib/neo/packs/runtime.ts';
import { createCodingPackTables } from '../../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPollFactsRepository } from '../../../../../src/lib/neo/packs/coding/poll-facts.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/threads/pull/7';
const subject = {
  credentialId: 'github-connector',
  url,
  accept: 'application/vnd.hyperneo.pr-review-threads+json',
  apiVersion: 'v1',
};
const page = (
  nodes: unknown[] = [],
  hasNextPage = false,
  endCursor: string | null = null,
  headRefOid = 'a'.repeat(40)
) => ({
  data: {
    repository: {
      pullRequest: {
        url,
        headRefOid,
        reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  },
});
const unresolved = {
  id: 'thread',
  isResolved: false,
  comments: { nodes: [{ url: `${url}#discussion_1` }] },
};
function response(data: unknown): ReturnType<SpawnFn> {
  return {
    stdout: new Response(JSON.stringify(data)).body!,
    stderr: new Response('').body!,
    exited: Promise.resolve(0),
    pid: 12345,
    kill() {},
  } as ReturnType<SpawnFn>;
}
function fixture(spawn: SpawnFn) {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  vi.spyOn(runtimeSpawn, 'spawnProcess').mockImplementation(spawn);
  const read: (url: string, cwd: string) => Promise<ConnectorOutcome> = Reflect.get(
    createNeoCodingReaders(() => db),
    'readReviewThreads'
  );
  return { db, read, facts: new CodingPollFactsRepository(db) };
}

test('concurrent review-thread reads share complete pages and retain restart facts', async () => {
  const calls: string[][] = [];
  const { db, read, facts } = fixture((args) => {
    calls.push(args);
    return response(
      args.includes('cursor=next')
        ? page([{ ...unresolved, isResolved: true }])
        : page([unresolved], true, 'next')
    );
  });
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => read(url, '/tmp')));
    expect(calls).toHaveLength(2);
    expect(results).toEqual(
      Array(5).fill({
        ok: true,
        data: { headOid: 'a'.repeat(40), unresolvedThreadUrls: [`${url}#discussion_1`] },
      })
    );
    const saved = facts.read(subject, 200, Infinity);
    expect(saved.page.status).toBe('known');
    expect(new CodingPollFactsRepository(db).read(subject, 200, Infinity)).toEqual(saved);
    expect(await read(url, '/tmp')).toEqual(results[0]);
    expect(calls).toHaveLength(4);
    expect(facts.read(subject, 200, Infinity).factRevision).toBe(saved.factRevision);
  } finally {
    db.close();
  }
});

test.each(['missing', 'malformed', 'errors', 'cursor', 'cycle', 'head', 'cap'])(
  'incomplete %s refresh cannot certify readiness or replace successful history',
  async (mode) => {
    let broken = false;
    let reads = 0;
    const { db, read, facts } = fixture((args) => {
      reads++;
      if (!broken) return response(page([unresolved]));
      if (mode === 'missing') return response({ data: {} });
      if (mode === 'malformed') return response(page([{ isResolved: 'false' }]));
      if (mode === 'errors')
        return response({ ...page(), errors: [{ message: 'Synthetic permission failure' }] });
      if (mode === 'cursor') return response(page([], true));
      if (mode === 'cycle') return response(page([], true, 'next'));
      if (mode === 'head')
        return response(
          args.includes('cursor=next')
            ? page([], false, null, 'b'.repeat(40))
            : page([], true, 'next')
        );
      return response(page([], true, `next-${reads}`));
    });
    try {
      expect((await read(url, '/tmp')).ok).toBe(true);
      const before = facts.read(subject, 200, Infinity);
      const beforeRow = db.prepare('SELECT value_json FROM pack_coding_poll_facts').get();
      broken = true;
      expect((await read(url, '/tmp')).ok).toBe(false);
      const after = facts.read(subject, 300, Infinity);
      expect(after.page.status).toBe('unknown');
      expect(after.page.observedAt).toBe(before.page.observedAt);
      expect(db.prepare('SELECT value_json FROM pack_coding_poll_facts').get()).toEqual(beforeRow);
      expect(reads).toBeLessThanOrEqual(51);
    } finally {
      db.close();
    }
  }
);

test('invalid thread subjects refuse before opening the DB', async () => {
  const read: (url: string, cwd: string) => Promise<ConnectorOutcome> = Reflect.get(
    createNeoCodingReaders(() => {
      throw new Error('Unexpected DB access');
    }),
    'readReviewThreads'
  );
  for (const identity of ['bad', 'https://foreign.invalid/synthetic/threads/pull/7'])
    expect((await read(identity, '/tmp')).ok).toBe(false);
});

test('GraphQL rate-limit errors remain retryable and cannot certify empty threads', async () => {
  const { db, read, facts } = fixture(() =>
    response({ errors: [{ message: 'API rate limit exceeded' }] })
  );
  try {
    expect(await read(url, '/tmp')).toMatchObject({
      ok: false,
      retryable: true,
      retryAfterMs: 60_000,
    });
    expect(facts.read(subject, 200, Infinity).page).toMatchObject({
      status: 'unknown',
      reason: 'rate_limited',
    });
  } finally {
    db.close();
  }
});

test('a delayed thread read cannot replace a newer persisted observation', async () => {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const { db, read, facts } = fixture(() => {
    const result = response(page());
    result.exited = held.then(() => 0);
    started();
    return result;
  });
  try {
    const pending = read(url, '/tmp');
    await ready;
    expect(
      facts.record(
        subject,
        {
          value: { headOid: 'b'.repeat(40), unresolvedThreadUrls: ['newer'] },
          etag: null,
          next: null,
        },
        300,
        0
      )
    ).toBe(true);
    release();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.stringContaining('superseded'),
    });
    expect(facts.read(subject, 400, Infinity).page.value).toEqual({
      headOid: 'b'.repeat(40),
      unresolvedThreadUrls: ['newer'],
    });
  } finally {
    release();
    db.close();
  }
});
