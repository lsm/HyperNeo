import { describe, expect, test } from 'bun:test';
import { runMigration330 } from '../../../../src/storage/schema/m330-neo-ask-waiting-item';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration330', () => {
  test('records which item a waiting ask waits on, once, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY, status TEXT, outcome TEXT)');
    db.exec(
      'CREATE TABLE neo_ask_items (ask_id TEXT, id TEXT, position INTEGER, text TEXT, removed INTEGER)'
    );
    db.exec(`INSERT INTO neo_asks VALUES ('a1', 'waiting', 'Pick a plan'), ('a2', 'waiting', 'Start it?'),
      ('a3', 'open', 'Pick a plan')`);
    db.exec(`INSERT INTO neo_ask_items VALUES ('a1', 'i1', 0, 'Ship it', 0), ('a1', 'i2', 1, 'Pick a plan', 0),
      ('a3', 'i1', 0, 'Pick a plan', 0)`);
    runMigration330(db);
    runMigration330(db);
    expect(db.prepare('SELECT id, waiting_item AS item FROM neo_asks ORDER BY id').all()).toEqual([
      { id: 'a1', item: 'i2' },
      { id: 'a2', item: null },
      { id: 'a3', item: null },
    ]);
    const bare = new Database(':memory:');
    runMigration330(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
});
