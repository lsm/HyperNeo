import { describe, expect, test } from 'bun:test';
import { runMigration358 } from '../../../../src/storage/schema/m358-neo-ask-revisions';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration358', () => {
  test('backfills revisions without grandfathering approval or evidence', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE neo_asks (id TEXT PRIMARY KEY, approved_at INTEGER); INSERT INTO neo_asks VALUES ('a', 123)"
      );
      db.exec(
        "CREATE TABLE neo_ask_items (id TEXT PRIMARY KEY, state TEXT, evidence TEXT); INSERT INTO neo_ask_items VALUES ('i', 'met', 'worker says done')"
      );
      runMigration358(db);
      runMigration358(db);
      expect(
        db.prepare('SELECT revision, approved_revision, approved_at FROM neo_asks').get()
      ).toEqual({ revision: 0, approved_revision: null, approved_at: 123 });
      expect(
        db.prepare('SELECT state, evidence, verified_definition_hash FROM neo_ask_items').get()
      ).toEqual({ state: 'met', evidence: 'worker says done', verified_definition_hash: null });
      expect(() => db.exec('UPDATE neo_asks SET revision = -1')).toThrow();
    } finally {
      db.close();
    }
  });
  test('skips absent tables', () => {
    const db = new Database(':memory:');
    try {
      expect(() => runMigration358(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
