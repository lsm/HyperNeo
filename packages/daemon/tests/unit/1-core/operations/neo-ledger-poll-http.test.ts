import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const subject = {
  credentialId: 'opaque-synthetic',
  url: 'https://api.github.com/repos/synthetic/ledger/pulls?page=1',
  accept: 'application/vnd.github+json',
  apiVersion: '2022-11-28',
};
function setup() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  return { db, facts: new CodingPrLedgerRepository(db).pollFacts };
}
const response = (remaining = '100') =>
  Response.json([{ id: 7 }], {
    headers: {
      etag: '"page"',
      'x-ratelimit-remaining': remaining,
      authorization: 'SYNTHETIC_OMIT_THIS_HEADER',
      'set-cookie': 'SYNTHETIC_OMIT_COOKIE',
      'x-unlisted': 'SYNTHETIC_OMIT_UNLISTED',
      link: '<https://api.github.com/repos/synthetic/ledger/pulls?page=2>; rel="next"',
    },
  });

describe('ledger HTTP polling pages', () => {
  test('old-schema migration adds nullable metadata without rewriting old rows or values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'old-poll-facts-'));
    const path = join(dir, 'old.db');
    let db = new Database(path);
    try {
      db.exec(`CREATE TABLE pack_coding_poll_facts (
        subject TEXT PRIMARY KEY CHECK(json_valid(subject)), fact_revision INTEGER NOT NULL,
        observation_revision INTEGER NOT NULL, value_json TEXT, etag TEXT, next_url TEXT,
        observed_at INTEGER, attempted_at INTEGER NOT NULL, reason TEXT)`);
      db.prepare('INSERT INTO pack_coding_poll_facts VALUES (?,?,?,?,?,?,?,?,?)').run(
        '["old-row"]',
        11,
        17,
        ' { "kept" : true } ',
        '"old"',
        null,
        100,
        110,
        'failed'
      );
      const before = db.prepare('SELECT * FROM pack_coding_poll_facts').all();
      createCodingPackTables(db);
      createCodingPackTables(db);
      const after = db.prepare('SELECT * FROM pack_coding_poll_facts').all();
      expect(after).toEqual(before.map((row) => ({ ...row, http_json: null })));
      db.close();
      db = new Database(path);
      createCodingPackTables(db);
      expect(db.prepare('SELECT * FROM pack_coding_poll_facts').all()).toEqual(after);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('metadata stores only allow-listed rate/validator headers and never changes fact revision', () => {
    const { db, facts } = setup();
    try {
      const http = {
        cycle: 'first-cycle',
        status: 200,
        headers: Object.fromEntries(response().headers),
      };
      facts.record(subject, { value: [], etag: '"page"', next: null, http }, 100, 0);
      const first = facts.read(subject, 100, 100);
      expect(first.page).toMatchObject({
        status: 'known',
        http: {
          cycle: 'first-cycle',
          status: 200,
          headers: { etag: '"page"', 'x-ratelimit-remaining': '100' },
        },
      });
      const stored = JSON.stringify(db.prepare('SELECT * FROM pack_coding_poll_facts').all());
      expect(stored).not.toContain('SYNTHETIC_OMIT');
      facts.record(
        subject,
        {
          value: [],
          etag: '"page"',
          next: null,
          http: { ...http, cycle: 'second-cycle', headers: { 'x-ratelimit-remaining': '99' } },
        },
        110,
        1
      );
      expect(facts.read(subject, 110, 100)).toMatchObject({
        factRevision: first.factRevision,
        observationRevision: 2,
      });
    } finally {
      db.close();
    }
  });

  test('same-cycle pages are reused sequentially with rate and next-page coverage; later cycles refresh', async () => {
    const { db, facts } = setup();
    let calls = 0;
    const request = async () => {
      calls++;
      return response();
    };
    try {
      expect(
        await (await facts.collect(subject, 'cycle-a', null, request, () => 100)).json()
      ).toEqual([{ id: 7 }]);
      const cached = await facts.collect(subject, 'cycle-a', null, request, () => 101);
      expect(await cached.json()).toEqual([{ id: 7 }]);
      expect(cached.headers.get('x-ratelimit-remaining')).toBe('100');
      expect(cached.headers.get('link')).toContain('page=2');
      expect(cached.headers.get('authorization')).toBeNull();
      expect(calls).toBe(1);
      await (await facts.collect(subject, 'cycle-b', null, request, () => 110)).text();
      expect(calls).toBe(2);
      expect(facts.read(subject, 110, 100).factRevision).toBe(1);
    } finally {
      db.close();
    }
  });

  test('a valid 304 refreshes its metadata without changing the fact; mismatched validators stay unknown', async () => {
    const { db, facts } = setup();
    try {
      await (
        await facts.collect(
          subject,
          'cycle-a',
          null,
          async () => response(),
          () => 100
        )
      ).text();
      const request = async () =>
        new Response(null, {
          status: 304,
          headers: { etag: '"new-page"', 'x-ratelimit-remaining': '90' },
        });
      expect((await facts.collect(subject, 'cycle-b', '"page"', request, () => 110)).status).toBe(
        304
      );
      const cached = await facts.collect(
        subject,
        'cycle-b',
        '"new-page"',
        async () => {
          throw new Error('Should reuse observed page');
        },
        () => 111
      );
      expect(await cached.json()).toEqual([{ id: 7 }]);
      expect(cached.headers.get('etag')).toBe('"new-page"');
      expect(facts.read(subject, 111, 100).factRevision).toBe(1);
      await facts.collect(subject, 'cycle-c', '"wrong"', request, () => 120);
      expect(facts.read(subject, 120, 100).page).toMatchObject({
        status: 'unknown',
        reason: 'partial',
        observedAt: 110,
      });
    } finally {
      db.close();
    }
  });

  test('unreadable responses cannot certify cached coverage and retain previous successful bytes', async () => {
    const { db, facts } = setup();
    try {
      await (
        await facts.collect(
          subject,
          'cycle-a',
          null,
          async () => response(),
          () => 100
        )
      ).text();
      for (const [status, reason] of [
        [503, 'failed'],
        [401, 'not_authorized'],
        [429, 'rate_limited'],
      ] as const) {
        const failed = await facts.collect(
          subject,
          `cycle-${status}`,
          null,
          async () => new Response('Synthetic unavailable', { status }),
          () => 110
        );
        expect(failed.status).toBe(status);
        await failed.text();
        expect(facts.read(subject, 110, 100).page).toMatchObject({
          status: 'unknown',
          reason,
          observedAt: 100,
        });
      }
      await expect(
        facts.collect(
          subject,
          'bad-json',
          null,
          async () => new Response('not-json'),
          () => 120
        )
      ).rejects.toThrow();
      expect(facts.read(subject, 120, 100).page).toMatchObject({
        status: 'unknown',
        reason: 'partial',
      });
      const row = db.prepare('SELECT value_json FROM pack_coding_poll_facts').get() as {
        value_json: string;
      };
      expect(JSON.parse(row.value_json)).toEqual([{ id: 7 }]);
    } finally {
      db.close();
    }
  });

  test('late response consumers cannot replace or return a newer cycle as their own', async () => {
    const { db, facts } = setup();
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((done) => {
      release = done;
    });
    try {
      const old = facts.collect(
        subject,
        'old-cycle',
        null,
        () => gate,
        () => 100
      );
      await Promise.resolve();
      const fresh = await facts.collect(
        subject,
        'new-cycle',
        '"new"',
        async () => response('80'),
        () => 110
      );
      await fresh.text();
      release(Response.json([{ id: 1 }]));
      await expect(old).rejects.toThrow('superseded');
      expect(facts.read(subject, 110, 100).page).toMatchObject({
        status: 'known',
        value: [{ id: 7 }],
        http: { cycle: 'new-cycle' },
      });
    } finally {
      db.close();
    }
  });
});
