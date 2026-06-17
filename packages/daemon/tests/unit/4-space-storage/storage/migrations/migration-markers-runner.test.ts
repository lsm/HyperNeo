import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/migrations';

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

function markerExists(db: BunDatabase, key: string): boolean {
  return !!db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(key);
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

    runMigrations(db, () => {
      backups++;
    });
    expect(backups).toBe(1);
    expect(markerExists(db, 'migration_001')).toBe(true);
    expect(markerExists(db, 'migration_157')).toBe(true);
    expect(markerExists(db, 'migration_158')).toBe(true);

    runMigrations(db, () => {
      backups++;
    });
    expect(backups).toBe(1);
  });

  test('seeds historical markers for databases already migrated through 156', () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        acp_session_id TEXT
      );
    `);
    let backups = 0;

    runMigrations(db, () => {
      backups++;
    });

    expect(backups).toBe(1);
    expect(markerExists(db, 'migration_001')).toBe(true);
    expect(markerExists(db, 'migration_154')).toBe(true);
    expect(markerExists(db, 'migration_156')).toBe(true);
    expect(markerExists(db, 'migration_157')).toBe(true);
    expect(markerExists(db, 'migration_158')).toBe(true);
    expect(tableHasColumn(db, 'sessions', 'is_worktree')).toBe(false);
  });

  test('seeds through 157 and runs the next pending migration', () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        acp_session_id TEXT
      );
      CREATE TABLE migration_markers (
        key TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO migration_markers (key, applied_at)
      VALUES
        ('m154_legacy_long_horizon_agent_data', 1),
        ('m157_archive_terminal_space_task_worker_sessions', 1);
    `);
    let backups = 0;

    runMigrations(db, () => {
      backups++;
    });

    expect(backups).toBe(1);
    expect(markerExists(db, 'migration_001')).toBe(true);
    expect(markerExists(db, 'migration_155')).toBe(true);
    expect(markerExists(db, 'migration_157')).toBe(true);
    expect(markerExists(db, 'migration_158')).toBe(true);
    expect(tableHasColumn(db, 'sessions', 'is_worktree')).toBe(false);
  });
});
