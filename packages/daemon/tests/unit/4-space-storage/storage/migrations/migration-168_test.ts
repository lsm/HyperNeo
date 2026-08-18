import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration168 } from '../../../../../src/storage/schema/migrations.ts';

function indexExists(db: BunDatabase, indexName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!row;
}

function explainQueryPlan(db: BunDatabase, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join('\n');
}

function createNodeExecutionsTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE node_executions (
			id TEXT PRIMARY KEY,
			workflow_run_id TEXT NOT NULL,
			workflow_node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			agent_id TEXT,
			agent_session_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL
		)
	`);
}

describe('Migration 168: node_executions(agent_session_id) index', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-168', `test-${Date.now()}`);
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

  test('index is created on an existing node_executions table', () => {
    createNodeExecutionsTable(db);
    expect(indexExists(db, 'idx_node_executions_agent_session')).toBe(false);

    runMigration168(db);

    expect(indexExists(db, 'idx_node_executions_agent_session')).toBe(true);
  });

  test('no-op when node_executions does not exist', () => {
    expect(() => runMigration168(db)).not.toThrow();
    expect(indexExists(db, 'idx_node_executions_agent_session')).toBe(false);
  });

  test('runMigration168 is idempotent — running twice does not error', () => {
    createNodeExecutionsTable(db);
    runMigration168(db);
    expect(() => runMigration168(db)).not.toThrow();
    expect(indexExists(db, 'idx_node_executions_agent_session')).toBe(true);
  });

  test('full migration chain creates the index', () => {
    runMigrations(db, () => {});
    expect(indexExists(db, 'idx_node_executions_agent_session')).toBe(true);
  });

  test('EXPLAIN QUERY PLAN uses the index for WHERE agent_session_id = ?', () => {
    createNodeExecutionsTable(db);
    runMigration168(db);

    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 10; i++) {
      stmt.run(`ne-${i}`, 'run-1', 'node-1', 'agent', `sess-${i}`, 'in_progress', now, now);
    }

    const plan = explainQueryPlan(
      db,
      'SELECT * FROM node_executions WHERE agent_session_id = ?',
      'sess-5'
    );
    expect(plan).toMatch(/SEARCH node_executions USING INDEX idx_node_executions_agent_session/);
    expect(plan).not.toContain('SCAN node_executions');

    const repoPlan = explainQueryPlan(
      db,
      `SELECT 1 FROM node_executions WHERE agent_session_id = ? LIMIT 1`,
      'sess-5'
    );
    expect(repoPlan).toMatch(
      /SEARCH node_executions USING (COVERING )?INDEX idx_node_executions_agent_session/
    );
    expect(repoPlan).not.toContain('SCAN node_executions');
  });

  test('EXPLAIN QUERY PLAN full-scans without the index (regression guard)', () => {
    createNodeExecutionsTable(db);

    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 10; i++) {
      stmt.run(`ne-${i}`, 'run-1', 'node-1', 'agent', `sess-${i}`, 'in_progress', now, now);
    }

    const plan = explainQueryPlan(
      db,
      'SELECT * FROM node_executions WHERE agent_session_id = ?',
      'sess-5'
    );
    expect(plan).toContain('SCAN node_executions');
    expect(plan).not.toContain('idx_node_executions_agent_session');
  });
});
