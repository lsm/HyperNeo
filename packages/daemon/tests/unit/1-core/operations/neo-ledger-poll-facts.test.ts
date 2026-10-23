import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const subject = {
  credentialId: 'synthetic-credential-a',
  url: 'https://api.github.com/repos/synthetic/ledger/pulls/7/reviews?page=1',
  accept: 'application/vnd.github+json',
  headOid: 'a'.repeat(40),
};
const first = { value: [{ id: 1, state: 'APPROVED' }], etag: '"page-a"', next: null };
function setup(path = ':memory:') {
  const db = new Database(path);
  createCodingPackTables(db);
  return { db, facts: new CodingPrLedgerRepository(db).pollFacts };
}

describe('ledger polling page facts', () => {
  test('a covered empty page is known only for its exact request identity', () => {
    const { db, facts } = setup();
    try {
      expect(facts.read(subject, 100, 10)).toMatchObject({
        factRevision: 0,
        observationRevision: 0,
        page: { status: 'unknown', reason: 'missing' },
      });
      expect(facts.record(subject, { ...first, value: [] }, 100, 0)).toBe(true);
      expect(facts.read(subject, 105, 10)).toMatchObject({
        page: { status: 'known', value: [], observedAt: 100, etag: first.etag, next: null },
      });
      for (const other of [
        { credentialId: 'synthetic-credential-b' },
        { url: subject.url.replace('page=1', 'page=2') },
        { accept: 'application/vnd.github.raw+json' },
        { headOid: 'b'.repeat(40) },
        { baseOid: 'c'.repeat(40) },
      ]) {
        expect(facts.read({ ...subject, ...other }, 105, 10).page).toMatchObject({
          status: 'unknown',
          reason: 'missing',
        });
      }
      expect(facts.read(subject, 111, 10).page).toMatchObject({
        status: 'unknown',
        reason: 'stale',
        observedAt: 100,
        attemptedAt: 100,
      });
    } finally {
      db.close();
    }
  });

  test('page continuation is retained without claiming the collection is complete', () => {
    const { db, facts } = setup();
    try {
      const next = subject.url.replace('page=1', 'page=2');
      facts.record(subject, { ...first, next }, 100, 0);
      expect(facts.read(subject, 100, 10).page).toMatchObject({
        status: 'known',
        value: first.value,
        next,
      });
      expect(facts.read({ ...subject, url: next }, 100, 10).page.status).toBe('unknown');
    } finally {
      db.close();
    }
  });

  test('unchanged payload and coverage retain fact revision; A to B to A does not', () => {
    const { db, facts } = setup();
    try {
      facts.record(subject, first, 100, 0);
      const a = facts.read(subject, 100, 10);
      facts.record(subject, { ...first, etag: '"new-validator"' }, 110, 1);
      expect(facts.read(subject, 110, 10)).toMatchObject({
        factRevision: a.factRevision,
        observationRevision: 2,
        page: { status: 'known', observedAt: 110, etag: '"new-validator"' },
      });
      facts.record(subject, { ...first, value: [] }, 120, 2);
      expect(facts.read(subject, 120, 10).factRevision).toBe(a.factRevision + 1);
      facts.record(subject, first, 130, 3);
      expect(facts.read(subject, 130, 10).factRevision).toBe(a.factRevision + 2);
      facts.record(subject, { ...first, next: subject.url + '&continuation=1' }, 140, 4);
      expect(facts.read(subject, 140, 10).factRevision).toBe(a.factRevision + 3);
    } finally {
      db.close();
    }
  });

  for (const reason of ['failed', 'partial', 'rate_limited', 'not_authorized'] as const) {
    test(`latest ${reason} stays unknown without losing last successful page bytes`, () => {
      const { db, facts } = setup();
      try {
        facts.record(subject, first, 100, 0);
        facts.record(subject, { reason }, 110, 1);
        expect(facts.read(subject, 110, 100)).toMatchObject({
          factRevision: 1,
          observationRevision: 2,
          page: { status: 'unknown', reason, observedAt: 100, attemptedAt: 110 },
        });
        const row = db.prepare('SELECT value_json FROM pack_coding_poll_facts').get() as {
          value_json: string;
        };
        expect(JSON.parse(row.value_json)).toEqual(first.value);
        facts.record(subject, first, 120, 2);
        expect(facts.read(subject, 120, 10)).toMatchObject({
          factRevision: 1,
          observationRevision: 3,
          page: { status: 'known', observedAt: 120 },
        });
      } finally {
        db.close();
      }
    });
  }

  test('304 freshness requires the matching stored validator for this exact page', () => {
    const { db, facts } = setup();
    try {
      facts.record(subject, { notModified: first.etag }, 90, 0);
      expect(facts.read(subject, 90, 10).page).toMatchObject({
        status: 'unknown',
        reason: 'partial',
      });
      facts.record(subject, first, 100, 1);
      facts.record(subject, { notModified: '"wrong-page"' }, 110, 2);
      expect(facts.read(subject, 110, 100).page).toMatchObject({
        status: 'unknown',
        reason: 'partial',
        observedAt: 100,
      });
      facts.record(subject, { notModified: first.etag }, 120, 3);
      expect(facts.read(subject, 120, 10)).toMatchObject({
        factRevision: 1,
        observationRevision: 4,
        page: { status: 'known', observedAt: 120, value: first.value },
      });
      facts.record(
        { ...subject, credentialId: 'synthetic-credential-b' },
        { notModified: first.etag },
        120,
        0
      );
      expect(
        facts.read({ ...subject, credentialId: 'synthetic-credential-b' }, 120, 10).page.status
      ).toBe('unknown');
    } finally {
      db.close();
    }
  });

  test('restart retains coverage and late acquisitions cannot replace a newer observation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-poll-facts-'));
    let current = setup(join(dir, 'facts.db'));
    try {
      current.facts.record(subject, first, 100, 0);
      const saved = current.facts.read(subject, 100, 10);
      current.db.close();
      current = setup(join(dir, 'facts.db'));
      expect(current.facts.read(subject, 100, 10)).toEqual(saved);
      expect(current.facts.record(subject, { ...first, value: [] }, 120, 0)).toBe(false);
      expect(current.facts.record(subject, { reason: 'failed' }, 130, 0)).toBe(false);
      expect(current.facts.read(subject, 100, 10)).toEqual(saved);
    } finally {
      current.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
