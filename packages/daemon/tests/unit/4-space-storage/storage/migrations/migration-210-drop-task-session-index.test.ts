import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTables } from '../../../../../src/storage/schema/index';
import { runMigration210, runMigrations } from '../../../../../src/storage/schema/migrations';

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function createPre210SdkMessages(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      session_id TEXT NOT NULL,
      conversation_turn_index INTEGER
    )
  `);
  db.exec(`CREATE INDEX idx_sdk_messages_task_session
    ON sdk_messages(task_id, session_id)`);
  db.exec(`CREATE INDEX idx_sdk_messages_task_session_turn
    ON sdk_messages(task_id, session_id, conversation_turn_index)`);
}

function queryPlan(db: BunDatabase, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join(' | ');
}

describe('Migration 210: drop redundant sdk_messages task-session index', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('fresh schema creates only the covering task-session-turn index', () => {
    createTables(db);
    runMigrations(db, () => {});
    expect(indexExists(db, 'idx_sdk_messages_task_session')).toBe(false);
    expect(indexExists(db, 'idx_sdk_messages_task_session_turn')).toBe(true);
  });

  test('drops the strict-prefix index and preserves its covering replacement', () => {
    createPre210SdkMessages(db);
    runMigration210(db);
    expect(indexExists(db, 'idx_sdk_messages_task_session')).toBe(false);
    expect(indexExists(db, 'idx_sdk_messages_task_session_turn')).toBe(true);
  });

  test('task-session query shapes remain covering seeks after the drop', () => {
    createPre210SdkMessages(db);
    runMigration210(db);
    const distinctPlan = queryPlan(
      db,
      `SELECT DISTINCT session_id FROM sdk_messages WHERE task_id = 'task-1'`
    );
    const existencePlan = queryPlan(
      db,
      `SELECT 1 FROM sdk_messages
       WHERE task_id = 'task-1' AND session_id = 'session-1' LIMIT 1`
    );
    expect(distinctPlan).toContain('idx_sdk_messages_task_session_turn');
    expect(distinctPlan).toContain('COVERING INDEX');
    expect(existencePlan).toContain('idx_sdk_messages_task_session_turn');
    expect(existencePlan).toContain('COVERING INDEX');
    expect(`${distinctPlan} | ${existencePlan}`).not.toContain('SCAN sdk_messages');
  });

  test('is idempotent', () => {
    createPre210SdkMessages(db);
    runMigration210(db);
    expect(() => runMigration210(db)).not.toThrow();
  });

  test('is a no-op without sdk_messages', () => {
    expect(() => runMigration210(db)).not.toThrow();
  });
});
