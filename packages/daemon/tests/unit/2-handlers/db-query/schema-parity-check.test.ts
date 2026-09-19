import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  checkHelperSchemaParity,
  checkScopeRegistration,
} from '../../../../../../scripts/check-db-schema-parity';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { createSpaceTables } from '../../helpers/space-test-db';

function createProductionDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return db;
}

function createHelperDb(): Database {
  const db = new Database(':memory:');
  createSpaceTables(db);
  return db;
}

describe('DB schema parity check', () => {
  test('all production tables are registered in db-query scope config', () => {
    const db = createProductionDb();
    const failures = checkScopeRegistration(db);

    db.close();
    expect(failures).toEqual([]);
  });

  test('space test DB helper schema matches production table and index definitions', () => {
    const prodDb = createProductionDb();
    const helperDb = createHelperDb();
    const failures = checkHelperSchemaParity(prodDb, helperDb);

    prodDb.close();
    helperDb.close();
    expect(failures).toEqual([]);
  });

  test('reports a lifecycle trigger missing from the helper', () => {
    const prodDb = createProductionDb();
    const helperDb = createHelperDb();
    try {
      helperDb.exec('DROP TRIGGER increment_task_lifecycle_generation');

      const failures = checkHelperSchemaParity(prodDb, helperDb);

      expect(failures).toContain('space-test-db helper trigger mismatch for space_tasks:');
      expect(failures).toContain('  Missing triggers:');
      expect(failures.join('\n')).toContain('lifecycle_generation = OLD.lifecycle_generation + 1');
    } finally {
      prodDb.close();
      helperDb.close();
    }
  });

  test('reports an extra trigger in the helper', () => {
    const prodDb = createProductionDb();
    const helperDb = createHelperDb();
    try {
      helperDb.exec(`CREATE TRIGGER helper_only_trigger AFTER UPDATE ON space_tasks
        BEGIN SELECT 1; END`);

      const failures = checkHelperSchemaParity(prodDb, helperDb);

      expect(failures).toContain('space-test-db helper trigger mismatch for space_tasks:');
      expect(failures).toContain('  Extra triggers:');
      expect(failures.join('\n')).toContain('BEGIN SELECT 1; END');
    } finally {
      prodDb.close();
      helperDb.close();
    }
  });

  test('reports a changed trigger body even when its name is unchanged', () => {
    const prodDb = createProductionDb();
    const helperDb = createHelperDb();
    try {
      const trigger = helperDb
        .query("SELECT sql FROM sqlite_schema WHERE name = 'increment_task_lifecycle_generation'")
        .get() as { sql: string };
      helperDb.exec('DROP TRIGGER increment_task_lifecycle_generation');
      helperDb.exec(
        trigger.sql.replace('OLD.lifecycle_generation + 1', 'OLD.lifecycle_generation + 2')
      );

      const failures = checkHelperSchemaParity(prodDb, helperDb);

      expect(failures).toContain('space-test-db helper trigger mismatch for space_tasks:');
      expect(failures).toContain('  Missing triggers:');
      expect(failures).toContain('  Extra triggers:');
      expect(failures.join('\n')).toContain('lifecycle_generation = OLD.lifecycle_generation + 2');
    } finally {
      prodDb.close();
      helperDb.close();
    }
  });
});
