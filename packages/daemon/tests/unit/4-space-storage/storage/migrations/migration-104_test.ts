import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration104, runMigrations } from '../../../../../src/storage/schema/migrations.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function indexNames(db: BunDatabase, table: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
    .all(table) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableSql(db: BunDatabase, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function seedPreM104Schema(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`
		CREATE TABLE space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completion_actions_fired_at INTEGER DEFAULT NULL
		)
	`);
  db.exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_number INTEGER NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open'
				CHECK(status IN ('open', 'in_progress', 'review', 'approved', 'done', 'blocked', 'cancelled', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			workflow_run_id TEXT,
			preferred_workflow_id TEXT,
			created_by_task_id TEXT,
			result TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			active_session TEXT
				CHECK(active_session IN ('worker', 'leader')),
			task_agent_session_id TEXT,
			approval_source TEXT,
			approval_reason TEXT,
			approved_at INTEGER,
			block_reason TEXT,
			archived_at INTEGER,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			pending_action_index INTEGER DEFAULT NULL,
			pending_checkpoint_type TEXT DEFAULT NULL
				CHECK(pending_checkpoint_type IN ('completion_action', 'gate', 'task_completion')),
			reported_status TEXT DEFAULT NULL
				CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled')),
			reported_summary TEXT DEFAULT NULL,
			pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
			pending_completion_submitted_at INTEGER DEFAULT NULL,
			pending_completion_reason TEXT DEFAULT NULL,
			post_approval_session_id TEXT DEFAULT NULL,
			post_approval_started_at INTEGER DEFAULT NULL,
			post_approval_blocked_reason TEXT DEFAULT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
		)
	`);
  db.exec(
    `CREATE UNIQUE INDEX idx_space_tasks_space_task_number ON space_tasks(space_id, task_number)`
  );
  db.exec(`CREATE INDEX idx_space_tasks_space_id ON space_tasks(space_id)`);
  db.exec('PRAGMA foreign_keys = ON');
}

describe('Migration 104: drop completionActions schema (PR 5/5)', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-104',
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

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      runMigrations(db, () => {});
      const now = Date.now();
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('sp-1', 'sp-1', '/ws/1', 'Space 1', now, now);
    });

    test('space_tasks no longer has pending_action_index', () => {
      expect(columnNames(db, 'space_tasks')).not.toContain('pending_action_index');
    });

    test('space_workflow_runs no longer has completion_actions_fired_at', () => {
      expect(columnNames(db, 'space_workflow_runs')).not.toContain('completion_actions_fired_at');
    });

    test('pending_checkpoint_type CHECK rejects "completion_action"', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at
				) VALUES (?, ?, ?, ?, '', 'open', 'normal', '[]', '[]', ?, ?)`
      ).run('t-base', 'sp-1', 1, 'Base', now, now);
      expect(() => {
        db.prepare(
          `UPDATE space_tasks SET pending_checkpoint_type = 'completion_action' WHERE id = ?`
        ).run('t-base');
      }).toThrow();
    }, 15000);

    test('pending_checkpoint_type CHECK still accepts "gate" and "task_completion"', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at, pending_checkpoint_type
				) VALUES (?, ?, ?, ?, '', 'open', 'normal', '[]', '[]', ?, ?, 'gate')`
      ).run('t-gate', 'sp-1', 2, 'Gate', now, now);

      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at, pending_checkpoint_type
				) VALUES (?, ?, ?, ?, '', 'open', 'normal', '[]', '[]', ?, ?, 'task_completion')`
      ).run('t-tc', 'sp-1', 3, 'Task Completion', now, now);

      const rows = db
        .prepare(
          `SELECT id, pending_checkpoint_type FROM space_tasks WHERE id IN ('t-gate', 't-tc') ORDER BY id`
        )
        .all() as Array<{ id: string; pending_checkpoint_type: string }>;
      expect(rows).toEqual([
        { id: 't-gate', pending_checkpoint_type: 'gate' },
        { id: 't-tc', pending_checkpoint_type: 'task_completion' },
      ]);
    });

    test('table SQL no longer mentions "completion_action" or "pending_action_index"', () => {
      const sql = tableSql(db, 'space_tasks');
      expect(sql).not.toContain('completion_action');
      expect(sql).not.toContain('pending_action_index');
    });
  });

  describe('table rebuild — pre-M104 DB with stuck rows', () => {
    beforeEach(() => {
      seedPreM104Schema(db);
      const now = Date.now();
      db.prepare(`INSERT INTO spaces (id, created_at, updated_at) VALUES (?, ?, ?)`).run(
        'sp-1',
        now,
        now
      );
      db.prepare(
        `INSERT INTO space_workflow_runs (id, space_id, created_at, updated_at, completion_actions_fired_at)
				 VALUES (?, ?, ?, ?, ?)`
      ).run('run-1', 'sp-1', now, now, now);
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at,
					pending_checkpoint_type, pending_action_index
				) VALUES (?, ?, ?, ?, 'desc', 'review', 'normal', '[]', '[]', ?, ?, 'completion_action', 2)`
      ).run('t-stuck', 'sp-1', 1, 'Stuck Task', now, now);
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at,
					pending_checkpoint_type, pending_action_index
				) VALUES (?, ?, ?, ?, 'desc', 'review', 'normal', '[]', '[]', ?, ?, 'task_completion', NULL)`
      ).run('t-healthy', 'sp-1', 2, 'Healthy Task', now, now);
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at,
					pending_checkpoint_type, pending_action_index
				) VALUES (?, ?, ?, ?, 'desc', 'review', 'normal', '[]', '[]', ?, ?, 'gate', NULL)`
      ).run('t-gate', 'sp-1', 3, 'Gate Task', now, now);
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'desc', 'open', 'normal', '[]', '[]', ?, ?)`
      ).run('t-plain', 'sp-1', 4, 'Plain Task', now, now);
    });

    test('rewrites stuck completion_action rows to task_completion + clears pending_action_index', () => {
      runMigration104(db);
      const stuck = db
        .prepare(`SELECT pending_checkpoint_type FROM space_tasks WHERE id = ?`)
        .get('t-stuck') as { pending_checkpoint_type: string };
      expect(stuck.pending_checkpoint_type).toBe('task_completion');
      expect(columnNames(db, 'space_tasks')).not.toContain('pending_action_index');
      const stuckExists = db.prepare(`SELECT id FROM space_tasks WHERE id = ?`).get('t-stuck') as
        | { id: string }
        | undefined;
      expect(stuckExists?.id).toBe('t-stuck');
    });

    test('preserves non-completion_action rows verbatim', () => {
      const before = db
        .prepare(
          `SELECT id, status, pending_checkpoint_type
					   FROM space_tasks
					  WHERE id IN ('t-healthy', 't-gate', 't-plain')
					  ORDER BY id`
        )
        .all();

      runMigration104(db);

      const after = db
        .prepare(
          `SELECT id, status, pending_checkpoint_type
					   FROM space_tasks
					  WHERE id IN ('t-healthy', 't-gate', 't-plain')
					  ORDER BY id`
        )
        .all();
      expect(after).toEqual(before);
    });

    test('drops pending_action_index column from space_tasks', () => {
      expect(columnNames(db, 'space_tasks')).toContain('pending_action_index');
      runMigration104(db);
      expect(columnNames(db, 'space_tasks')).not.toContain('pending_action_index');
    });

    test('tightens pending_checkpoint_type CHECK to ("gate", "task_completion")', () => {
      runMigration104(db);
      const sql = tableSql(db, 'space_tasks');
      expect(sql).toMatch(
        /pending_checkpoint_type\s+IN\s*\(\s*'gate'\s*,\s*'task_completion'\s*\)/
      );
      expect(sql).not.toContain("'completion_action'");
    });

    test('rejects new INSERTs with pending_checkpoint_type="completion_action" after rebuild', () => {
      runMigration104(db);
      const now = Date.now();
      expect(() => {
        db.prepare(
          `INSERT INTO space_tasks (
						id, space_id, task_number, title, description, status, priority,
						labels, depends_on, created_at, updated_at, pending_checkpoint_type
					) VALUES (?, ?, ?, ?, '', 'open', 'normal', '[]', '[]', ?, ?, 'completion_action')`
        ).run('t-bad', 'sp-1', 99, 'Bad', now, now);
      }).toThrow();
    });

    test('drops completion_actions_fired_at from space_workflow_runs', () => {
      expect(columnNames(db, 'space_workflow_runs')).toContain('completion_actions_fired_at');
      runMigration104(db);
      expect(columnNames(db, 'space_workflow_runs')).not.toContain('completion_actions_fired_at');
      const run = db.prepare(`SELECT id FROM space_workflow_runs WHERE id = ?`).get('run-1') as
        | { id: string }
        | undefined;
      expect(run?.id).toBe('run-1');
    });

    test('preserves pre-existing indexes across the rebuild', () => {
      const before = new Set(indexNames(db, 'space_tasks'));
      expect(before).toContain('idx_space_tasks_space_task_number');
      expect(before).toContain('idx_space_tasks_space_id');

      runMigration104(db);

      const after = new Set(indexNames(db, 'space_tasks'));
      for (const name of before) {
        expect(after.has(name)).toBe(true);
      }
    });

    test('is idempotent — running a second time is a no-op', () => {
      runMigration104(db);
      const colsAfter1 = columnNames(db, 'space_tasks').sort();
      const sqlAfter1 = tableSql(db, 'space_tasks');
      const countAfter1 = (
        db.prepare(`SELECT COUNT(*) AS n FROM space_tasks`).get() as { n: number }
      ).n;

      expect(() => runMigration104(db)).not.toThrow();

      const colsAfter2 = columnNames(db, 'space_tasks').sort();
      const sqlAfter2 = tableSql(db, 'space_tasks');
      const countAfter2 = (
        db.prepare(`SELECT COUNT(*) AS n FROM space_tasks`).get() as { n: number }
      ).n;

      expect(colsAfter2).toEqual(colsAfter1);
      expect(sqlAfter2).toEqual(sqlAfter1);
      expect(countAfter2).toBe(countAfter1);
    });
  });

  describe('missing tables — no-op guards', () => {
    test('runMigration104 on an empty DB does not throw', () => {
      expect(() => runMigration104(db)).not.toThrow();
    });

    test('runMigration104 skips space_workflow_runs changes when only space_tasks exists', () => {
      db.exec(`
				CREATE TABLE space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					task_number INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL DEFAULT 'open'
						CHECK(status IN ('open', 'in_progress', 'review', 'approved', 'done', 'blocked', 'cancelled', 'archived')),
					priority TEXT NOT NULL DEFAULT 'normal'
						CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
					labels TEXT NOT NULL DEFAULT '[]',
					depends_on TEXT NOT NULL DEFAULT '[]',
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					pending_action_index INTEGER DEFAULT NULL,
					pending_checkpoint_type TEXT DEFAULT NULL
						CHECK(pending_checkpoint_type IN ('completion_action', 'gate', 'task_completion'))
				)
			`);
      expect(() => runMigration104(db)).not.toThrow();
      expect(columnNames(db, 'space_tasks')).not.toContain('pending_action_index');
      const runsExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_workflow_runs'`)
        .get();
      expect(runsExists).toBeNull();
    });

    test('runMigration104 skips space_tasks rebuild when only space_workflow_runs exists', () => {
      db.exec(`
				CREATE TABLE space_workflow_runs (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					completion_actions_fired_at INTEGER DEFAULT NULL
				)
			`);
      expect(() => runMigration104(db)).not.toThrow();
      expect(columnNames(db, 'space_workflow_runs')).not.toContain('completion_actions_fired_at');
      const tasksExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
        .get();
      expect(tasksExists).toBeNull();
    });
  });
});
