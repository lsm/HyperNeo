import { describe, expect, test } from 'bun:test';
import { runMigration292 } from '../../../../../src/storage/schema/m292-retire-space-task-agent-sessions.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, session_context TEXT)`);
  return db;
}

function typeOf(db: BunDatabase, id: string): string {
  const row = db.prepare(`SELECT type FROM sessions WHERE id = ?`).get(id) as { type: string };
  return row.type;
}

describe('migration 292: retire space_task_agent sessions', () => {
  test('retypes legacy task agent sessions as workers', () => {
    const db = makeDb();
    db.exec(
      `INSERT INTO sessions VALUES ('task-1', 'space_task_agent', '{"spaceId":"s1","taskId":"t1"}')`
    );

    runMigration292(db);

    expect(typeOf(db, 'task-1')).toBe('worker');
  });

  test('leaves other session types untouched', () => {
    const db = makeDb();
    db.exec(`INSERT INTO sessions VALUES ('w1', 'worker', '{}')`);
    db.exec(`INSERT INTO sessions VALUES ('c1', 'space_chat', '{"spaceId":"s1"}')`);
    db.exec(`INSERT INTO sessions VALUES ('null-type', NULL, '{}')`);

    runMigration292(db);

    expect(typeOf(db, 'w1')).toBe('worker');
    expect(typeOf(db, 'c1')).toBe('space_chat');
    expect(
      (db.prepare(`SELECT type FROM sessions WHERE id = 'null-type'`).get() as { type: null }).type
    ).toBeNull();
  });

  test('is a no-op on a database without a sessions table', () => {
    const db = new BunDatabase(':memory:');

    expect(() => runMigration292(db)).not.toThrow();
  });
});
