import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoContextTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration389 } from '../../../../src/storage/schema/m389-neo-conversation.ts';

const conversation = (db: Database) =>
  db.prepare('SELECT id FROM neo_conversation').all() as { id: string }[];

describe('runMigration389', () => {
  test('stores the main Neo session uuid as the conversation id, once', () => {
    const db = new Database(':memory:');
    createNeoContextTables(db);
    db.exec(
      "INSERT INTO neo_session_bindings (session_id, concern_id, kind) VALUES ('neo:10000000-0000-4000-8000-000000000001', NULL, 'neo')"
    );
    runMigration389(db);
    runMigration389(db);
    expect(conversation(db)).toEqual([{ id: '10000000-0000-4000-8000-000000000001' }]);
  });

  test('leaves the table empty when there is no main Neo session yet', () => {
    const db = new Database(':memory:');
    createNeoContextTables(db);
    runMigration389(db);
    expect(conversation(db)).toEqual([]);
  });
});
