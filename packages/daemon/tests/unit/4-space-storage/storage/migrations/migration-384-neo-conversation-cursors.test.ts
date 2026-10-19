import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration288 } from '../../../../../src/storage/schema/m288-neo-publications.ts';
import {
  createNeoConversationAskTable,
  runMigration289,
} from '../../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration382 } from '../../../../../src/storage/schema/m382-neo-publication-anchors.ts';
import { runMigration384 } from '../../../../../src/storage/schema/m384-neo-conversation-cursors.ts';

function legacy(db: Database) {
  db.exec('CREATE TABLE neo_session_bindings(session_id TEXT)');
  runMigration288(db);
  createNeoConversationAskTable(db);
  runMigration382(db);
  db.exec("INSERT INTO neo_publication_anchors VALUES ('neo:legacy', 42, 8)");
}

describe('runMigration384', () => {
  test('creates missing ledgers before schema bootstrap when earlier migrations skip them', () => {
    const db = new Database(':memory:');
    try {
      runMigration288(db);
      runMigration289(db);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_publications'").get()
      ).toBeNull();
      runMigration384(db);
      runMigration384(db);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%chronology'"
          )
          .all()
      ).toHaveLength(2);
      expect(db.prepare('PRAGMA table_info(neo_publication_anchors)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'cursor_json' })])
      );
    } finally {
      db.close();
    }
  });

  test('preserves legacy cursor rows and ledger contents when run repeatedly', () => {
    const db = new Database(':memory:');
    try {
      legacy(db);
      db.exec(
        "INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at) VALUES ('c', 'p', '{}', 'original')"
      );
      runMigration384(db);
      runMigration384(db);
      expect(db.prepare('SELECT * FROM neo_publication_anchors').get()).toEqual({
        session_id: 'neo:legacy',
        sequence: 42,
        compaction: 8,
        cursor_json: null,
      });
      expect(db.prepare('SELECT payload_json, created_at FROM neo_publications').get()).toEqual({
        payload_json: '{}',
        created_at: 'original',
      });
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%chronology'")
        .all();
      expect(indexes).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
