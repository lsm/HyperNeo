import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../../../../src/lib/db-query/scope-config';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { createSpaceTables } from '../../helpers/space-test-db';
import { HELPER_SCHEMA_TABLES } from '../../../../../../scripts/check-db-schema-parity';

type ColumnRow = {
  name: string;
};

type TableRow = {
  name: string;
};

const helperColumnOverrides: Record<string, string[]> = {
  sessions: ['id', 'type', 'session_context'],
};

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

function getTableNames(db: Database): string[] {
  return db
    .query(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((row) => (row as TableRow).name);
}

function getColumnNames(db: Database, tableName: string): string[] {
  return db
    .query(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => (row as ColumnRow).name);
}

describe('DB schema parity check', () => {
  test('all production tables are registered in db-query scope config', () => {
    const db = createProductionDb();
    const registeredTables = new Set([
      ...getExcludedTableNames(),
      ...getAccessibleTableNames('global'),
      ...getAccessibleTableNames('room'),
      ...getAccessibleTableNames('space'),
    ]);

    const unregisteredTables = getTableNames(db).filter(
      (tableName) => !registeredTables.has(tableName)
    );

    db.close();
    expect(unregisteredTables).toEqual([]);
  });

  test('space test DB helper tables match production columns', () => {
    const prodDb = createProductionDb();
    const helperDb = createHelperDb();
    const helperTables = new Set(getTableNames(helperDb));
    const mismatches: string[] = [];

    for (const tableName of HELPER_SCHEMA_TABLES) {
      expect(helperTables.has(tableName)).toBe(true);

      const prodColumns = helperColumnOverrides[tableName] ?? getColumnNames(prodDb, tableName);
      const helperColumns = getColumnNames(helperDb, tableName);
      const missingColumns = prodColumns.filter(
        (columnName) => !helperColumns.includes(columnName)
      );
      const extraColumns = helperColumns.filter((columnName) => !prodColumns.includes(columnName));

      if (missingColumns.length > 0 || extraColumns.length > 0) {
        mismatches.push(
          `${tableName}: missing=[${missingColumns.join(',')}] extra=[${extraColumns.join(',')}]`
        );
      }
    }

    prodDb.close();
    helperDb.close();
    expect(mismatches).toEqual([]);
  });
});
