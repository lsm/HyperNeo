import { describe, expect, test } from 'bun:test';
import { runMigration272 } from '../../../../../src/storage/schema/m272-space-session-event-subscriptions.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function columns(db: BunDatabase): string[] {
  return (
    db.prepare(`PRAGMA table_info(space_session_event_subscriptions)`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function insert(db: BunDatabase, id: string, sessionId: string, topic: string): void {
  db.prepare(
    `INSERT INTO space_session_event_subscriptions
       (id, space_id, session_id, topic, label, created_at, updated_at)
     VALUES (?, 'space-1', ?, ?, NULL, 1, 1)`
  ).run(id, sessionId, topic);
}

describe('migration 272: space session event subscriptions', () => {
  test('creates the subscription table and its space index', () => {
    const db = new BunDatabase(':memory:');
    runMigration272(db);

    expect(columns(db)).toEqual([
      'id',
      'space_id',
      'session_id',
      'topic',
      'label',
      'created_at',
      'updated_at',
    ]);
    const index = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_space_session_event_subscriptions_space');
    expect(index).toBeTruthy();
  });

  test('allows one row per session and topic', () => {
    const db = new BunDatabase(':memory:');
    runMigration272(db);
    insert(db, 'sub-1', 'session-1', 'github/a/b/*');
    insert(db, 'sub-2', 'session-2', 'github/a/b/*');

    expect(() => insert(db, 'sub-3', 'session-1', 'github/a/b/*')).toThrow();
  });

  test('deleting a session removes its subscriptions', () => {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO spaces (id) VALUES ('space-1')");
    db.exec("INSERT INTO sessions (id) VALUES ('session-1')");
    runMigration272(db);
    insert(db, 'sub-1', 'session-1', 'github/a/b/*');

    db.exec("DELETE FROM sessions WHERE id = 'session-1'");

    const count = db
      .prepare(`SELECT COUNT(*) AS count FROM space_session_event_subscriptions`)
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  test('is idempotent and keeps existing rows', () => {
    const db = new BunDatabase(':memory:');
    runMigration272(db);
    insert(db, 'sub-1', 'session-1', 'github/a/b/*');

    runMigration272(db);

    const count = db
      .prepare(`SELECT COUNT(*) AS count FROM space_session_event_subscriptions`)
      .get() as { count: number };
    expect(count.count).toBe(1);
  });
});
