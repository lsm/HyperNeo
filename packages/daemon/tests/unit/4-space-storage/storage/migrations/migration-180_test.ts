import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration180 } from '../../../../../src/storage/schema/migrations';

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function tableColumns(db: BunDatabase, name: string): string[] {
  return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}

function pkColumns(db: BunDatabase, name: string): string[] {
  return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; pk: number }>)
    .filter((r) => r.pk > 0)
    .map((r) => r.name);
}

describe('Migration 180: space_workflow_definition_versions', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('creates the append-only definition-version history table', () => {
    runMigration180(db);
    expect(tableExists(db, 'space_workflow_definition_versions')).toBe(true);
    expect(tableColumns(db, 'space_workflow_definition_versions').sort()).toEqual([
      'created_at',
      'payload',
      'source',
      'space_id',
      'version_hash',
      'workflow_id',
    ]);
  });

  test('composite primary key on (workflow_id, version_hash) makes appends idempotent', () => {
    runMigration180(db);
    expect(pkColumns(db, 'space_workflow_definition_versions')).toEqual([
      'workflow_id',
      'version_hash',
    ]);
  });

  test('creates the space_id index', () => {
    runMigration180(db);
    expect(indexExists(db, 'idx_space_workflow_definition_versions_space')).toBe(true);
  });

  test('FK targets spaces(id) ON DELETE CASCADE, never space_workflows (orphan-safe)', () => {
    runMigration180(db);
    const fks = db
      .prepare(`PRAGMA foreign_key_list(space_workflow_definition_versions)`)
      .all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const spaceFk = fks.find((f) => f.table === 'spaces');
    expect(spaceFk).toBeDefined();
    expect(spaceFk?.from).toBe('space_id');
    expect(spaceFk?.on_delete).toBe('CASCADE');
    expect(fks.find((f) => f.table === 'space_workflows')).toBeUndefined();
  });

  test('is idempotent', () => {
    runMigration180(db);
    expect(() => runMigration180(db)).not.toThrow();
    expect(tableExists(db, 'space_workflow_definition_versions')).toBe(true);
  });

  test('is a no-op on an empty database', () => {
    expect(() => runMigration180(db)).not.toThrow();
    expect(tableExists(db, 'space_workflow_definition_versions')).toBe(true);
  });

  test('duplicate (workflow_id, version_hash) is a no-op under INSERT OR IGNORE', () => {
    runMigration180(db);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO space_workflow_definition_versions
         (workflow_id, version_hash, space_id, payload, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run('wf-1', 'hash-a', 'sp-1', '{}', 'create', 1);
    expect(() => ins.run('wf-1', 'hash-a', 'sp-1', '{}', 'update', 2)).not.toThrow();
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM space_workflow_definition_versions`).get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);

    ins.run('wf-1', 'hash-b', 'sp-1', '{}', 'update', 3);
    const n2 = (
      db.prepare(`SELECT COUNT(*) AS n FROM space_workflow_definition_versions`).get() as {
        n: number;
      }
    ).n;
    expect(n2).toBe(2);
  });
});
