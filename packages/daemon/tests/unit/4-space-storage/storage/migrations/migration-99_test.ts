import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration99 } from '../../../../../src/storage/schema/migrations.ts';

function insertSpace(db: BunDatabase, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, `/ws/${id}`, id, now, now);
}

function insertWorkflow(
  db: BunDatabase,
  opts: {
    id: string;
    spaceId: string;
    name: string;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflows (
			id, space_id, name, description, tags, created_at, updated_at
		) VALUES (?, ?, ?, '', '[]', ?, ?)`
  ).run(opts.id, opts.spaceId, opts.name, now, now);
}

function getLevel(db: BunDatabase, id: string): number | null {
  const row = db
    .prepare(`SELECT completion_autonomy_level FROM space_workflows WHERE id = ?`)
    .get(id) as { completion_autonomy_level: number } | undefined;
  return row?.completion_autonomy_level ?? null;
}

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function columnInfo(
  db: BunDatabase,
  table: string,
  column: string
): { notnull: number; dflt_value: string | null } | null {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const found = rows.find((r) => r.name === column);
  return found ? { notnull: found.notnull, dflt_value: found.dflt_value } : null;
}

describe('Migration 99: tool-contract refactor (Task #39)', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-99',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    insertSpace(db, 'sp-1');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('space_workflows.completion_autonomy_level', () => {
    test('column exists after migration with NOT NULL DEFAULT 3', () => {
      const info = columnInfo(db, 'space_workflows', 'completion_autonomy_level');
      expect(info).not.toBeNull();
      expect(info!.notnull).toBe(1);
      expect(info!.dflt_value).toBe('3');
    });

    test('built-in workflows get their per-template level via backfill on a pre-M99 DB', () => {
      const freshDir = join(
        process.cwd(),
        'tmp',
        'test-migration-99-backfill',
        `test-${Date.now()}-${Math.random()}`
      );
      mkdirSync(freshDir, { recursive: true });
      const freshDb = new BunDatabase(join(freshDir, 'fresh.db'));
      try {
        freshDb.exec('PRAGMA foreign_keys = ON');
        freshDb.exec(
          `CREATE TABLE spaces (
						id TEXT PRIMARY KEY, slug TEXT, workspace_path TEXT, name TEXT,
						created_at INTEGER, updated_at INTEGER
					)`
        );
        freshDb.exec(
          `CREATE TABLE space_workflows (
						id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
						created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
					)`
        );
        freshDb.exec(
          `CREATE TABLE space_tasks (
						id TEXT PRIMARY KEY, space_id TEXT NOT NULL, task_number INTEGER,
						title TEXT, description TEXT, status TEXT, priority TEXT, labels TEXT,
						depends_on TEXT, created_at INTEGER, updated_at INTEGER
					)`
        );
        const now = Date.now();
        freshDb
          .prepare(
            `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run('sp-x', 'sp-x', '/ws/x', 'Space X', now, now);

        const builtIns: Array<[string, number]> = [
          ['Coding Workflow', 3],
          ['Research Workflow', 2],
          ['Review-Only Workflow', 2],
          ['Coding with QA Workflow', 4],
          ['Plan & Decompose Workflow', 3],
        ];
        for (const [i, [name]] of builtIns.entries()) {
          freshDb
            .prepare(
              `INSERT INTO space_workflows (id, space_id, name, description, tags, created_at, updated_at)
							 VALUES (?, ?, ?, '', '[]', ?, ?)`
            )
            .run(`wf-builtin-${i}`, 'sp-x', name, now, now);
        }

        runMigration99(freshDb);

        for (const [i, [, expectedLevel]] of builtIns.entries()) {
          const level = freshDb
            .prepare(`SELECT completion_autonomy_level FROM space_workflows WHERE id = ?`)
            .get(`wf-builtin-${i}`) as { completion_autonomy_level: number };
          expect(level.completion_autonomy_level).toBe(expectedLevel);
        }
      } finally {
        try {
          freshDb.close();
        } catch {}
        try {
          rmSync(freshDir, { recursive: true, force: true });
        } catch {}
      }
    });

    test('custom (non-built-in) workflows get level 3 default', () => {
      insertWorkflow(db, {
        id: 'wf-custom',
        spaceId: 'sp-1',
        name: 'My Custom Workflow',
      });
      expect(getLevel(db, 'wf-custom')).toBe(3);
    });

    test('migration is idempotent — second run is a no-op', () => {
      insertWorkflow(db, {
        id: 'wf-coding',
        spaceId: 'sp-1',
        name: 'Coding Workflow',
      });

      runMigration99(db);
      const after1 = getLevel(db, 'wf-coding');

      runMigration99(db);
      const after2 = getLevel(db, 'wf-coding');

      expect(after1).toBe(3);
      expect(after2).toBe(3);
    });
  });

  describe('space_tasks pending_completion_* columns', () => {
    test('pending_completion_submitted_by_node_id column exists', () => {
      const cols = columnNames(db, 'space_tasks');
      expect(cols).toContain('pending_completion_submitted_by_node_id');
      expect(cols).toContain('pending_completion_submitted_at');
      expect(cols).toContain('pending_completion_reason');
    });

    test('new columns are nullable (insert without values succeeds)', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					labels, depends_on, created_at, updated_at
				) VALUES (?, ?, ?, ?, '', 'open', 'normal', '[]', '[]', ?, ?)`
      ).run('t-1', 'sp-1', 1, 'Task A', now, now);
      const row = db
        .prepare(
          `SELECT pending_completion_submitted_by_node_id, pending_completion_submitted_at,
						pending_completion_reason FROM space_tasks WHERE id = ?`
        )
        .get('t-1') as Record<string, unknown>;
      expect(row.pending_completion_submitted_by_node_id).toBeNull();
      expect(row.pending_completion_submitted_at).toBeNull();
      expect(row.pending_completion_reason).toBeNull();
    });
  });
});
