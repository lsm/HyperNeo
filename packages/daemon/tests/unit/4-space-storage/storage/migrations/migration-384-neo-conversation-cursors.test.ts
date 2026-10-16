import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration288 } from '../../../../../src/storage/schema/m288-neo-publications.ts';
import { createNeoConversationAskTable } from '../../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration382 } from '../../../../../src/storage/schema/m382-neo-publication-anchors.ts';
import { runMigration384 } from '../../../../../src/storage/schema/m384-neo-conversation-cursors.ts';
import { NeoPublicationAnchorRepository } from '../../../../../src/storage/repositories/neo-publication-anchor-repository.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function legacy(db: Database) {
  db.exec('CREATE TABLE neo_session_bindings(session_id TEXT)');
  runMigration288(db);
  createNeoConversationAskTable(db);
  runMigration382(db);
  db.exec("INSERT INTO neo_publication_anchors VALUES ('neo:legacy', 42, 8)");
}

describe('runMigration384', () => {
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
      expect(new NeoPublicationAnchorRepository(db).get('neo:legacy')).toEqual({
        cursor: null,
        compaction: 8,
      });
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%chronology'")
        .all();
      expect(indexes).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('persists separate human and Neo cursor identities across reopen without resetting history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-conversation-cursor-'));
    dirs.push(dir);
    const path = join(dir, 'test.sqlite');
    let db = new Database(path);
    const cursor = { at: '2026-10-16T12:00:00.000Z', role: 'human' as const, sequence: 7 };
    try {
      legacy(db);
      runMigration384(db);
      const repo = new NeoPublicationAnchorRepository(db);
      repo.save('neo:human', { cursor, compaction: 3 });
      repo.save('neo:other', { cursor: { ...cursor, role: 'neo' }, compaction: 4 });
      repo.save('neo:empty', { cursor: null, compaction: 0 });
      db.close();
      db = new Database(path);
      const reopened = new NeoPublicationAnchorRepository(db);
      expect(reopened.get('neo:human')).toEqual({ cursor, compaction: 3 });
      expect(reopened.get('neo:other')).toEqual({
        cursor: { ...cursor, role: 'neo' },
        compaction: 4,
      });
      expect(reopened.get('neo:empty')).toEqual({ cursor: null, compaction: 0 });
      expect(reopened.get('neo:missing')).toBeNull();
    } finally {
      db.close();
    }
  });
});
