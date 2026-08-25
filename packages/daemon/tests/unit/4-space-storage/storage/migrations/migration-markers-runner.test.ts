import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/migrations';
import { reclaimPendingMigrationSpace } from '../../../../../src/storage/schema/migration-space-reclaim';

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

function markerExists(db: BunDatabase, key: string): boolean {
  return !!db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(key);
}

function createBaselineSchemaSentinels(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY);
    CREATE TABLE space_agents (id TEXT PRIMARY KEY);
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      task_agent_session_id TEXT
    );
    CREATE TABLE space_workflows (id TEXT PRIMARY KEY);
    CREATE TABLE space_workflow_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE TABLE node_executions (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      completed_at INTEGER,
      updated_at INTEGER,
      created_at INTEGER
    );
  `);
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

    const firstReclaims = runMigrations(db, () => {
      backups++;
    });
    expect(backups).toBe(1);
    expect(firstReclaims.length).toBeGreaterThan(0);
    expect(firstReclaims.some((request) => request.migrationKey === 'migration_183')).toBe(true);
    expect(markerExists(db, 'migration_001')).toBe(true);
    expect(markerExists(db, 'migration_157')).toBe(true);
    expect(markerExists(db, 'migration_158')).toBe(true);

    const retryReclaims = runMigrations(db, () => {
      backups++;
    });
    expect(retryReclaims).toEqual(firstReclaims);
    reclaimPendingMigrationSpace(db, retryReclaims);
    expect(runMigrations(db, () => backups++)).toEqual([]);
    expect(backups).toBe(1);
  });

  test('seeds historical markers for databases already migrated through 156', () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        type TEXT,
        session_context TEXT,
        archived_at TEXT,
        acp_session_id TEXT
      );
    `);
    createBaselineSchemaSentinels(db);
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

  test('does not seed historical markers for partial schemas with only late sessions columns', () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        acp_session_id TEXT
      );
    `);
    let backups = 0;

    expect(() =>
      runMigrations(db, () => {
        backups++;
      })
    ).toThrow();

    expect(backups).toBe(1);
    expect(markerExists(db, 'migration_001')).toBe(true);
    expect(markerExists(db, 'migration_029')).toBe(false);
  });

  test('seeds through 157 and runs the next pending migration', () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        type TEXT,
        session_context TEXT,
        archived_at TEXT,
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
    createBaselineSchemaSentinels(db);
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
