import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigration539 } from '../../../../src/storage/schema/m539-mcp-oauth-auth';
import { createTables } from '../../../../src/storage/schema';

const columns = (db: BunDatabase) =>
  (db.prepare('PRAGMA table_info(app_mcp_servers)').all() as Array<{ name: string }>).map(
    (row) => row.name
  );

describe('migration 539 - MCP OAuth auth column', () => {
  let db: BunDatabase;
  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  test('adds a nullable auth column to an existing registry and keeps rows', () => {
    db.exec(
      'CREATE TABLE app_mcp_servers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, source_type TEXT NOT NULL)'
    );
    db.exec("INSERT INTO app_mcp_servers (id, name, source_type) VALUES ('srv', 'kept', 'http')");
    runMigration539(db);
    runMigration539(db);
    expect(columns(db)).toContain('auth');
    expect(db.prepare("SELECT auth FROM app_mcp_servers WHERE id = 'srv'").get()).toEqual({
      auth: null,
    });
  });

  test('fresh databases already have the column', () => {
    createTables(db);
    expect(columns(db)).toContain('auth');
  });
});
