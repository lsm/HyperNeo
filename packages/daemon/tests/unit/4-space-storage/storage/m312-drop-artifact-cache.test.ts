import { describe, expect, test } from 'bun:test';
import { runMigration312 } from '../../../../src/storage/schema/m312-drop-artifact-cache';
import { runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

function hasCache(db: Database): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_run_artifact_cache'"
    )
    .get();
}

describe('runMigration312', () => {
  test('drops the artifact cache table, tolerates its absence, and a migrated database lacks it', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_run_artifact_cache (id TEXT PRIMARY KEY)');
    runMigration312(db);
    runMigration312(db);
    expect(hasCache(db)).toBe(false);
    const migrated = new Database(':memory:');
    runMigrations(migrated, () => {});
    expect(hasCache(migrated)).toBe(false);
  });
});
