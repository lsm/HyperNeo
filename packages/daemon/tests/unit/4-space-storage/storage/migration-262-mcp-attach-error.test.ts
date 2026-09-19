import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigration262 } from '../../../../src/storage/schema/m262-mcp-attach-error';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migration 262 - MCP attach error column', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('adds last_attach_error to an existing registry table', () => {
    db.exec(`
      CREATE TABLE app_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        source_type TEXT NOT NULL,
        command TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);
    db.exec(`INSERT INTO app_mcp_servers (id, name, source_type, command) VALUES
      ('srv-1', 'blank-args', 'stdio', 'echo')`);

    runMigration262(db);

    expect(columnNames(db, 'app_mcp_servers')).toContain('last_attach_error');
    const row = db
      .prepare(`SELECT last_attach_error FROM app_mcp_servers WHERE id = ?`)
      .get('srv-1') as { last_attach_error: string | null };
    expect(row.last_attach_error).toBeNull();
  });

  test('is a no-op when the column already exists', () => {
    db.exec(`
      CREATE TABLE app_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        source_type TEXT NOT NULL,
        last_attach_error TEXT
      )
    `);
    db.exec(`INSERT INTO app_mcp_servers (id, name, source_type, last_attach_error) VALUES
      ('srv-1', 'kept', 'stdio', 'Connection closed')`);

    runMigration262(db);

    const row = db
      .prepare(`SELECT last_attach_error FROM app_mcp_servers WHERE id = ?`)
      .get('srv-1') as { last_attach_error: string | null };
    expect(row.last_attach_error).toBe('Connection closed');
  });

  test('is a no-op when the registry table does not exist', () => {
    expect(() => runMigration262(db)).not.toThrow();
  });
});
