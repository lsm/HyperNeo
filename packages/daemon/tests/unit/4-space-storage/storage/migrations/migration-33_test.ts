import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function getColumnDefault(db: BunDatabase, table: string, column: string): string | null {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    dflt_value: string | null;
  }>;
  return rows.find((r) => r.name === column)?.dflt_value ?? null;
}

describe('Migration 33: Add inject_workflow_context to space_agents', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-33', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('fresh DB: inject_workflow_context column does NOT exist after M74 dropped it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
  });

  test('fresh DB: role column does NOT exist after M74 dropped it', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_agents', 'role')).toBe(false);
  });

  test('fresh DB: new agents can be inserted without role or inject_workflow_context', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test-space', '/workspace/project', 'Test Space', now, now);
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('agent-1', 'space-1', 'Coder', now, now);

    const row = db.prepare(`SELECT id, name FROM space_agents WHERE id = 'agent-1'`).get() as {
      id: string;
      name: string;
    };
    expect(row.id).toBe('agent-1');
    expect(row.name).toBe('Coder');
  });

  test('fresh DB: inject_workflow_context column does NOT exist after full migration', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
  });

  test('legacy DB: column is added to existing table that lacks it', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_agents (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				model TEXT,
				provider TEXT,
				tools TEXT NOT NULL DEFAULT '[]',
				system_prompt TEXT NOT NULL DEFAULT '',
				role TEXT NOT NULL DEFAULT 'coder',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
    db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);

    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);

    runMigrations(db, () => {});

    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
  });

  test('legacy DB: existing agent rows are preserved through migration chain', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT, allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
				config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_agents (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', model TEXT, provider TEXT,
				tools TEXT NOT NULL DEFAULT '[]', system_prompt TEXT NOT NULL DEFAULT '',
				role TEXT NOT NULL DEFAULT 'coder', config TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
    db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace', 'S', now, now);
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('agent-1', 'space-1', 'Coder', 'coder', now, now);
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('agent-2', 'space-1', 'Planner', 'planner', now, now);

    runMigrations(db, () => {});

    const rows = db.prepare(`SELECT id, name FROM space_agents`).all() as Array<{
      id: string;
      name: string;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    expect(byId.get('agent-1')).toBe('Coder');
    expect(byId.get('agent-2')).toBe('Planner');

    expect(columnExists(db, 'space_agents', 'role')).toBe(false);
    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
  });

  test('idempotency: running migration twice does not error', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
    expect(columnExists(db, 'space_agents', 'inject_workflow_context')).toBe(false);
  });

  test('idempotency: data is not duplicated on second migration run', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 's', '/workspace', 'S', now, now);
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('agent-1', 'space-1', 'Coder', now, now);

    runMigrations(db, () => {});

    const rows = db.prepare(`SELECT id FROM space_agents`).all();
    expect(rows).toHaveLength(1);
  });
});
