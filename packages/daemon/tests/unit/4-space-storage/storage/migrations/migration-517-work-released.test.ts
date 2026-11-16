import { describe, expect, test } from 'bun:test';
import { runMigration517 } from '../../../../../src/storage/schema/m517-work-released.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration517', () => {
  test('adds the release and claim columns once and leaves existing rows alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE work_started_sessions (
        adapter TEXT NOT NULL, id TEXT NOT NULL, started_at INTEGER NOT NULL,
        unusable_at INTEGER, PRIMARY KEY (adapter, id)
      );
      INSERT INTO work_started_sessions VALUES ('codex', 'w', 1, NULL);
    `);
    runMigration517(db);
    runMigration517(db);
    expect(db.prepare('SELECT * FROM work_started_sessions').all()).toEqual([
      {
        adapter: 'codex',
        id: 'w',
        started_at: 1,
        unusable_at: null,
        released_at: null,
        claimed_by: null,
      },
    ]);
    db.close();
  });

  test('does nothing before the table exists', () => {
    const db = new Database(':memory:');
    runMigration517(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'work_started_sessions'").all()
    ).toEqual([]);
    db.close();
  });
});
