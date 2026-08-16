/**
 * Migration 195 Tests — `space_workspaces` table + primary backfill.
 *
 * First slice of the space multi-workspace epic (#2521): a Space can register
 * multiple git repositories while every task/session still binds to exactly
 * one workspace. M195 creates the registry table and backfills exactly one
 * `is_primary = 1` row per space from `spaces.workspace_path`
 * (label = repo basename); `spaces.workspace_path` itself is untouched.
 *
 * Covers:
 *   - Pre-M195 DB (spaces present, table absent): one primary row per space.
 *   - Label derives from the repo basename (incl. trailing-slash paths).
 *   - spaces.workspace_path is not modified.
 *   - UNIQUE(space_id, path) and FK ON DELETE CASCADE are enforced.
 *   - Re-running runMigration195 is a no-op; partial application converges.
 *   - Migrate-once via the full chain: marker removed + table dropped →
 *     runMigrations re-runs M195 exactly once.
 *   - Fresh, fully-migrated DB carries the table (empty — no spaces yet).
 *   - Missing-table guard (spaces table absent).
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration195 } from '../../../../../src/storage/schema/migrations.ts';
import { buildMigratedTemplate, openEmptyDb, openMigratedClone } from './test-db-template';

interface WorkspaceRow {
  id: string;
  space_id: string;
  path: string;
  label: string;
  is_primary: number;
}

function workspaceRows(db: BunDatabase, spaceId?: string): WorkspaceRow[] {
  const sql = spaceId
    ? `SELECT id, space_id, path, label, is_primary FROM space_workspaces WHERE space_id = ? ORDER BY path`
    : `SELECT id, space_id, path, label, is_primary FROM space_workspaces ORDER BY space_id, path`;
  return (spaceId ? db.prepare(sql).all(spaceId) : db.prepare(sql).all()) as WorkspaceRow[];
}

/** Minimal pre-M195 shape: spaces without the space_workspaces registry. */
function seedSpaces(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES
      ('sp-1', '/work/dev/repo-alpha', 'Space One', 1000, 1000),
      ('sp-2', '/work/dev/repo-beta', 'Space Two', 1000, 1000),
      ('sp-3', '/work/dev/repo-gamma/', 'Space Three', 1000, 1000),
      ('sp-4', 'C:\\work\\dev\\repo-delta', 'Space Four', 1000, 1000)
  `);
}

describe('Migration 195: space_workspaces table + primary backfill', () => {
  let testDir: string;
  let db: BunDatabase;
  let templateDir: string;
  let templatePath: string;
  let cloneCounter = 0;

  beforeAll(() => {
    templateDir = join(process.cwd(), 'tmp', 'test-migration-195', `template-${Date.now()}`);
    templatePath = buildMigratedTemplate(templateDir);
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(templateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    cloneCounter += 1;
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-195',
      `test-${Date.now()}-${cloneCounter}`
    );
    mkdirSync(testDir, { recursive: true });
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

  // ── Existing DB: spaces present, registry absent ────────────────────────────

  describe('pre-M195 schema — backfill', () => {
    beforeEach(() => {
      db = new BunDatabase(join(testDir, 'test.db'));
      db.exec('PRAGMA foreign_keys = ON');
      seedSpaces(db);
    });

    test('backfills exactly one is_primary = 1 row per space', () => {
      runMigration195(db);

      const rows = workspaceRows(db);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.is_primary).toBe(1);
      }
      // One row per space, keyed by the spaces table.
      expect([...new Set(rows.map((r) => r.space_id))].sort()).toEqual([
        'sp-1',
        'sp-2',
        'sp-3',
        'sp-4',
      ]);
    });

    test('row path mirrors spaces.workspace_path and label is the repo basename', () => {
      runMigration195(db);

      const bySpace = new Map(workspaceRows(db).map((r) => [r.space_id, r]));
      expect(bySpace.get('sp-1')?.path).toBe('/work/dev/repo-alpha');
      expect(bySpace.get('sp-1')?.label).toBe('repo-alpha');
      expect(bySpace.get('sp-2')?.path).toBe('/work/dev/repo-beta');
      expect(bySpace.get('sp-2')?.label).toBe('repo-beta');
      // Trailing slash collapses — the label is still the final segment.
      expect(bySpace.get('sp-3')?.path).toBe('/work/dev/repo-gamma/');
      expect(bySpace.get('sp-3')?.label).toBe('repo-gamma');
      // Windows-native paths (path.resolve on win32) split on the backslash.
      expect(bySpace.get('sp-4')?.path).toBe('C:\\work\\dev\\repo-delta');
      expect(bySpace.get('sp-4')?.label).toBe('repo-delta');
    });

    test('does not modify spaces.workspace_path', () => {
      const before = db.prepare(`SELECT id, workspace_path FROM spaces ORDER BY id`).all();
      runMigration195(db);
      const after = db.prepare(`SELECT id, workspace_path FROM spaces ORDER BY id`).all();
      expect(after).toEqual(before);
    });

    test('re-run is a no-op — no duplicate rows, no throw', () => {
      runMigration195(db);
      expect(() => runMigration195(db)).not.toThrow();
      expect(workspaceRows(db)).toHaveLength(4);
    });

    test('partial application converges to one primary row per space', () => {
      // Simulate a crash mid-migration (marker never written): sp-2's row was
      // never inserted. A re-run skips spaces that already have a row and
      // backfills only the missing one — no duplicates anywhere.
      runMigration195(db);
      db.prepare(`DELETE FROM space_workspaces WHERE space_id = 'sp-2'`).run();
      runMigration195(db);

      const rows = workspaceRows(db);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.space_id).sort()).toEqual(['sp-1', 'sp-2', 'sp-3', 'sp-4']);
      for (const row of rows) {
        expect(row.is_primary).toBe(1);
      }
    });

    test('UNIQUE(space_id, path) is enforced', () => {
      runMigration195(db);
      expect(() => {
        db.exec(`
          INSERT INTO space_workspaces (id, space_id, path, label, is_primary, created_at, updated_at)
          VALUES ('dup', 'sp-1', '/work/dev/repo-alpha', 'dup', 0, 1000, 1000)
        `);
      }).toThrow();
    });

    test('deleting a space cascades to its workspace rows', () => {
      runMigration195(db);
      db.prepare(`DELETE FROM spaces WHERE id = 'sp-1'`).run();
      expect(workspaceRows(db, 'sp-1')).toHaveLength(0);
      expect(workspaceRows(db)).toHaveLength(3);
    });

    test('spaces table absent — table is still created, backfill skipped, no throw', () => {
      db.exec(`DROP TABLE spaces`);
      expect(() => runMigration195(db)).not.toThrow();
      expect(workspaceRows(db)).toHaveLength(0);
    });

    test('sentinel spaces table without workspace_path (marker-seed path) — no throw, no backfill', () => {
      // Mirrors createBaselineSchemaSentinels in migration-markers-runner.test.ts:
      // marker-seeded DBs replay only migrations after the seed boundary against
      // minimal sentinel schemas. The backfill must not assume extra columns.
      db.exec(`DROP TABLE spaces`);
      db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY)`);
      db.exec(`INSERT INTO spaces (id) VALUES ('sentinel-1')`);
      expect(() => runMigration195(db)).not.toThrow();
      expect(workspaceRows(db)).toHaveLength(0);
    });
  });

  // ── Migrate-once through the full chain ─────────────────────────────────────

  describe('migrate-once via runMigrations', () => {
    beforeEach(() => {
      db = openMigratedClone(templatePath, testDir);
    });

    test('fully-migrated clone already carries the marker — re-run inserts nothing', () => {
      runMigrations(db, () => {});
      // Spaces created after M195 do not get a registry row from the migration;
      // the creation path lands with the repository layer (follow-up #2522).
      db.exec(`
        INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
        VALUES ('sp-new', 'space-new', '/work/dev/repo-new', 'New Space', 1000, 1000)
      `);
      runMigrations(db, () => {});
      expect(workspaceRows(db)).toHaveLength(0);
    });

    test('pre-M195 DB (marker removed, table dropped) backfills exactly one primary row per space', () => {
      db.exec(`DELETE FROM migration_markers WHERE key = 'migration_195'`);
      db.exec(`DROP TABLE space_workspaces`);
      db.exec(`
        INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES
          ('sp-a', 'space-a', '/work/dev/repo-a', 'Space A', 1000, 1000),
          ('sp-b', 'space-b', '/work/dev/repo-b', 'Space B', 1000, 1000)
      `);

      runMigrations(db, () => {});

      const rows = workspaceRows(db);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.is_primary).toBe(1);
        expect(row.label).toBe(row.path.split('/').filter(Boolean).pop());
      }
      // Marker is re-stamped exactly once.
      const marker = db
        .prepare(`SELECT COUNT(*) AS n FROM migration_markers WHERE key = 'migration_195'`)
        .get() as { n: number };
      expect(marker.n).toBe(1);
    });

    test('fresh, fully-migrated DB carries the table with the expected columns', () => {
      try {
        db.close();
      } catch {
        // ignore — replaced by the empty DB below
      }
      db = openEmptyDb(testDir);
      runMigrations(db, () => {});

      const info = db.prepare(`PRAGMA table_info(space_workspaces)`).all() as Array<{
        name: string;
      }>;
      expect(info.map((c) => c.name)).toEqual([
        'id',
        'space_id',
        'path',
        'label',
        'is_primary',
        'created_at',
        'updated_at',
      ]);
      // No spaces on a fresh DB — the backfill produces no rows.
      expect(workspaceRows(db)).toHaveLength(0);
    });
  });
});
