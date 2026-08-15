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
      `INSERT INTO space_workflows (id, space_id, name, hooks, hook_bindings, created_at, updated_at)
       VALUES ('wf-1', 'sp-1', 'W', '[{"id":"pr_ready"}]', ?, 1, 1)`
    ).run(
      JSON.stringify([
        {
          hookId: 'pr_ready',
          sourceNode: 'W',
          targetNode: 'W',
          method: 'send_message',
          enabled: true,
          authorizedCallers: [{ sourceNode: 'W' }],
        },
      ])
    );
    // Node rows so repository-equivalent binding validation can resolve
    // node references (the fixtures' bindings reference node 'W').
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
       VALUES ('n-w', 'wf-1', 'W', ?, 1, 1)`
    ).run(JSON.stringify({ agents: [{ agentId: 'a1', name: 'worker' }] }));
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

  test('a DONE run with any non-archived (reopenable) task blocks the drop', () => {
    // The repository's executable-run predicate: a done/cancelled run with a
    // non-archived task is reopenable and later pinned by
    // backfillDefinitionPins — the pin would snapshot an ungated head.
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, depends_on, created_at, updated_at)
         VALUES ('task-open', 'sp-1', 1, 'T', '', 'open', 'normal', '[]', 'run-1', '[]', 1, 1)`
      ).run();

      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);

      // Archiving the task (no longer reopenable) lets the drop complete.
      db.prepare(`UPDATE space_tasks SET status = 'archived' WHERE id = 'task-open'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
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

  test('a deferred 197 skips the full-database backup on every retry', async () => {
    // The deferral re-runs on EVERY startup; an unconditional ensureBackup
    // before the migration callback would copy the whole database at each
    // boot for as long as the deferral holds (permanently for a custom
    // legacy workflow). The runner's precheck must skip the backup.
    const db = makeLegacyDb();
    try {
      // Reset the 197 marker (makeLegacyDb's initial runMigrations marked it).
      const keyRow = db
        .prepare(`SELECT key FROM migration_markers WHERE key LIKE '%197%'`)
        .all() as Array<{ key: string }>;
      for (const row of keyRow) {
        db.prepare(`DELETE FROM migration_markers WHERE key = ?`).run(row.key);
      }
      db.prepare(`UPDATE space_workflows SET hook_bindings = NULL WHERE id = 'wf-1'`).run();

      let backups = 0;
      runMigrations(db, () => {
        backups += 1;
      });
      // Deferral guard held: column kept, unmarked, and NO backup was taken
      // for the deferred migration (the in-memory DB never triggered other
      // migrations — all are marked from the initial run).
      expect(hasHooksColumn(db)).toBe(true);
      expect(backups).toBe(0);
    } finally {
      db.close();
    }
  });

  test('malformed hook_bindings JSON defers (does not abort startup)', () => {
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflows SET hook_bindings = ? WHERE id = 'wf-1'`).run('{}');
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      // A shapeless parsed value must defer (legacy column kept), not throw
      // out of migration197Defers and kill daemon startup.
      expect(() => {
        const result = runMigration197(db);
        expect(result).toBe(false);
      }).not.toThrow();
      expect(hasHooksColumn(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test('repository-equivalent validation: a bad METHOD defers the drop (round 87)', () => {
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflows SET hook_bindings = ? WHERE id = 'wf-1'`).run(
        JSON.stringify([
          {
            hookId: 'pr_ready',
            sourceNode: 'W',
            targetNode: 'W',
            method: 'send_messag',
            enabled: true,
            authorizedCallers: [{ sourceNode: 'W' }],
          },
        ])
      );
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      const result = runMigration197(db);
      expect(result).toBe(false);
      expect(hasHooksColumn(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test('a shape-valid binding missing required fields defers the drop (round 86)', () => {
    // hookId matches the legacy id but the binding lacks sourceNode/method/
    // enabled/callers — the repository decodes it as CORRUPT, so dropping
    // the legacy column would strand the workflow fail-closed with no
    // recoverable definitions. The migration must defer.
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflows SET hook_bindings = ? WHERE id = 'wf-1'`).run(
        '[{"hookId":"pr_ready"}]'
      );
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      const result = runMigration197(db);
      expect(result).toBe(false);
      expect(hasHooksColumn(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test('legacy hooks WITHOUT v2 bindings block the drop even with no runs (restamp window)', () => {
    // The v2 bindings for existing built-ins are installed by the LATER
    // fire-and-forget startup restamp; dropping the column during DB
    // construction would leave the head with neither for the whole window
    // (or permanently, when the restamp keeps failing). The legacy-hook
    // guard still needs the column to fail such runs closed.
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflows SET hook_bindings = NULL WHERE id = 'wf-1'`).run();
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      // No active runs, but the head is unconverted: deferred.
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);
      // The restamp converges (bindings populated): the drop completes.
      db.prepare(`UPDATE space_workflows SET hook_bindings = ? WHERE id = 'wf-1'`).run(
        JSON.stringify([
          {
            hookId: 'pr_ready',
            sourceNode: 'W',
            targetNode: 'W',
            method: 'send_message',
            enabled: true,
            authorizedCallers: [{ sourceNode: 'W' }],
          },
        ])
      );
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('empty-string and empty-array hook_bindings count as unconverted', () => {
    const db = makeLegacyDb();
    try {
      db.prepare(`UPDATE space_workflows SET hook_bindings = '' WHERE id = 'wf-1'`).run();
      db.prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = 'run-1'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);
      db.prepare(`UPDATE space_workflows SET hook_bindings = '[]' WHERE id = 'wf-1'`).run();
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(true);
      db.prepare(`UPDATE space_workflows SET hook_bindings = ? WHERE id = 'wf-1'`).run(
        JSON.stringify([
          {
            hookId: 'pr_ready',
            sourceNode: 'W',
            targetNode: 'W',
            method: 'send_message',
            enabled: true,
            authorizedCallers: [{ sourceNode: 'W' }],
          },
        ])
      );
      runMigration197(db);
      expect(hasHooksColumn(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});
