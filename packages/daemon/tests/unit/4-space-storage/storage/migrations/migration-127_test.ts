import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration127, runMigrations } from '../../../../../src/storage/schema/index.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function indexExists(db: BunDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function seedPreM127Schema(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			nodes TEXT NOT NULL DEFAULT '[]',
			start_node_id TEXT NOT NULL DEFAULT '',
			end_node_id TEXT,
			tags TEXT NOT NULL DEFAULT '[]',
			channels TEXT,
			gates TEXT,
			completion_autonomy_level INTEGER NOT NULL DEFAULT 3,
			post_approval TEXT,
			disabled INTEGER NOT NULL DEFAULT 0,
			template_name TEXT,
			template_hash TEXT,
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		)
	`);
  db.exec('PRAGMA foreign_keys = ON');
}

function insertWorkflow(
  db: BunDatabase,
  id: string,
  spaceId: string,
  name: string,
  handle?: string | null
): void {
  if (columnNames(db, 'space_workflows').includes('handle')) {
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, start_node_id, handle) VALUES (?, ?, ?, '', ?)`
    ).run(id, spaceId, name, handle ?? null);
  } else {
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, start_node_id) VALUES (?, ?, ?, '')`
    ).run(id, spaceId, name);
  }
}

describe('Migration 127: handle column on space_workflows', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-127',
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
    });

    test('space_workflows has handle column', () => {
      expect(columnNames(db, 'space_workflows')).toContain('handle');
    });

    test('partial unique index idx_space_workflows_handle exists', () => {
      expect(indexExists(db, 'idx_space_workflows_handle')).toBe(true);
    });
  });

  describe('backfill from pre-127 schema', () => {
    beforeEach(() => {
      seedPreM127Schema(db);
      insertWorkflow(db, 'wf-1', 'space-a', 'Coding Workflow');
      insertWorkflow(db, 'wf-2', 'space-a', 'Research Workflow');
      insertWorkflow(db, 'wf-3', 'space-b', 'Coding Workflow');
    });

    test('adds handle column and index', () => {
      runMigration127(db);
      expect(columnNames(db, 'space_workflows')).toContain('handle');
      expect(indexExists(db, 'idx_space_workflows_handle')).toBe(true);
    });

    test('backfills handles for all NULL rows', () => {
      runMigration127(db);
      const rows = db.prepare(`SELECT id, handle FROM space_workflows ORDER BY id`).all() as Array<{
        id: string;
        handle: string | null;
      }>;
      for (const row of rows) {
        expect(row.handle).not.toBeNull();
        expect(row.handle!.length).toBeGreaterThan(0);
      }
    });

    test('collision resolution within a space: duplicate name gets -2 suffix', () => {
      runMigration127(db);
      const spaceA = db
        .prepare(`SELECT handle FROM space_workflows WHERE space_id = 'space-a' ORDER BY id`)
        .all() as Array<{ handle: string }>;
      const handles = spaceA.map((r) => r.handle);
      expect(handles).toContain('coding-workflow');
      expect(handles).toContain('research-workflow');
    });

    test('collision resolution across spaces: same name in different spaces gets the same base handle', () => {
      runMigration127(db);
      const spaceAHandle = (
        db.prepare(`SELECT handle FROM space_workflows WHERE id = 'wf-1'`).get() as {
          handle: string;
        }
      ).handle;
      const spaceBHandle = (
        db.prepare(`SELECT handle FROM space_workflows WHERE id = 'wf-3'`).get() as {
          handle: string;
        }
      ).handle;
      expect(spaceAHandle).toBe('coding-workflow');
      expect(spaceBHandle).toBe('coding-workflow');
    });

    test('is idempotent — running a second time does not change existing handles', () => {
      runMigration127(db);
      const before = db
        .prepare(`SELECT id, handle FROM space_workflows ORDER BY id`)
        .all() as Array<{ id: string; handle: string }>;

      expect(() => runMigration127(db)).not.toThrow();

      const after = db
        .prepare(`SELECT id, handle FROM space_workflows ORDER BY id`)
        .all() as Array<{ id: string; handle: string }>;
      expect(after).toEqual(before);
    });

    test('crash-resume: NULL rows backfilled even when column already exists', () => {
      db.exec(`ALTER TABLE space_workflows ADD COLUMN handle TEXT DEFAULT NULL`);
      db.prepare(`UPDATE space_workflows SET handle = 'coding-workflow' WHERE id = 'wf-1'`).run();

      runMigration127(db);

      const rows = db.prepare(`SELECT id, handle FROM space_workflows ORDER BY id`).all() as Array<{
        id: string;
        handle: string | null;
      }>;
      const map = new Map(rows.map((r) => [r.id, r.handle]));

      expect(map.get('wf-1')).toBe('coding-workflow');
      expect(map.get('wf-2')).toBe('research-workflow');
      expect(map.get('wf-3')).toBe('coding-workflow');
    });

    test('crash-resume: existing handles seed the dedup set so slugs never collide with pre-existing handles', () => {
      db.exec(`ALTER TABLE space_workflows ADD COLUMN handle TEXT DEFAULT NULL`);
      db.prepare(`UPDATE space_workflows SET name = 'Coding Workflow' WHERE id = 'wf-2'`).run();
      db.prepare(`UPDATE space_workflows SET handle = 'coding-workflow' WHERE id = 'wf-1'`).run();

      expect(() => runMigration127(db)).not.toThrow();

      const rows = db.prepare(`SELECT id, handle FROM space_workflows ORDER BY id`).all() as Array<{
        id: string;
        handle: string | null;
      }>;
      const map = new Map(rows.map((r) => [r.id, r.handle]));

      expect(map.get('wf-1')).toBe('coding-workflow');
      expect(map.get('wf-2')).toBe('coding-workflow-2');
      expect(map.get('wf-3')).toBe('coding-workflow');
    });
  });

  describe('missing table — no-op guard', () => {
    test('runMigration127 on an empty DB does not throw', () => {
      expect(() => runMigration127(db)).not.toThrow();
    });
  });
});
