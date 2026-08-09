import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration180, runMigration181 } from '../../../../../src/storage/schema/migrations';

function setupLegacySchema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY);
    CREATE TABLE space_workflow_runs (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_space_workflow_runs_space_id ON space_workflow_runs(space_id);
    CREATE INDEX idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id);
    CREATE INDEX idx_space_workflow_runs_status ON space_workflow_runs(status);
  `);
  runMigration180(db);
}

function columns(db: BunDatabase): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(space_workflow_runs)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
}

describe('Migration 181: workflow run definition pins', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    setupLegacySchema(db);
  });

  afterEach(() => db.close());

  test('adds a nullable definition_version and preserves legacy rows', () => {
    db.exec(`INSERT INTO spaces VALUES ('sp-1')`);
    db.exec(`
      INSERT INTO space_workflow_runs
        (id, space_id, workflow_id, title, status, created_at, updated_at)
      VALUES ('run-1', 'sp-1', 'wf-1', 'Legacy', 'in_progress', 1, 1)
    `);

    runMigration181(db);

    expect(columns(db).find((column) => column.name === 'definition_version')?.notnull).toBe(0);
    expect(
      db.prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-1'`).get()
    ).toEqual({ definition_version: null });
  });

  test('creates the composite version FK and preserves indexes', () => {
    runMigration181(db);
    const fks = db.prepare(`PRAGMA foreign_key_list(space_workflow_runs)`).all() as Array<{
      table: string;
      from: string;
      to: string;
    }>;
    expect(
      fks
        .filter((fk) => fk.table === 'space_workflow_definition_versions')
        .map((fk) => [fk.from, fk.to])
        .sort()
    ).toEqual([
      ['definition_version', 'version_hash'],
      ['workflow_id', 'workflow_id'],
    ]);
    const indexes = db.prepare(`PRAGMA index_list(space_workflow_runs)`).all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_space_workflow_runs_space_id',
        'idx_space_workflow_runs_workflow_id',
        'idx_space_workflow_runs_status',
      ])
    );
  });

  test('accepts a matching version and rejects a hash from another workflow', () => {
    runMigration181(db);
    db.exec(`PRAGMA foreign_keys = ON`);
    db.exec(`INSERT INTO spaces VALUES ('sp-1')`);
    db.exec(`
      INSERT INTO space_workflow_definition_versions
        (workflow_id, version_hash, space_id, payload, source, created_at)
      VALUES ('wf-1', 'hash-1', 'sp-1', '{}', 'create', 1),
             ('wf-2', 'hash-2', 'sp-1', '{}', 'create', 1)
    `);
    const insert = db.prepare(`
      INSERT INTO space_workflow_runs
        (id, space_id, workflow_id, definition_version, title, status, created_at, updated_at)
      VALUES (?, 'sp-1', ?, ?, 'Run', 'pending', 1, 1)
    `);

    expect(() => insert.run('run-1', 'wf-1', 'hash-1')).not.toThrow();
    expect(() => insert.run('run-2', 'wf-1', 'hash-2')).toThrow();
  });

  test('is idempotent', () => {
    runMigration181(db);
    expect(() => runMigration181(db)).not.toThrow();
    expect(columns(db).filter((column) => column.name === 'definition_version')).toHaveLength(1);
  });
});
