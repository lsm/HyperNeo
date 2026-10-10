import { describe, expect, test } from 'bun:test';
import { runMigration319 } from '../../../../src/storage/schema/m319-archive-room-sessions';
import { Database } from '../../../../src/storage/sqlite-compat';

const NOW = '2026-10-09T00:00:00.000Z';

function seed(db: Database): void {
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    type TEXT,
    session_context TEXT,
    archived_at TEXT
  )`);
  const insert = db.prepare(
    'INSERT INTO sessions (id, status, type, session_context, archived_at) VALUES (?, ?, ?, ?, ?)'
  );
  insert.run('room-worker', 'active', 'worker', '{"roomId":"room-1"}', null);
  insert.run('room-general', 'active', 'general', '{"roomId":"room-1"}', null);
  insert.run('room-null-type', 'ended', null, '{"roomId":"room-2"}', null);
  insert.run(
    'room-archived',
    'archived',
    'worker',
    '{"roomId":"room-1"}',
    '2026-04-01T00:00:00.000Z'
  );
  insert.run('room-coder', 'active', 'coder', '{"roomId":"room-1"}', null);
  insert.run('plain', 'active', 'worker', null, null);
  insert.run('space', 'active', 'worker', '{"spaceId":"space-1"}', null);
  insert.run('malformed', 'active', 'worker', '{roomId', null);
}

const rows = (db: Database) =>
  db.prepare('SELECT id, status, session_context, archived_at FROM sessions ORDER BY id').all() as {
    id: string;
    status: string;
    session_context: string | null;
    archived_at: string | null;
  }[];

describe('runMigration319', () => {
  test('archives user room sessions and keeps their context for later use', () => {
    const db = new Database(':memory:');
    seed(db);
    runMigration319(db, NOW);
    runMigration319(db, '2027-01-01T00:00:00.000Z');

    const byId = new Map(rows(db).map((row) => [row.id, row]));
    for (const id of ['room-worker', 'room-general', 'room-null-type']) {
      expect(byId.get(id)?.status).toBe('archived');
      expect(byId.get(id)?.archived_at).toBe(NOW);
      expect(byId.get(id)?.session_context).toContain('"roomId"');
    }
    expect(byId.get('room-archived')?.archived_at).toBe('2026-04-01T00:00:00.000Z');
    for (const id of ['room-coder', 'plain', 'space', 'malformed']) {
      expect(byId.get(id)?.status).toBe('active');
      expect(byId.get(id)?.archived_at).toBeNull();
    }
    expect(byId.size).toBe(8);
  });

  test('skips databases without sessions', () => {
    const db = new Database(':memory:');
    runMigration319(db, NOW);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
});
