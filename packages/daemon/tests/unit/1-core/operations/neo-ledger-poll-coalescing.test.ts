import { describe, expect, test } from 'bun:test';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const subject = {
  credentialId: 'opaque-synthetic-a',
  url: 'https://api.github.com/repos/synthetic/ledger/pulls/7/reviews?page=1',
  accept: 'application/vnd.github+json',
  apiVersion: '2022-11-28',
  headOid: 'a'.repeat(40),
};
function setup() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  return { db, facts: new CodingPrLedgerRepository(db).pollFacts };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('ledger polling acquisition coalescing', () => {
  test('separate ledger instances share one in-flight request and receive independently readable clones', async () => {
    const { db, facts } = setup();
    const gate = deferred<Response>();
    let requests = 0;
    const request = () => {
      requests++;
      return gate.promise;
    };
    try {
      const other = new CodingPrLedgerRepository(db).pollFacts;
      const a = facts.acquire(subject, null, request),
        b = other.acquire(subject, null, request);
      await Promise.resolve();
      expect(requests).toBe(1);
      gate.resolve(Response.json([{ id: 7 }], { headers: { etag: '"same-page"' } }));
      const [first, second] = await Promise.all([a, b]);
      expect(first).not.toBe(second);
      first.headers.set('x-local', 'first-only');
      expect(second.headers.get('x-local')).toBeNull();
      expect(await first.json()).toEqual([{ id: 7 }]);
      expect(await second.json()).toEqual([{ id: 7 }]);
      expect(second.headers.get('etag')).toBe('"same-page"');
    } finally {
      db.close();
    }
  });

  test('only an identical credential, request representation, head/base and validator can share', async () => {
    const { db, facts } = setup();
    const gate = deferred<Response>();
    let requests = 0;
    const request = () => {
      requests++;
      return gate.promise;
    };
    try {
      const all = [facts.acquire(subject, null, request)];
      for (const other of [
        { credentialId: 'opaque-synthetic-b' },
        { url: subject.url.replace('page=1', 'page=2') },
        { accept: 'another-representation' },
        { apiVersion: 'another-version' },
        { headOid: 'b'.repeat(40) },
        { baseOid: 'c'.repeat(40) },
      ])
        all.push(facts.acquire({ ...subject, ...other }, null, request));
      all.push(facts.acquire(subject, '"validator-a"', request));
      all.push(facts.acquire(subject, '"validator-b"', request));
      all.push(facts.acquire(subject, '"validator-b"', request));
      await Promise.resolve();
      expect(requests).toBe(9);
      gate.resolve(Response.json([]));
      for (const response of await Promise.all(all)) expect(await response.json()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a rejected request reaches every waiter and does not prevent a later retry', async () => {
    const { db, facts } = setup();
    const gate = deferred<Response>();
    let requests = 0;
    const request = () => {
      requests++;
      return gate.promise;
    };
    try {
      const waiting = Promise.allSettled([
        facts.acquire(subject, null, request),
        facts.acquire(subject, null, request),
      ]);
      await Promise.resolve();
      const error = new Error('Synthetic transport failure');
      gate.reject(error);
      expect(await waiting).toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error },
      ]);
      expect(requests).toBe(1);
      const response = await facts.acquire(subject, null, async () => {
        requests++;
        return Response.json({ recovered: true });
      });
      expect(await response.json()).toEqual({ recovered: true });
      expect(requests).toBe(2);
    } finally {
      db.close();
    }
  });

  test('synchronous transport errors release the acquisition slot too', async () => {
    const { db, facts } = setup();
    try {
      await expect(
        facts.acquire(subject, null, () => {
          throw new Error('Synthetic refusal');
        })
      ).rejects.toThrow('Synthetic refusal');
      expect(
        await (await facts.acquire(subject, null, async () => Response.json([]))).json()
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('completed requests are not cached and different database owners never share', async () => {
    const first = setup(),
      second = setup();
    let requests = 0;
    const request = async () => Response.json({ request: ++requests });
    try {
      const [a, b] = await Promise.all([
        first.facts.acquire(subject, null, request),
        second.facts.acquire(subject, null, request),
      ]);
      expect(await a.json()).toEqual({ request: 1 });
      expect(await b.json()).toEqual({ request: 2 });
      expect(await (await first.facts.acquire(subject, null, request)).json()).toEqual({
        request: 3,
      });
    } finally {
      first.db.close();
      second.db.close();
    }
  });

  test('HTTP errors and 304 status/headers remain visible and collection changes no stored observations', async () => {
    const { db, facts } = setup();
    try {
      facts.record(subject, { value: [{ id: 1 }], etag: '"saved"', next: null }, 100, 0);
      const snapshot = () => db.prepare('SELECT * FROM pack_coding_poll_facts').all();
      const before = snapshot();
      for (const status of [304, 503]) {
        const request = async () =>
          new Response(status === 304 ? null : 'Synthetic unavailable', {
            status,
            headers: { etag: '"saved"', 'retry-after': '60' },
          });
        const responses = await Promise.all([
          facts.acquire(subject, '"saved"', request),
          facts.acquire(subject, '"saved"', request),
        ]);
        for (const response of responses) {
          expect(response.status).toBe(status);
          expect(response.headers.get('retry-after')).toBe('60');
          expect(await response.text()).toBe(status === 304 ? '' : 'Synthetic unavailable');
        }
      }
      expect(snapshot()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
