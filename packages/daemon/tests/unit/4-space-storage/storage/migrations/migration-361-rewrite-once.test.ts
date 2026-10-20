import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration361 } from '../../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const payload = (db: Database) =>
  (db.prepare('SELECT payload_json FROM neo_publications').get() as { payload_json: string })
    .payload_json;

describe('runMigration361', () => {
  test('rewrites old concern payloads once, and opening the database again leaves payloads alone', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.prepare(
      `INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at)
       VALUES ('c', 'p', '{"kind":"concern"}', '2026-10-20')`
    ).run();
    createTables(db);
    expect(payload(db)).toBe('{"kind":"concern"}');
    runMigration361(db);
    expect(payload(db)).toBe('{"kind":"project"}');
    db.close();
  });
});
