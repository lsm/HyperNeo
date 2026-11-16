import { describe, expect, test } from 'bun:test';
import { runMigration519 } from '../../../../../src/storage/schema/m519-work-started-role.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration519', () => {
  test('adds the role column once and leaves existing rows without a role', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE work_started_sessions (
        adapter TEXT NOT NULL, id TEXT NOT NULL, started_at INTEGER NOT NULL,
        unusable_at INTEGER, released_at INTEGER, claimed_by TEXT, PRIMARY KEY (adapter, id)
      );
      INSERT INTO work_started_sessions VALUES ('codex', 'w', 1, NULL, NULL, NULL);
    `);
    runMigration519(db);
    runMigration519(db);
    expect(db.prepare('SELECT id, role FROM work_started_sessions').all()).toEqual([
      { id: 'w', role: null },
    ]);
    db.close();
  });

  test('does nothing before the table exists', () => {
    const db = new Database(':memory:');
    runMigration519(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'work_started_sessions'").all()
    ).toEqual([]);
    db.close();
  });
});
