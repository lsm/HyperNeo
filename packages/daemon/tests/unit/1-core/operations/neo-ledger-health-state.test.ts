import { describe, expect, test } from 'bun:test';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const repo = 'synthetic/health';
function using(run: (db: Database, ledger: CodingPrLedgerRepository) => void) {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  try {
    run(db, new CodingPrLedgerRepository(db));
  } finally {
    db.close();
  }
}

describe('durable repository cycle health', () => {
  test('timestamps a changed cooldown error once and retains it after recovery', () =>
    using((_db, ledger) => {
      ledger.recordHealth(repo, { at: 100, outcome: 'failed', error: 'lookup_failed' });
      for (const at of [200, 300])
        expect(
          ledger.recordHealth(repo, {
            at,
            outcome: 'cooldown',
            retryAt: 1000,
            error: 'rate_limited',
          })
        ).toMatchObject({ lastError: 'rate_limited', lastErrorAt: 200 });
      expect(ledger.recordHealth(repo, { at: 1000, outcome: 'complete' })).toMatchObject({
        lastError: 'rate_limited',
        lastErrorAt: 200,
        nextRetryAt: null,
      });
    }));

  test('missing health is unknown and an unreached repository has no invented attempt', () =>
    using((_db, ledger) => {
      expect(ledger.health).toBeDefined();
      expect(ledger.health.read(repo)).toBeNull();
      expect(ledger.recordHealth(repo, { at: 100, outcome: 'not_reached' })).toMatchObject({
        cycleAt: 100,
        attemptedAt: null,
        completeAt: null,
        misses: 1,
        firstMissAt: 100,
        reason: 'not_reached',
        incident: null,
      });
    }));
  test('three eligible misses raise one stable incident and preserve partial attempts', () =>
    using((_db, ledger) => {
      ledger.recordHealth(repo, { at: 100, outcome: 'not_reached' });
      ledger.recordHealth(repo, { at: 200, outcome: 'partial' });
      const third = ledger.recordHealth(repo, { at: 300, outcome: 'failed' });
      expect(third).toMatchObject({
        attemptedAt: 300,
        completeAt: null,
        misses: 3,
        firstMissAt: 100,
        incident: { key: 'github-health:synthetic/health:100', raisedAt: 300, resolvedAt: null },
      });
      expect(ledger.recordHealth(repo, { at: 400, outcome: 'failed' }).incident).toEqual(
        third.incident
      );
    }));
  test('cooldown records retry time without counting an eligible miss or resolving an incident', () =>
    using((_db, ledger) => {
      for (const at of [100, 200, 300]) ledger.recordHealth(repo, { at, outcome: 'failed' });
      expect(
        ledger.recordHealth(repo, { at: 400, outcome: 'cooldown', retryAt: 1000 })
      ).toMatchObject({
        attemptedAt: 300,
        completeAt: null,
        misses: 3,
        reason: 'cooldown',
        nextRetryAt: 1000,
        incident: { resolvedAt: null },
      });
    }));
  test('complete empty coverage recovers once, while a later incident gets a new identity', () =>
    using((db, ledger) => {
      expect(db.prepare('SELECT * FROM pack_coding_pr_ledger').all()).toEqual([]);
      for (const at of [100, 200, 300]) ledger.recordHealth(repo, { at, outcome: 'not_reached' });
      const healed = ledger.recordHealth(repo, { at: 400, outcome: 'complete' });
      expect(healed).toMatchObject({
        attemptedAt: 400,
        completeAt: 400,
        misses: 0,
        firstMissAt: null,
        nextRetryAt: null,
        incident: { resolvedAt: 400 },
      });
      expect(ledger.recordHealth(repo, { at: 500, outcome: 'complete' }).incident).toEqual(
        healed.incident
      );
      for (const at of [600, 700, 800]) ledger.recordHealth(repo, { at, outcome: 'not_reached' });
      expect(ledger.health.read(repo)?.incident?.key).toBe('github-health:synthetic/health:600');
      expect(healed.incident?.resolvedAt).toBe(400);
    }));
  test('duplicate and older finalized cycles cannot alter stored bytes, including after reopening the repository object', () =>
    using((db, ledger) => {
      ledger.recordHealth(repo.toUpperCase(), { at: 300, outcome: 'partial' });
      const before = db.prepare('SELECT * FROM pack_coding_repo_health').all();
      const reopened = new CodingPrLedgerRepository(db);
      for (const at of [300, 299]) reopened.recordHealth(repo, { at, outcome: 'complete' });
      expect(db.prepare('SELECT * FROM pack_coding_repo_health').all()).toEqual(before);
      expect(reopened.health.read(repo)).toMatchObject({
        cycleAt: 300,
        reason: 'partial',
        misses: 1,
      });
    }));
  test('invalid cycle or cooldown times leave the current record intact', () =>
    using((db, ledger) => {
      ledger.recordHealth(repo, { at: 100, outcome: 'failed' });
      const before = db.prepare('SELECT * FROM pack_coding_repo_health').all();
      for (const at of [-1, NaN])
        expect(() => ledger.recordHealth(repo, { at, outcome: 'failed' })).toThrow();
      expect(() =>
        ledger.recordHealth(repo, { at: 200, outcome: 'cooldown', retryAt: 199 })
      ).toThrow();
      expect(db.prepare('SELECT * FROM pack_coding_repo_health').all()).toEqual(before);
    }));
  test('initial cooldown invents no coverage, and later misses retain last complete coverage', () =>
    using((_db, ledger) => {
      expect(
        ledger.recordHealth(repo, { at: 100, outcome: 'cooldown', retryAt: 150 })
      ).toMatchObject({ attemptedAt: null, completeAt: null, misses: 0, firstMissAt: null });
      ledger.recordHealth(repo, { at: 200, outcome: 'complete' });
      expect(ledger.recordHealth(repo, { at: 300, outcome: 'partial' })).toMatchObject({
        attemptedAt: 300,
        completeAt: 200,
        misses: 1,
        firstMissAt: 300,
        nextRetryAt: null,
        incident: null,
      });
    }));
  test('the new migration upgrades an old schema without changing existing facts or schema', () =>
    using((db) => {
      db.exec('DROP TABLE IF EXISTS pack_coding_repo_health');
      db.exec("DELETE FROM migration_markers WHERE key='migration_454'");
      db.exec(
        "INSERT INTO pack_coding_poll_facts (subject,fact_revision,observation_revision,value_json,observed_at,attempted_at) VALUES ('[\"synthetic\"]',7,9,'[]',100,200)"
      );
      const facts = db.prepare('SELECT * FROM pack_coding_poll_facts').all();
      const schema = db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE '%pack_coding_repo_health%' ORDER BY name"
        )
        .all();
      runMigrations(db, () => {});
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_repo_health'").get()
      ).toBeTruthy();
      expect(db.prepare('SELECT * FROM pack_coding_repo_health').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM pack_coding_poll_facts').all()).toEqual(facts);
      expect(
        db
          .prepare(
            "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE '%pack_coding_repo_health%' ORDER BY name"
          )
          .all()
      ).toEqual(schema);
      runMigrations(db, () => {});
      expect(
        db.prepare("SELECT * FROM migration_markers WHERE key='migration_454'").all()
      ).toHaveLength(1);
    }));
});
