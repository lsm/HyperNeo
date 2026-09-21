import { describe, expect, test } from 'bun:test';
import { runMigration266 } from '../../../../../src/storage/schema/index.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('migration 266', () => {
  test('creates the task assistant partial index idempotently', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      message_type TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )`);

    runMigration266(db);
    runMigration266(db);

    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_sdk_messages_task_assistant') as { sql: string } | null;
    expect(index?.sql).toContain('ON sdk_messages(task_id, timestamp DESC)');
    expect(index?.sql).toContain("WHERE message_type = 'assistant'");
    db.close();
  });

  test('skips an sdk_messages table that predates task_id', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )`);

    expect(() => runMigration266(db)).not.toThrow();

    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_sdk_messages_task_assistant');
    expect(index).toBeNull();
    db.close();
  });
});
