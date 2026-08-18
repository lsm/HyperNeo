import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration176 } from '../../../../../src/storage/schema/migrations.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function createSpaceTasksTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'open'
		)
	`);
}

describe('Migration 176: space_tasks.post_approval_source_node_id', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-176', `test-${Date.now()}`);
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

  test('column is added on an existing space_tasks table', () => {
    createSpaceTasksTable(db);
    expect(columnNames(db, 'space_tasks')).not.toContain('post_approval_source_node_id');

    runMigration176(db);

    expect(columnNames(db, 'space_tasks')).toContain('post_approval_source_node_id');
  });

  test('no-op when space_tasks does not exist', () => {
    expect(() => runMigration176(db)).not.toThrow();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
      .get();
    expect(row).toBeNull();
  });

  test('runMigration176 is idempotent — running twice does not error', () => {
    createSpaceTasksTable(db);
    runMigration176(db);
    expect(() => runMigration176(db)).not.toThrow();
    expect(columnNames(db, 'space_tasks')).toContain('post_approval_source_node_id');
  });

  test('full migration chain creates the column', () => {
    runMigrations(db, () => {});
    expect(columnNames(db, 'space_tasks')).toContain('post_approval_source_node_id');
  });

  test('column is nullable — existing rows and new inserts default to NULL', () => {
    createSpaceTasksTable(db);
    db.prepare(`INSERT INTO space_tasks (id, status) VALUES (?, ?)`).run('t-1', 'open');

    runMigration176(db);

    const existing = db
      .prepare(`SELECT post_approval_source_node_id AS v FROM space_tasks WHERE id = ?`)
      .get('t-1') as { v: string | null } | undefined;
    expect(existing?.v).toBeNull();

    db.prepare(`INSERT INTO space_tasks (id, status) VALUES (?, ?)`).run('t-2', 'review');
    const inserted = db
      .prepare(`SELECT post_approval_source_node_id AS v FROM space_tasks WHERE id = ?`)
      .get('t-2') as { v: string | null } | undefined;
    expect(inserted?.v).toBeNull();

    db.prepare(`UPDATE space_tasks SET post_approval_source_node_id = ? WHERE id = ?`).run(
      'node-review',
      't-2'
    );
    const updated = db
      .prepare(`SELECT post_approval_source_node_id AS v FROM space_tasks WHERE id = ?`)
      .get('t-2') as { v: string | null } | undefined;
    expect(updated?.v).toBe('node-review');
  });

  test('backfill copies the pending source for in-flight rows (review/approved + completion-signalled in_progress)', () => {
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'open',
				reported_status TEXT DEFAULT NULL,
				pending_completion_submitted_by_node_id TEXT DEFAULT NULL
			)
		`);
    const ins = db.prepare(
      `INSERT INTO space_tasks (id, status, reported_status, pending_completion_submitted_by_node_id) VALUES (?, ?, ?, ?)`
    );
    ins.run('review-1', 'review', null, 'node-review');
    ins.run('approved-1', 'approved', null, 'node-approver');
    ins.run('done-1', 'done', null, null);
    ins.run('done-2', 'done', null, 'stale-audit-node');
    ins.run('cancelled-1', 'cancelled', null, 'stale-cancel-node');
    ins.run('ip-signalled', 'in_progress', 'done', 'node-approver-ip');
    ins.run('ip-plain', 'in_progress', null, 'node-plain');

    runMigration176(db);

    const select = (id: string): string | null =>
      (
        db
          .prepare(`SELECT post_approval_source_node_id AS v FROM space_tasks WHERE id = ?`)
          .get(id) as { v: string | null } | undefined
      )?.v ?? null;
    expect(select('review-1')).toBe('node-review');
    expect(select('approved-1')).toBe('node-approver');
    expect(select('ip-signalled')).toBe('node-approver-ip');
    expect(select('done-1')).toBeNull();
    expect(select('done-2')).toBeNull();
    expect(select('cancelled-1')).toBeNull();
    expect(select('ip-plain')).toBeNull();
  });

  test('clears the four pending-completion fields on crash-stranded approved rows (source preserved)', () => {
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'open',
				pending_checkpoint_type TEXT DEFAULT NULL,
				pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
				pending_completion_submitted_at INTEGER DEFAULT NULL,
				pending_completion_reason TEXT DEFAULT NULL
			)
		`);
    const ins = db.prepare(
      `INSERT INTO space_tasks (id, status, pending_checkpoint_type, pending_completion_submitted_by_node_id, pending_completion_submitted_at, pending_completion_reason) VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run('approved-1', 'approved', 'task_completion', 'node-approver', 123, 'ready');
    ins.run('review-1', 'review', 'task_completion', 'node-review', 456, 'please');
    ins.run('ip-plain', 'in_progress', 'task_completion', 'node-ip', 789, 'wip');
    ins.run('approved-clean', 'approved', null, null, null, null);

    runMigration176(db);

    const row = (id: string) =>
      db
        .prepare(
          `SELECT post_approval_source_node_id AS src,
                  pending_checkpoint_type AS pct,
                  pending_completion_submitted_by_node_id AS pn,
                  pending_completion_submitted_at AS pat,
                  pending_completion_reason AS pr
             FROM space_tasks WHERE id = ?`
        )
        .get(id) as Record<string, string | number | null>;

    const approved = row('approved-1');
    expect(approved.src).toBe('node-approver');
    expect(approved.pct).toBeNull();
    expect(approved.pn).toBeNull();
    expect(approved.pat).toBeNull();
    expect(approved.pr).toBeNull();

    const review = row('review-1');
    expect(review.src).toBe('node-review');
    expect(review.pct).toBe('task_completion');
    expect(review.pn).toBe('node-review');
    expect(review.pat).toBe(456);
    expect(review.pr).toBe('please');

    const ip = row('ip-plain');
    expect(ip.src).toBeNull();
    expect(ip.pct).toBe('task_completion');
    expect(ip.pn).toBe('node-ip');

    const clean = row('approved-clean');
    expect(clean.src).toBeNull();
    expect(clean.pct).toBeNull();
  });

  test('backfill is idempotent — re-running does not clobber a since-cleared source', () => {
    db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'open',
				pending_completion_submitted_by_node_id TEXT DEFAULT NULL
			)
		`);
    db.prepare(
      `INSERT INTO space_tasks (id, status, pending_completion_submitted_by_node_id) VALUES (?, ?, ?)`
    ).run('t-1', 'review', 'node-original');

    runMigration176(db);
    db.prepare(
      `UPDATE space_tasks SET pending_completion_submitted_by_node_id = NULL WHERE id = ?`
    ).run('t-1');
    runMigration176(db);

    const v = (
      db
        .prepare(`SELECT post_approval_source_node_id AS v FROM space_tasks WHERE id = ?`)
        .get('t-1') as { v: string | null } | undefined
    )?.v;
    expect(v).toBe('node-original');
  });
});
