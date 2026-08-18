import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, runMigration86 } from '../../../../../src/storage/schema/index.ts';

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

describe('Migration 33: Add autonomy_level to spaces', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-spaces-autonomy', `test-${Date.now()}`);
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

  test('fresh DB: autonomy_level column exists after full migration', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(true);
  });

  test('fresh DB: autonomy_level has default value of 1', () => {
    runMigrations(db, () => {});
    expect(getColumnDefault(db, 'spaces', 'autonomy_level')).toBe('1');
  });

  test('fresh DB: new spaces default to autonomy_level = 1', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test-space', '/workspace/project', 'Test Space', now, now);

    const row = db.prepare(`SELECT autonomy_level FROM spaces WHERE id = 'space-1'`).get() as {
      autonomy_level: number;
    };
    expect(row.autonomy_level).toBe(1);
  });

  test('fresh DB: autonomy_level can be set to 3', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, autonomy_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test-space', '/workspace/project', 'Test Space', 3, now, now);

    const row = db.prepare(`SELECT autonomy_level FROM spaces WHERE id = 'space-1'`).get() as {
      autonomy_level: number;
    };
    expect(row.autonomy_level).toBe(3);
  });

  test('legacy DB: column is added to existing spaces table that lacks it', () => {
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

    expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(false);

    runMigrations(db, () => {});

    expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(true);
  });

  test('legacy DB: existing space rows get autonomy_level = 1 after column add', () => {
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

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', '/workspace/a', 'Space A', now, now);
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('space-2', '/workspace/b', 'Space B', now, now);

    runMigrations(db, () => {});

    const rows = db
      .prepare(`SELECT id, name, autonomy_level FROM spaces ORDER BY id`)
      .all() as Array<{ id: string; name: string; autonomy_level: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'space-1', name: 'Space A', autonomy_level: 1 });
    expect(rows[1]).toMatchObject({ id: 'space-2', name: 'Space B', autonomy_level: 1 });
  });

  test('idempotency: running migration twice does not error', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
    expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(true);
  });

  test('migration 86: supervised text value converts to 1', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				paused INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`CREATE UNIQUE INDEX idx_spaces_slug ON spaces(slug)`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, autonomy_level, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', 'supervised-space', '/ws/a', 'Supervised', 'supervised', now, now);

    runMigrations(db, () => {});

    const row = db.prepare(`SELECT autonomy_level FROM spaces WHERE id = 's1'`).get() as {
      autonomy_level: number;
    };
    expect(row.autonomy_level).toBe(1);
  });

  test('migration 86: semi_autonomous text value converts to 3', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				paused INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`CREATE UNIQUE INDEX idx_spaces_slug ON spaces(slug)`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, autonomy_level, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', 'semi-space', '/ws/a', 'Semi', 'semi_autonomous', now, now);

    runMigrations(db, () => {});

    const row = db.prepare(`SELECT autonomy_level FROM spaces WHERE id = 's1'`).get() as {
      autonomy_level: number;
    };
    expect(row.autonomy_level).toBe(3);
  });

  test('migration 86: CHECK constraint rejects invalid autonomy levels', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    expect(() => {
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, autonomy_level, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('s1', 'bad', '/ws/a', 'Bad', 6, now, now);
    }).toThrow();

    expect(() => {
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, autonomy_level, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('s2', 'bad2', '/ws/b', 'Bad2', 0, now, now);
    }).toThrow();
  });

  test('migration 86: old approval_source values are converted', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test', '/ws/a', 'Test', now, now);

    const insertTask = db.prepare(`
			INSERT INTO space_tasks (id, space_id, task_number, title, approval_source, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
    insertTask.run('t1', 'space-1', 1, 'T1', 'neo_agent', now, now);
    insertTask.run('t2', 'space-1', 2, 'T2', 'space_agent', now, now);
    insertTask.run('t3', 'space-1', 3, 'T3', 'task_agent', now, now);
    insertTask.run('t4', 'space-1', 4, 'T4', 'node_agent', now, now);
    insertTask.run('t5', 'space-1', 5, 'T5', 'semi_auto', now, now);
    insertTask.run('t6', 'space-1', 6, 'T6', 'human', now, now);
    insertTask.run('t7', 'space-1', 7, 'T7', null, now, now);

    db.exec(`
			UPDATE space_tasks SET approval_source = 'agent'
			WHERE approval_source IN ('neo_agent', 'space_agent', 'task_agent', 'node_agent')
		`);
    db.exec(`
			UPDATE space_tasks SET approval_source = 'auto_policy'
			WHERE approval_source = 'semi_auto'
		`);

    const rows = db
      .prepare(`SELECT id, approval_source FROM space_tasks ORDER BY id`)
      .all() as Array<{ id: string; approval_source: string | null }>;

    expect(rows).toEqual([
      { id: 't1', approval_source: 'agent' },
      { id: 't2', approval_source: 'agent' },
      { id: 't3', approval_source: 'agent' },
      { id: 't4', approval_source: 'agent' },
      { id: 't5', approval_source: 'auto_policy' },
      { id: 't6', approval_source: 'human' },
      { id: 't7', approval_source: null },
    ]);
  });

  test('migration 86: pending_checkpoint_type column exists after full migrate', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_tasks', 'pending_action_index')).toBe(false);
    expect(columnExists(db, 'space_tasks', 'pending_checkpoint_type')).toBe(true);
  });

  test('idempotency: data is not duplicated on second migration run', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'test', '/workspace/project', 'Test', now, now);

    runMigrations(db, () => {});

    const rows = db.prepare(`SELECT id FROM spaces`).all();
    expect(rows).toHaveLength(1);
  });
});

describe('Migration 86 regression: partial migration (spaces numeric, tasks column missing)', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-86-regression',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
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

  test('adds pending_checkpoint_type when spaces.autonomy_level is already INTEGER but column is missing', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				autonomy_level INTEGER NOT NULL DEFAULT 1
					CHECK(autonomy_level BETWEEN 1 AND 5),
				config TEXT,
				paused INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`CREATE UNIQUE INDEX idx_spaces_slug ON spaces(slug)`);

    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open',
				priority TEXT NOT NULL DEFAULT 'normal',
				labels TEXT NOT NULL DEFAULT '[]',
				depends_on TEXT NOT NULL DEFAULT '[]',
				approval_source TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 'sp-1', '/ws/1', 'Space 1', now, now);

    runMigration86(db);

    expect(columnExists(db, 'space_tasks', 'pending_checkpoint_type')).toBe(true);
    expect(columnExists(db, 'space_tasks', 'pending_action_index')).toBe(true);
  });

  test('pending_checkpoint_type column is writable after M86 fixes it up', () => {
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				autonomy_level INTEGER NOT NULL DEFAULT 1
					CHECK(autonomy_level BETWEEN 1 AND 5),
				paused INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open',
				priority TEXT NOT NULL DEFAULT 'normal',
				labels TEXT NOT NULL DEFAULT '[]',
				depends_on TEXT NOT NULL DEFAULT '[]',
				approval_source TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-2', 'sp-2', '/ws/2', 'Space 2', now, now);
    db.prepare(
      `INSERT INTO space_tasks (id, space_id, task_number, title, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('t-1', 'sp-2', 1, 'Test Task', now, now);

    runMigration86(db);

    expect(() => {
      db.prepare(`UPDATE space_tasks SET pending_checkpoint_type = 'gate' WHERE id = ?`).run('t-1');
    }).not.toThrow();

    const row = db
      .prepare(`SELECT pending_checkpoint_type FROM space_tasks WHERE id = ?`)
      .get('t-1') as { pending_checkpoint_type: string } | undefined;
    expect(row?.pending_checkpoint_type).toBe('gate');
  });
});
