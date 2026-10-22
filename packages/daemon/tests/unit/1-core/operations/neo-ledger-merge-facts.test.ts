import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Merge = { state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeCommit: string | null };
type Outcome = { value: Merge; source: string } | { reason: 'failed' | 'partial' | 'rate_limited' };
type Read = {
  repo: string;
  number: number;
  factRevision: number;
  observationRevision: number;
  merge: {
    status: string;
    value?: Merge;
    reason?: string;
    observedAt?: number;
    attemptedAt?: number;
    source?: string;
  };
};
type Store = {
  record(
    repo: string,
    number: number,
    outcome: Outcome,
    at: number,
    expectedRevision: number
  ): boolean;
  read(repo: string, number: number, now: number, maxAgeMs: number): Read;
};
const repo = 'synthetic/ledger',
  source = 'github-pr-detail',
  merged = { state: 'MERGED', mergeCommit: 'c'.repeat(40) } as const;
function setup(path = ':memory:') {
  const db = new Database(path);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const facts = (ledger as CodingPrLedgerRepository & { mergeFacts: Store }).mergeFacts;
  return { db, ledger, facts };
}

describe('ledger merge facts', () => {
  test('missing is unknown; a covered empty merge commit is known, not a completed merge', () => {
    const { db, facts } = setup();
    try {
      expect(facts.read(repo, 7, 100, 10)).toMatchObject({
        repo,
        number: 7,
        factRevision: 0,
        observationRevision: 0,
        merge: { status: 'unknown', reason: 'missing' },
      });
      expect(
        facts.record(repo, 7, { value: { state: 'OPEN', mergeCommit: null }, source }, 100, 0)
      ).toBe(true);
      expect(facts.read(repo, 7, 105, 10)).toMatchObject({
        merge: {
          status: 'known',
          value: { state: 'OPEN', mergeCommit: null },
          observedAt: 100,
          source,
        },
      });
      expect(facts.read(repo, 7, 111, 10).merge).toEqual({
        status: 'unknown',
        reason: 'stale',
        attemptedAt: 100,
        observedAt: 100,
      });
    } finally {
      db.close();
    }
  });

  test('successful unchanged refreshes advance observation, not fact revision', () => {
    const { db, facts } = setup();
    try {
      facts.record(repo, 7, { value: merged, source }, 100, 0);
      const first = facts.read(repo, 7, 100, 10);
      facts.record(
        repo,
        7,
        { value: { mergeCommit: merged.mergeCommit, state: merged.state }, source },
        200,
        first.observationRevision
      );
      const repeat = facts.read(repo, 7, 205, 10);
      expect(repeat.factRevision).toBe(first.factRevision);
      expect(repeat.observationRevision).toBeGreaterThan(first.observationRevision);
      expect(repeat.merge).toMatchObject({ status: 'known', observedAt: 200, value: merged });
      facts.record(
        repo,
        7,
        { value: { state: 'CLOSED', mergeCommit: null }, source },
        210,
        repeat.observationRevision
      );
      expect(facts.read(repo, 7, 210, 10).factRevision).toBeGreaterThan(first.factRevision);
    } finally {
      db.close();
    }
  });

  for (const reason of ['failed', 'partial', 'rate_limited'] as const)
    test(`latest ${reason} reads unknown while prior successful bytes remain`, () => {
      const { db, facts } = setup();
      try {
        facts.record(repo, 7, { value: merged, source }, 100, 0);
        const first = facts.read(repo, 7, 100, 100);
        facts.record(repo, 7, { reason }, 110, first.observationRevision);
        const after = facts.read(repo, 7, 111, 100);
        expect(after.factRevision).toBe(first.factRevision);
        expect(after.merge).toEqual({
          status: 'unknown',
          reason,
          observedAt: 100,
          attemptedAt: 110,
        });
        const stored = db
          .prepare('SELECT value_json FROM pack_coding_merge_facts WHERE repo = ? AND number = ?')
          .get(repo, 7) as { value_json: string };
        expect(JSON.parse(stored.value_json)).toEqual(merged);
        expect(
          facts.record(repo, 7, { value: merged, source }, 120, after.observationRevision)
        ).toBe(true);
        expect(facts.read(repo, 7, 120, 10)).toMatchObject({
          factRevision: first.factRevision,
          merge: { status: 'known', value: merged },
        });
      } finally {
        db.close();
      }
    });

  test('a late acquisition cannot replace a newer result, including after reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-merge-facts-'));
    let current = setup(join(dir, 'facts.db'));
    try {
      const old = current.facts.read(repo, 7, 100, 10);
      expect(
        current.facts.record(repo, 7, { value: merged, source }, 110, old.observationRevision)
      ).toBe(true);
      const fresh = current.facts.read(repo, 7, 110, 10);
      current.db.close();
      current = setup(join(dir, 'facts.db'));
      expect(
        current.facts.record(
          repo,
          7,
          { value: { state: 'OPEN', mergeCommit: null }, source },
          120,
          old.observationRevision
        )
      ).toBe(false);
      expect(current.facts.read(repo, 7, 110, 10)).toEqual(fresh);
      expect(
        current.facts.record(repo, 7, { reason: 'failed' }, 130, old.observationRevision)
      ).toBe(false);
      expect(current.facts.read(repo, 7, 110, 10)).toEqual(fresh);
    } finally {
      current.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('canonical aliases share revisions and different PRs do not', () => {
    const { db, ledger, facts } = setup();
    try {
      ledger.recordAlias('synthetic/old', repo);
      expect(facts.record('Synthetic/Old', 7, { value: merged, source }, 100, 0)).toBe(true);
      expect(facts.read(repo.toUpperCase(), 7, 100, 10)).toEqual(
        facts.read('synthetic/old', 7, 100, 10)
      );
      expect(facts.read(repo, 8, 100, 10).merge).toMatchObject({ reason: 'missing' });
      expect(facts.record(repo, 7, { value: merged, source }, 101, 0)).toBe(false);
    } finally {
      db.close();
    }
  });
});
