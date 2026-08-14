import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, runMigration197 } from '../../../../../src/storage/schema/migrations.ts';

function hasHooksColumn(db: BunDatabase): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('space_workflows') WHERE name = 'hooks'`)
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Migration 194's ordering guard: the hooks column drop must be DEFERRED while
 * an unpinned non-terminal run still references legacy hooks (its pin would
 * otherwise be backfilled from the post-drop head — neither hooks nor
 * hookBindings — making the run invisible to the legacy-hook guard). Once the
 * blocking runs are terminal, the drop completes.
 */
describe('Migration 194 deferred hooks drop', () => {
  function makeLegacyDb(): BunDatabase {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    // Simulate a pre-194 schema: the retired column still present and carrying
    // legacy hook definitions.
    db.exec(`ALTER TABLE space_workflows ADD COLUMN hooks TEXT`);
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, created_at, updated_at)
       VALUES ('sp-1', 'sp-1', 'Space', '/tmp/sp-1', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, hooks, created_at, updated_at)
       VALUES ('wf-1', 'sp-1', 'W', '[{"id":"pr_ready"}]', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, definition_version, created_at, updated_at)
       VALUES ('run-1', 'sp-1', 'wf-1', 'R', 'in_progress', NULL, 1, 1)`
    ).run();
    return db;
  }

  test('defers the drop while an unpinned non-terminal run references legacy hooks', () => {
    const db = makeLegacyDb();
    try {
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);

      // Terminal runs no longer block: the drop completes on the next pass.
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('the runner leaves the migration UNMARKED while deferred, and marks it on completion', () => {
    const db = makeLegacyDb();
    try {
      // Reset m194's marker so the runner path executes (makeLegacyDb's
      // initial runMigrations saw no hooks column and marked it as applied).
      const keyRow = db
        .prepare(`SELECT key FROM migration_markers WHERE key LIKE '%197%'`)
        .all() as Array<{ key: string }>;
      for (const row of keyRow) {
        db.prepare(`DELETE FROM migration_markers WHERE key = ?`).run(row.key);
      }

      // Deferred: column kept AND marker unset (so it retries next startup).
      runMigrations(db, () => {});
      expect(hasHooksColumn(db)).toBe(true);
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM migration_markers WHERE key LIKE '%197%'`)
            .get() as {
            n: number;
          }
        ).n
      ).toBe(0);

      // Blocking run terminal: the retried migration completes and is marked.
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      runMigrations(db, () => {});
      expect(hasHooksColumn(db)).toBe(false);
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM migration_markers WHERE key LIKE '%197%'`)
            .get() as {
            n: number;
          }
        ).n
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  test('an APPROVED post-approval task on a DONE run blocks the drop', () => {
    // The runtime marks the run `done` before dispatching post-approval work;
    // the startup restamp defers on hasApprovedTaskForWorkflow, and the drop
    // must mirror it — or the resumed post-approval worker would find neither
    // v2 bindings nor the legacy hooks the fail-closed guard needs.
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, depends_on, created_at, updated_at)
         VALUES ('task-1', 'sp-1', 1, 'T', '', 'approved', 'normal', '[]', 'run-1', '[]', 1, 1)`
      ).run();

      // Approved post-approval work: deferred.
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);

      // Archived (no longer resumable): the drop completes.
      db.prepare(`UPDATE space_tasks SET status = 'archived' WHERE id = 'task-1'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('a PINNED non-terminal run also blocks the drop (the restamp defers too)', () => {
    // The built-in restamp defers adding v2 hookBindings while any run is
    // active, so a pinned run's workflow head can be equally ungated — the
    // drop must wait regardless of pin state.
    const db = makeLegacyDb();
    try {
      // definition_version carries an FK into definition_versions; bypass it —
      // this test only exercises the migration's predicate, not pin integrity.
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare(
        `UPDATE space_workflow_runs SET definition_version = 'abc123' WHERE id = 'run-1'`
      ).run();
      db.exec('PRAGMA foreign_keys = ON');
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);
      // All runs terminal: the drop completes.
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('a run on a workflow WITHOUT legacy hooks does not block the drop', () => {
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflows SET hooks = '[]' WHERE id = 'wf-1'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});
