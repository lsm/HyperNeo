import { describe, expect, test } from 'bun:test';
import { runMigration528 } from '../../../../../src/storage/schema/m528-work-start-record.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration528', () => {
  test('preserves legacy ownership while adding start-record fields', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE work_started_sessions (
      adapter TEXT NOT NULL, id TEXT NOT NULL, started_at INTEGER NOT NULL,
      unusable_at INTEGER, released_at INTEGER, claimed_by TEXT, role TEXT,
      PRIMARY KEY (adapter, id)
    );
    INSERT INTO work_started_sessions VALUES ('codex', 'worker', 1, NULL, NULL, NULL, 'worker');
    INSERT INTO work_started_sessions VALUES ('codex', 'claimed', 2, NULL, NULL, 'todo', NULL);`);
    runMigration528(db);
    runMigration528(db);
    expect(db.prepare('SELECT id, kind FROM work_started_sessions ORDER BY id').all()).toEqual([
      { id: 'claimed', kind: null },
      { id: 'worker', kind: 'worker' },
    ]);
    const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'started_by',
        'ask_id',
        'todo_id',
        'machine',
        'folder',
        'harness',
        'provider',
        'model',
        'effort',
        'preparation',
        'release_reason',
        'unusable_reason',
        'archived_at',
        'archive_reason',
      ])
    );
    expect(columns.some((column) => column.name === 'role')).toBe(false);
    db.close();
  });
});
