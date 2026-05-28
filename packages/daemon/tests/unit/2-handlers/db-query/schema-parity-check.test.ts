import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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
});
