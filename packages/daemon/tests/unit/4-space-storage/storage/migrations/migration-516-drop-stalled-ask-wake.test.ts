import { describe, expect, test } from 'bun:test';
import { runMigration516 } from '../../../../../src/storage/schema/m516-drop-stalled-ask-wake.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(
    (column) => column.name
  );

describe('runMigration516', () => {
  test('drops stalled_wake_at once and keeps every ask', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_asks (id TEXT PRIMARY KEY, title TEXT NOT NULL, stalled_wake_at INTEGER);
      INSERT INTO neo_asks VALUES ('told', 'Told', 7), ('quiet', 'Quiet', NULL);
    `);
    runMigration516(db);
    runMigration516(db);
    expect(columns(db)).toEqual(['id', 'title']);
    expect(db.prepare('SELECT id, title FROM neo_asks ORDER BY id').all()).toEqual([
      { id: 'quiet', title: 'Quiet' },
      { id: 'told', title: 'Told' },
    ]);
    db.close();
  });

  test('leaves a database without the neo_asks table untouched', () => {
    const db = new Database(':memory:');
    runMigration516(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_asks'").all()).toEqual([]);
    db.close();
  });
});
