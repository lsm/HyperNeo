import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/migrations';
import { reclaimPendingMigrationSpace } from '../../../../../src/storage/schema/migration-space-reclaim';

function markerExists(db: BunDatabase, key: string): boolean {
  return !!db.prepare('SELECT key FROM migration_markers WHERE key = ?').get(key);
}

function loadSupportedBaseline(db: BunDatabase): void {
  db.exec(readFileSync(new URL('./fixtures/schema-baseline/v0.41.0.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO sessions
    (id, title, created_at, last_active_at, status, config, metadata, type)
    VALUES ('kept', 'Existing work', '', '', 'active', '{}', '{"kept":true}', 'worker')`);
}

describe('migration runner markers', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('does not rerun marked migrations or create another backup', () => {
    let backups = 0;
    const firstReclaims = runMigrations(db, () => backups++);
    expect(backups).toBe(1);
    expect(firstReclaims.length).toBeGreaterThan(0);
    expect(firstReclaims.some((request) => request.migrationKey === 'migration_183')).toBe(true);
    expect(markerExists(db, 'migration_001')).toBe(true);
    expect(markerExists(db, 'migration_157')).toBe(true);
    expect(markerExists(db, 'migration_158')).toBe(true);
    const retryReclaims = runMigrations(db, () => backups++);
    expect(retryReclaims).toEqual(firstReclaims);
    reclaimPendingMigrationSpace(db, retryReclaims);
    expect(runMigrations(db, () => backups++)).toEqual([]);
    expect(backups).toBe(1);
  });

  test('upgrades the oldest supported markers without overwriting existing data', () => {
    loadSupportedBaseline(db);
    const historicalMarkers = db.prepare('SELECT * FROM migration_markers ORDER BY key').all() as {
      key: string;
      applied_at: number;
    }[];
    let backups = 0;
    runMigrations(db, () => backups++);
    expect(backups).toBe(1);
    for (const marker of historicalMarkers) {
      expect(db.prepare('SELECT * FROM migration_markers WHERE key = ?').get(marker.key)).toEqual(
        marker
      );
    }
    expect(markerExists(db, 'migration_239')).toBe(true);
    expect(db.prepare("SELECT title, metadata FROM sessions WHERE id = 'kept'").get()).toEqual({
      title: 'Existing work',
      metadata: '{"kept":true}',
    });
  });

  test('does not mistake a marker-only existing database for a fresh install', () => {
    db.exec('CREATE TABLE migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.exec("INSERT INTO migration_markers VALUES ('migration_195', 1)");
    let backups = 0;
    expect(() =>
      runMigrations(db, () => {
        backups++;
        expect(
          db.prepare("SELECT name FROM sqlite_schema WHERE name = 'sessions'").get()
        ).toBeNull();
        throw new Error('Stop before the first pending legacy migration');
      })
    ).toThrow('Stop before the first pending legacy migration');
    expect(backups).toBe(1);
    expect(db.prepare('SELECT * FROM migration_markers').all()).toEqual([
      { key: 'migration_195', applied_at: 1 },
    ]);
  });

  test('does not recreate a supported database missing its first historical marker', () => {
    loadSupportedBaseline(db);
    db.exec("DELETE FROM migration_markers WHERE key = 'migration_001'");
    runMigrations(db, () => {});
    expect(markerExists(db, 'migration_238')).toBe(true);
    expect(markerExists(db, 'migration_239')).toBe(true);
    expect(db.prepare("SELECT title FROM sessions WHERE id = 'kept'").get()).toEqual({
      title: 'Existing work',
    });
  });
});
