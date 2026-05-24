/**
 * Migration 97 Tests — Delete orphan built-in workflow rows.
 *
 * Migration 97 removes pre-template-tracking rows that share a name with a
 * known built-in template but have `template_name IS NULL`. The
 * `space_workflow_runs.workflow_id` FK no longer cascades (migration 60
 * rebuilt the table without it), so the migration deletes dependent runs
 * explicitly before removing the workflow row.
 *
 * Covers:
 *   - Orphan row for each known built-in name is deleted
 *   - Rows with `template_name` set (even if they share the built-in name) are preserved
 *   - Idempotency: running the migration twice leaves the DB unchanged
 *   - Custom workflows with `template_name IS NULL` and a non-built-in name are
 *     preserved (the migration only targets known built-in names)
 *   - Sibling rows (nodes, runs) are removed when an orphan is deleted
 *   - No-op on a DB with no matching rows
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration97 } from '../../../../../src/storage/schema/migrations.ts';

interface WorkflowRow {
  id: string;
  name: string;
  template_name: string | null;
}

const BUILT_IN_NAMES = [
  'Coding Workflow',
  'Coding with QA Workflow',
  'Full-Cycle Coding Workflow',
  'Fullstack QA Loop Workflow',
  'Plan & Decompose Workflow',
  'Research Workflow',
  'Review-Only Workflow',
];

function insertSpace(db: BunDatabase, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, '/ws', id, now, now);
}

function insertWorkflow(
  db: BunDatabase,
  opts: {
    id: string;
    spaceId: string;
    name: string;
    templateName?: string | null;
    templateHash?: string | null;
    createdAt?: number;
  }
): void {
  const now = opts.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO space_workflows (
			id, space_id, name, description, start_node_id, end_node_id,
			tags, channels, gates, created_at, updated_at, template_name, template_hash
		 ) VALUES (?, ?, ?, '', NULL, NULL, '[]', '[]', '[]', ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.spaceId,
    opts.name,
    now,
    now,
    opts.templateName ?? null,
    opts.templateHash ?? null
  );
}

function insertNode(db: BunDatabase, opts: { id: string; workflowId: string; name: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
		 VALUES (?, ?, ?, '{}', ?, ?)`
  ).run(opts.id, opts.workflowId, opts.name, now, now);
}

function insertRun(
  db: BunDatabase,
  opts: { id: string; spaceId: string; workflowId: string; status: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'run', ?, ?, ?)`
  ).run(opts.id, opts.spaceId, opts.workflowId, opts.status, now, now);
}

function listWorkflows(db: BunDatabase): WorkflowRow[] {
  return db
    .prepare(`SELECT id, name, template_name FROM space_workflows ORDER BY name, id`)
    .all() as WorkflowRow[];
}

describe('Migration 97: delete orphan built-in workflow rows', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-97',
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

  test('deletes orphan row for each built-in name', () => {
    // Insert one orphan (template_name IS NULL) for every built-in name,
    // plus one backfilled sibling sharing the same name to verify the
    // sibling is preserved.
    for (const [i, name] of BUILT_IN_NAMES.entries()) {
      insertWorkflow(db, {
        id: `wf-orphan-${i}`,
        spaceId: 'sp-1',
        name,
        templateName: null,
        templateHash: null,
        createdAt: 1000,
      });
      insertWorkflow(db, {
        id: `wf-keep-${i}`,
        spaceId: 'sp-1',
        name,
        templateName: name,
        templateHash: 'hash-abc',
        createdAt: 2000,
      });
    }

    runMigration97(db);

    const rows = listWorkflows(db);
    // Orphans gone, siblings remain.
    expect(rows.some((r) => r.id.startsWith('wf-orphan-'))).toBe(false);
    expect(rows.filter((r) => r.id.startsWith('wf-keep-'))).toHaveLength(BUILT_IN_NAMES.length);
    // Sanity — every remaining built-in row has its template_name set.
    for (const r of rows) {
      if (BUILT_IN_NAMES.includes(r.name)) {
        expect(r.template_name).not.toBeNull();
      }
    }
  });

  test('is idempotent — second run is a no-op', () => {
    insertWorkflow(db, {
      id: 'wf-keep-1',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      templateHash: 'h',
    });
    insertWorkflow(db, {
      id: 'wf-orphan-1',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: null,
    });

    runMigration97(db);
    const after1 = listWorkflows(db);

    runMigration97(db);
    const after2 = listWorkflows(db);

    expect(after2).toEqual(after1);
    expect(after1.some((r) => r.id === 'wf-orphan-1')).toBe(false);
    expect(after1.some((r) => r.id === 'wf-keep-1')).toBe(true);
  });

  test('preserves custom (non-built-in) workflows with template_name IS NULL', () => {
    insertWorkflow(db, {
      id: 'wf-custom',
      spaceId: 'sp-1',
      name: 'My Custom Workflow',
      templateName: null,
    });

    runMigration97(db);

    const rows = listWorkflows(db);
    expect(rows.find((r) => r.id === 'wf-custom')).toBeDefined();
  });

  test('preserves rows that share a built-in name but already have template_name set', () => {
    // Two rows with the Coding Workflow name; both backfilled. Neither should
    // be touched.
    insertWorkflow(db, {
      id: 'wf-a',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      templateHash: 'aaa',
      createdAt: 1000,
    });
    insertWorkflow(db, {
      id: 'wf-b',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      templateHash: 'bbb',
      createdAt: 2000,
    });

    runMigration97(db);

    const rows = listWorkflows(db);
    expect(rows.find((r) => r.id === 'wf-a')).toBeDefined();
    expect(rows.find((r) => r.id === 'wf-b')).toBeDefined();
  });

  test('cascade-deletes nodes and runs when an orphan is removed', () => {
    insertWorkflow(db, {
      id: 'wf-orphan',
      spaceId: 'sp-1',
      name: 'Research Workflow',
      templateName: null,
    });
    insertNode(db, { id: 'n-1', workflowId: 'wf-orphan', name: 'Research' });
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: 'wf-orphan',
      status: 'in_progress',
    });

    runMigration97(db);

    const nodes = db
      .prepare(`SELECT id FROM space_workflow_nodes WHERE workflow_id = ?`)
      .all('wf-orphan');
    const runs = db
      .prepare(`SELECT id FROM space_workflow_runs WHERE workflow_id = ?`)
      .all('wf-orphan');
    expect(nodes).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });

  test('no-op when the DB has no orphan built-in rows', () => {
    insertWorkflow(db, {
      id: 'wf-ok',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      templateHash: 'h',
    });

    const before = listWorkflows(db);
    runMigration97(db);
    const after = listWorkflows(db);

    expect(after).toEqual(before);
  });
});
