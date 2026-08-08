/**
 * Migration 179 Tests — `pending_agent_messages.workflow_node_id`.
 *
 * The pending-message queue was keyed only by (workflow_run_id,
 * target_agent_name); M179 adds workflow_node_id so two unstarted nodes reusing
 * a slot name don't cross-receive. These tests cover only the migration itself
 * (column add); the node-scoped drain/retention behavior is covered by the
 * PendingAgentMessageRepository suite.
 *
 * Covers:
 *   - Pre-M179 schema: the column is added.
 *   - Idempotent re-run.
 *   - Fresh, fully-migrated DB carries the column from createTables.
 *   - Missing-table guard (empty DB).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../../src/storage/schema';
import { runMigration179, runMigrations } from '../../../../../src/storage/schema/migrations.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Minimal pre-M179 shape: pending_agent_messages without workflow_node_id. */
function seedPreM179Schema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE pending_agent_messages (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      task_id TEXT,
      source_agent_name TEXT NOT NULL DEFAULT 'task-agent',
      target_kind TEXT NOT NULL,
      target_agent_name TEXT NOT NULL,
      message TEXT NOT NULL,
      idempotency_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_attempt_at INTEGER,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      delivered_at INTEGER,
      delivered_session_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

describe('Migration 179: pending_agent_messages.workflow_node_id', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-179',
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

  describe('pre-M179 schema — add column', () => {
    beforeEach(() => {
      seedPreM179Schema(db);
    });

    test('adds the workflow_node_id column', () => {
      expect(columnNames(db, 'pending_agent_messages')).not.toContain('workflow_node_id');
      runMigration179(db);
      expect(columnNames(db, 'pending_agent_messages')).toContain('workflow_node_id');
    });

    test('existing rows keep a NULL workflow_node_id (legacy, drains for any node)', () => {
      db.prepare(
        `INSERT INTO pending_agent_messages (id, workflow_run_id, space_id, target_kind, target_agent_name, message, expires_at, created_at)
         VALUES ('m1', 'run-1', 'sp1', 'node_agent', 'coder', 'hi', 0, 0)`
      ).run();
      runMigration179(db);
      const row = db
        .prepare(`SELECT workflow_node_id AS n FROM pending_agent_messages WHERE id = ?`)
        .get('m1') as { n: null };
      expect(row.n).toBeNull();
    });

    test('is idempotent — a second run does not throw or duplicate', () => {
      runMigration179(db);
      expect(() => runMigration179(db)).not.toThrow();
      expect(
        columnNames(db, 'pending_agent_messages').filter((c) => c === 'workflow_node_id')
      ).toHaveLength(1);
    });
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('pending_agent_messages carries workflow_node_id from createTables', () => {
      expect(columnNames(db, 'pending_agent_messages')).toContain('workflow_node_id');
    });
  });

  describe('missing table — no-op guard', () => {
    test('runMigration179 on an empty DB does not throw', () => {
      expect(() => runMigration179(db)).not.toThrow();
    });
  });
});
