import { describe, expect, test } from 'bun:test';
import { runMigration476 } from '../../../../../src/storage/schema/m476-neo-todo-approved-at.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

function seeded() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE neo_todos (id TEXT PRIMARY KEY, ask_id TEXT, state TEXT, blocked_by TEXT,
      blocked_reason TEXT, started_at INTEGER, finished_at INTEGER, updated_at INTEGER);
    CREATE TABLE neo_questions (id TEXT PRIMARY KEY, ask_id TEXT, kind TEXT, state TEXT,
      start_todos TEXT);
  `);
  const todo = db.prepare(`INSERT INTO neo_todos VALUES (?, ?, ?, ?, ?, ?, NULL, 9)`);
  todo.run('started', 'running', 'doing', null, null, 5);
  todo.run('queued', 'running', 'todo', null, null, null);
  todo.run('paused', 'running', 'blocked', 'held', 'Human said wait.', null);
  todo.run('unticked', 'running', 'blocked', 'held', 'Not ticked in the start answer.', null);
  todo.run('listed', 'running', 'blocked', 'question', null, null);
  todo.run('fresh', 'unstarted', 'todo', null, null, null);
  todo.run('answered', 'approved', 'todo', null, null, null);
  const question = db.prepare(`INSERT INTO neo_questions VALUES (?, ?, 'start', ?, ?)`);
  question.run('open', 'running', 'open', '["listed"]');
  question.run('done', 'approved', 'answered', '[]');
  return db;
}

describe('migration 476 neo todo approved at', () => {
  test('keeps what runs today and leaves unapproved work on its card', () => {
    const db = seeded();
    runMigration476(db);
    runMigration476(db);
    const rows = db.prepare('SELECT id, approved_at AS at FROM neo_todos').all() as {
      id: string;
      at: number | null;
    }[];
    expect(Object.fromEntries(rows.map((row) => [row.id, row.at]))).toEqual({
      started: 5,
      queued: 9,
      paused: 9,
      unticked: null,
      listed: null,
      fresh: null,
      answered: 9,
    });
    db.close();
  });

  test('a backfill that fails leaves nothing for the rerun to skip', () => {
    const db = seeded();
    db.exec('ALTER TABLE neo_questions RENAME TO neo_questions_later');
    expect(() => runMigration476(db)).toThrow();
    db.exec('ALTER TABLE neo_questions_later RENAME TO neo_questions');
    runMigration476(db);
    const queued = db.prepare("SELECT approved_at AS at FROM neo_todos WHERE id = 'queued'").get();
    expect(queued).toEqual({ at: 9 });
    db.close();
  });
});
