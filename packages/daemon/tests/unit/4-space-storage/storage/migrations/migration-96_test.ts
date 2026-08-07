/**
 * Migration 96 Tests — Remove legacy "Full-Cycle Coding Workflow" rows.
 *
 * Covers:
 *   - Deletes Full-Cycle workflow rows that have no active runs
 *   - Preserves Full-Cycle workflow rows that still have active runs
 *     ('pending', 'in_progress', 'blocked'), so in-flight work keeps executing
 *   - Terminal-run rows ('done'/'cancelled') do not count as active and get deleted
 *   - Other built-in workflows are not affected
 *   - Idempotent: running twice is a no-op after the first pass
 *   - No-op when no Full-Cycle rows exist
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, runMigration96 } from '../../../../../src/storage/schema/migrations.ts';

function insertSpace(db: BunDatabase, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, `/ws/${id}`, id, now, now);
}

function insertWorkflow(
  db: BunDatabase,
  opts: { id: string; spaceId: string; name: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflows (
			id, space_id, name, description, start_node_id, end_node_id,
			tags, channels, gates, created_at, updated_at
		 ) VALUES (?, ?, ?, '', NULL, NULL, '[]', '[]', '[]', ?, ?)`
  ).run(opts.id, opts.spaceId, opts.name, now, now);
}

function insertRun(
  db: BunDatabase,
  opts: { id: string; spaceId: string; workflowId: string; status: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.id, opts.spaceId, opts.workflowId, 'run', opts.status, now, now);
}

function workflowExists(db: BunDatabase, id: string): boolean {
  const row = db.prepare(`SELECT id FROM space_workflows WHERE id = ?`).get(id);
  return row !== null && row !== undefined;
}

describe('Migration 96: remove legacy Full-Cycle Coding Workflow rows', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-96',
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
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ─── Orphan Full-Cycle rows (no active runs) ─────────────────────────────

  test('deletes Full-Cycle workflow row with no runs at all', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    expect(workflowExists(db, 'wf-fc')).toBe(true);

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(false);
  });

  test('deletes Full-Cycle workflow row with only terminal runs (done)', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'done',
    });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(false);
  });

  test('deletes Full-Cycle workflow row with only cancelled runs', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'cancelled',
    });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(false);
  });

  test('deletes Full-Cycle workflow rows across multiple spaces', () => {
    insertSpace(db, 'sp-2');
    insertWorkflow(db, { id: 'wf-fc-1', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertWorkflow(db, { id: 'wf-fc-2', spaceId: 'sp-2', name: 'Full-Cycle Coding Workflow' });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc-1')).toBe(false);
    expect(workflowExists(db, 'wf-fc-2')).toBe(false);
  });

  // ─── Full-Cycle rows with active runs are preserved ──────────────────────

  test('preserves Full-Cycle row with a pending run', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'pending',
    });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(true);
  });

  test('preserves Full-Cycle row with an in_progress run', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'in_progress',
    });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(true);
  });

  test('preserves Full-Cycle row with a blocked run', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'blocked',
    });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(true);
  });

  test('preserves Full-Cycle row when it has both terminal and active runs', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });
    insertRun(db, {
      id: 'run-done',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'done',
    });
    insertRun(db, {
      id: 'run-live',
      spaceId: 'sp-1',
      workflowId: 'wf-fc',
      status: 'in_progress',
    });

    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(true);
  });

  // ─── Non-Full-Cycle workflows are left alone ─────────────────────────────

  test('does not touch other built-in workflows', () => {
    insertWorkflow(db, { id: 'wf-coding', spaceId: 'sp-1', name: 'Coding Workflow' });
    insertWorkflow(db, { id: 'wf-plan', spaceId: 'sp-1', name: 'Plan & Decompose Workflow' });
    insertWorkflow(db, { id: 'wf-research', spaceId: 'sp-1', name: 'Research Workflow' });
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });

    runMigration96(db);

    expect(workflowExists(db, 'wf-coding')).toBe(true);
    expect(workflowExists(db, 'wf-plan')).toBe(true);
    expect(workflowExists(db, 'wf-research')).toBe(true);
    expect(workflowExists(db, 'wf-fc')).toBe(false);
  });

  test('does not delete a custom workflow that is merely tagged like Full-Cycle', () => {
    // Matching is on exact name — a workflow named differently should survive
    insertWorkflow(db, { id: 'wf-custom', spaceId: 'sp-1', name: 'My Full-Cycle Variant' });

    runMigration96(db);

    expect(workflowExists(db, 'wf-custom')).toBe(true);
  });

  // ─── Idempotency / no-op cases ────────────────────────────────────────────

  test('is a no-op when no Full-Cycle rows exist', () => {
    insertWorkflow(db, { id: 'wf-coding', spaceId: 'sp-1', name: 'Coding Workflow' });

    runMigration96(db);

    expect(workflowExists(db, 'wf-coding')).toBe(true);
  });

  test('running twice yields the same result (idempotent)', () => {
    insertWorkflow(db, { id: 'wf-fc', spaceId: 'sp-1', name: 'Full-Cycle Coding Workflow' });

    runMigration96(db);
    runMigration96(db);

    expect(workflowExists(db, 'wf-fc')).toBe(false);
  });
});
