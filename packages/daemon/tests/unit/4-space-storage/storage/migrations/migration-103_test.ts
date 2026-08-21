import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  runMigration103,
  runMigration104,
  runMigrations,
} from '../../../../../src/storage/schema/migrations.ts';

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

function seedPreM103Schema(db: BunDatabase): void {
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
			status TEXT NOT NULL DEFAULT 'open'
				CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
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
			pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
			pending_completion_submitted_at INTEGER DEFAULT NULL,
			pending_completion_reason TEXT DEFAULT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE UNIQUE INDEX idx_space_tasks_space_task_number ON space_tasks(space_id, task_number)`
  );
  db.exec(`CREATE INDEX idx_space_tasks_space_id ON space_tasks(space_id)`);

  db.exec(`
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			tags TEXT NOT NULL DEFAULT '[]',
			completion_autonomy_level INTEGER NOT NULL DEFAULT 3,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

  db.exec('PRAGMA foreign_keys = ON');
}

function seedPreM103SchemaWithLaterColumns(db: BunDatabase): void {
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
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			tags TEXT NOT NULL DEFAULT '[]',
			completion_autonomy_level INTEGER NOT NULL DEFAULT 3,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
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
				CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			workflow_run_id TEXT,
			preferred_workflow_id TEXT,
			created_by_task_id TEXT,
			custom_agent_id TEXT,
			goal_id TEXT,
			slot_role TEXT,
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
			pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
			pending_completion_submitted_at INTEGER DEFAULT NULL,
			pending_completion_reason TEXT DEFAULT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
		)
	`);
  db.exec(
    `CREATE UNIQUE INDEX idx_space_tasks_space_task_number ON space_tasks(space_id, task_number)`
  );
  db.exec(`CREATE INDEX idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`);
  db.exec(`CREATE INDEX idx_space_tasks_goal_id ON space_tasks(goal_id)`);
  db.exec(`CREATE INDEX idx_space_tasks_slot_role ON space_tasks(slot_role)`);
  db.exec(`CREATE INDEX idx_space_tasks_pending_action_index ON space_tasks(pending_action_index)`);
  db.exec('PRAGMA foreign_keys = ON');
}

describe('Migration 103: task status "approved" + post_approval schema', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-103',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
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

    test('space_tasks CHECK accepts "approved"', () => {
      const now = Date.now();
      expect(() => {
        db.prepare(
          `INSERT INTO space_tasks (
						id, space_id, task_number, title, description, status, priority,
						labels, depends_on, created_at, updated_at
					) VALUES (?, ?, ?, ?, '', 'approved', 'normal', '[]', '[]', ?, ?)`
        ).run('t-ok', 'sp-1', 1, 'Approved Task', now, now);
      }).not.toThrow();
    });

    test('space_tasks CHECK still rejects unknown statuses (e.g. legacy "failed")', () => {
      const now = Date.now();
      expect(() => {
        db.prepare(
          `INSERT INTO space_tasks (
						id, space_id, task_number, title, description, status, priority,
						labels, depends_on, created_at, updated_at
					) VALUES (?, ?, ?, ?, '', 'failed', 'normal', '[]', '[]', ?, ?)`
        ).run('t-bad', 'sp-1', 2, 'Bad', now, now);
      }).toThrow();
    });

    test('space_tasks has the three new post_approval_* columns', () => {
      const cols = columnNames(db, 'space_tasks');
      expect(cols).toContain('post_approval_session_id');
      expect(cols).toContain('post_approval_started_at');
      expect(cols).toContain('post_approval_blocked_reason');
    });

    test('space_workflows has the post_approval column', () => {
      const cols = columnNames(db, 'space_workflows');
      expect(cols).toContain('post_approval');
    });

    test('task row round-trips status="approved" + post_approval_* values', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at,
					post_approval_session_id, post_approval_started_at, post_approval_blocked_reason
				) VALUES (?, ?, ?, ?, '', 'approved', 'normal', '[]', '[]', ?, ?, ?, ?, ?)`
      ).run(
        't-rt',
        'sp-1',
        3,
        'Round Trip',
        now,
        now,
        'sess-abc',
        now + 5,
        'waiting on GitHub token'
      );

      const row = db
        .prepare(
          `SELECT status, post_approval_session_id, post_approval_started_at, post_approval_blocked_reason
					 FROM space_tasks WHERE id = ?`
        )
        .get('t-rt') as {
        status: string;
        post_approval_session_id: string | null;
        post_approval_started_at: number | null;
        post_approval_blocked_reason: string | null;
      };

      expect(row.status).toBe('approved');
      expect(row.post_approval_session_id).toBe('sess-abc');
      expect(row.post_approval_started_at).toBe(now + 5);
      expect(row.post_approval_blocked_reason).toBe('waiting on GitHub token');
    });

    test('workflow row round-trips post_approval as NULL by default and JSON when written', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_workflows (
					id, space_id, name, description, tags, completion_autonomy_level,
					created_at, updated_at
				) VALUES (?, ?, ?, '', '[]', 3, ?, ?)`
      ).run('wf-null', 'sp-1', 'wf null', now, now);

      const nullRow = db
        .prepare(`SELECT post_approval FROM space_workflows WHERE id = ?`)
        .get('wf-null') as { post_approval: string | null };
      expect(nullRow.post_approval).toBeNull();

      const route = { targetAgent: 'task-agent', instructions: 'merge {{pr_url}}' };
      db.prepare(
        `INSERT INTO space_workflows (
					id, space_id, name, description, tags, completion_autonomy_level,
					post_approval, created_at, updated_at
				) VALUES (?, ?, ?, '', '[]', 3, ?, ?, ?)`
      ).run('wf-set', 'sp-1', 'wf set', JSON.stringify(route), now, now);

      const setRow = db
        .prepare(`SELECT post_approval FROM space_workflows WHERE id = ?`)
        .get('wf-set') as { post_approval: string };
      expect(JSON.parse(setRow.post_approval)).toEqual(route);
    });
  });

  describe('table rebuild — pre-M103 DB with existing rows', () => {
    beforeEach(() => {
      seedPreM103Schema(db);
      const now = Date.now();
      db.prepare(`INSERT INTO spaces (id, created_at, updated_at) VALUES (?, ?, ?)`).run(
        'sp-1',
        now,
        now
      );
      const seeds: Array<[string, number, string, string]> = [
        ['t-open', 1, 'open', 'Open'],
        ['t-inp', 2, 'in_progress', 'In Progress'],
        ['t-rev', 3, 'review', 'Review'],
        ['t-done', 4, 'done', 'Done'],
        ['t-block', 5, 'blocked', 'Blocked'],
        ['t-cancel', 6, 'cancelled', 'Cancelled'],
        ['t-arch', 7, 'archived', 'Archived'],
      ];
      for (const [id, n, status, title] of seeds) {
        db.prepare(
          `INSERT INTO space_tasks (
						id, space_id, task_number, title, description, status, priority,
						labels, depends_on, created_at, updated_at
					) VALUES (?, ?, ?, ?, 'desc', ?, 'normal', '[]', '[]', ?, ?)`
        ).run(id, 'sp-1', n, title, status, now, now);
      }
    });

    test('preserves every pre-existing row unchanged after rebuild', () => {
      const before = db
        .prepare(
          `SELECT id, space_id, task_number, title, description, status, priority,
							labels, depends_on, created_at, updated_at FROM space_tasks ORDER BY task_number`
        )
        .all();

      runMigration103(db);

      const after = db
        .prepare(
          `SELECT id, space_id, task_number, title, description, status, priority,
							labels, depends_on, created_at, updated_at FROM space_tasks ORDER BY task_number`
        )
        .all();

      expect(after).toEqual(before);
      expect(after.length).toBe(7);
    });

    test('preserves pre-existing indexes across the rebuild', () => {
      const before = new Set(indexNames(db, 'space_tasks'));
      expect(before).toContain('idx_space_tasks_space_task_number');
      expect(before).toContain('idx_space_tasks_space_id');

      runMigration103(db);

      const after = new Set(indexNames(db, 'space_tasks'));
      for (const name of before) {
        expect(after.has(name)).toBe(true);
      }
    });

    test('widens CHECK to accept "approved" after rebuild', () => {
      runMigration103(db);
      const now = Date.now();
      expect(() => {
        db.prepare(
          `INSERT INTO space_tasks (
						id, space_id, task_number, title, description, status, priority,
						labels, depends_on, created_at, updated_at
					) VALUES (?, ?, ?, ?, '', 'approved', 'normal', '[]', '[]', ?, ?)`
        ).run('t-new-approved', 'sp-1', 99, 'Approved', now, now);
      }).not.toThrow();
    });

    test('adds post_approval_* columns to space_tasks', () => {
      expect(columnNames(db, 'space_tasks')).not.toContain('post_approval_session_id');
      runMigration103(db);
      const cols = columnNames(db, 'space_tasks');
      expect(cols).toContain('post_approval_session_id');
      expect(cols).toContain('post_approval_started_at');
      expect(cols).toContain('post_approval_blocked_reason');
    });

    test('adds post_approval column to space_workflows', () => {
      expect(columnNames(db, 'space_workflows')).not.toContain('post_approval');
      runMigration103(db);
      expect(columnNames(db, 'space_workflows')).toContain('post_approval');
    });

    test('is idempotent — running a second time is a no-op', () => {
      runMigration103(db);
      const countAfter1 = (
        db.prepare(`SELECT COUNT(*) AS n FROM space_tasks`).get() as { n: number }
      ).n;
      const cols1 = columnNames(db, 'space_tasks').sort();

      expect(() => runMigration103(db)).not.toThrow();

      const countAfter2 = (
        db.prepare(`SELECT COUNT(*) AS n FROM space_tasks`).get() as { n: number }
      ).n;
      const cols2 = columnNames(db, 'space_tasks').sort();

      expect(countAfter2).toBe(countAfter1);
      expect(cols2).toEqual(cols1);
    });
  });

  describe('regression — pre-M103 DB with later columns and indexes', () => {
    beforeEach(() => {
      seedPreM103SchemaWithLaterColumns(db);
      const now = Date.now();
      db.prepare(`INSERT INTO spaces (id, created_at, updated_at) VALUES (?, ?, ?)`).run(
        'sp-1',
        now,
        now
      );
      db.prepare(
        `INSERT INTO space_workflow_runs (
						id, space_id, created_at, updated_at, completion_actions_fired_at
					) VALUES (?, ?, ?, ?, ?)`
      ).run('run-1', 'sp-1', now, now, now + 1);
      db.prepare(
        `INSERT INTO space_workflows (
						id, space_id, name, description, tags, completion_autonomy_level,
						created_at, updated_at
					) VALUES (?, ?, ?, '', '[]', 3, ?, ?)`
      ).run('wf-1', 'sp-1', 'Workflow', now, now);
      db.prepare(
        `INSERT INTO space_tasks (
						id, space_id, task_number, title, description, status, priority,
						labels, workflow_run_id, custom_agent_id, goal_id, slot_role,
						depends_on, created_at, updated_at,
						pending_checkpoint_type, pending_action_index
					) VALUES (?, ?, ?, ?, ?, 'review', 'high', '["bug"]', ?, ?, ?, ?, '[]', ?, ?, 'completion_action', 7)`
      ).run(
        't-legacy',
        'sp-1',
        1,
        'Legacy indexed task',
        'preserve me',
        'run-1',
        'agent-1',
        'goal-1',
        'implementer',
        now,
        now + 10
      );
    });

    test('runs migrations 103 and 104 without dropping later columns or compatible indexes', () => {
      expect(() => runMigration103(db)).not.toThrow();
      expect(() => runMigration104(db)).not.toThrow();

      const cols = columnNames(db, 'space_tasks');
      expect(cols).toContain('custom_agent_id');
      expect(cols).toContain('goal_id');
      expect(cols).toContain('slot_role');
      expect(cols).toContain('post_approval_session_id');
      expect(cols).toContain('post_approval_started_at');
      expect(cols).toContain('post_approval_blocked_reason');
      expect(cols).not.toContain('pending_action_index');
      expect(columnNames(db, 'space_workflows')).toContain('post_approval');
      expect(columnNames(db, 'space_workflow_runs')).not.toContain('completion_actions_fired_at');

      const sql = tableSql(db, 'space_tasks');
      expect(sql).toContain("'approved'");
      expect(sql).not.toContain("'completion_action'");
      expect(sql).not.toContain('pending_action_index');

      const indexes = new Set(indexNames(db, 'space_tasks'));
      expect(indexes).toContain('idx_space_tasks_custom_agent_id');
      expect(indexes).toContain('idx_space_tasks_goal_id');
      expect(indexes).toContain('idx_space_tasks_slot_role');
      expect(indexes).not.toContain('idx_space_tasks_pending_action_index');

      const row = db
        .prepare(
          `SELECT title, description, status, priority, labels, workflow_run_id,
						        custom_agent_id, goal_id, slot_role, pending_checkpoint_type
						   FROM space_tasks
						  WHERE id = ?`
        )
        .get('t-legacy') as {
        title: string;
        description: string;
        status: string;
        priority: string;
        labels: string;
        workflow_run_id: string;
        custom_agent_id: string;
        goal_id: string;
        slot_role: string;
        pending_checkpoint_type: string;
      };
      expect(row).toEqual({
        title: 'Legacy indexed task',
        description: 'preserve me',
        status: 'review',
        priority: 'high',
        labels: '["bug"]',
        workflow_run_id: 'run-1',
        custom_agent_id: 'agent-1',
        goal_id: 'goal-1',
        slot_role: 'implementer',
        pending_checkpoint_type: 'task_completion',
      });

      const now = Date.now();
      expect(() => {
        db.prepare(
          `INSERT INTO space_tasks (
							id, space_id, task_number, title, description, status, priority,
							labels, depends_on, created_at, updated_at
						) VALUES (?, ?, ?, ?, '', 'approved', 'normal', '[]', '[]', ?, ?)`
        ).run('t-approved', 'sp-1', 2, 'Approved', now, now);
      }).not.toThrow();
    });
  });

  describe('missing tables — no-op guards', () => {
    test('runMigration103 on an empty DB does not throw', () => {
      expect(() => runMigration103(db)).not.toThrow();
    });

    test('runMigration103 skips space_workflows changes when only space_tasks exists', () => {
      db.exec(`
				CREATE TABLE space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					task_number INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL DEFAULT 'open'
						CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
					priority TEXT NOT NULL DEFAULT 'normal'
						CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
					labels TEXT NOT NULL DEFAULT '[]',
					depends_on TEXT NOT NULL DEFAULT '[]',
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
      expect(() => runMigration103(db)).not.toThrow();
      expect(columnNames(db, 'space_tasks')).toContain('post_approval_session_id');
      const wfExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_workflows'`)
        .get();
      expect(wfExists).toBeNull();
    });
  });
});
