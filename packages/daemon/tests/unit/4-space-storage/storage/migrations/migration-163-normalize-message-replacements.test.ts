import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration163 } from '../../../../../src/storage/schema/migrations';

describe('Migration 163: normalize SDK message replacements', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        sdk_message TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('backfills UUIDs and both replacement edge kinds while ignoring malformed JSON', () => {
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, task_id, sdk_message) VALUES (?, ?, ?, ?)`
    );
    insert.run(
      'source',
      'session-1',
      'task-1',
      JSON.stringify({
        uuid: 'source-uuid',
        supersedes: ['old-1', 'old-1', '', 9],
        retracted_message_uuids: ['old-2'],
      })
    );
    insert.run('malformed', 'session-1', 'task-1', '{not-json');

    runMigration163(db);

    expect(db.prepare(`SELECT id, sdk_uuid FROM sdk_messages ORDER BY id`).all()).toEqual([
      { id: 'malformed', sdk_uuid: null },
      { id: 'source', sdk_uuid: 'source-uuid' },
    ]);
    expect(
      db
        .prepare(
          `SELECT source_message_id, session_id, task_id, target_uuid, kind
             FROM sdk_message_replacements
            ORDER BY kind, target_uuid`
        )
        .all()
    ).toEqual([
      {
        source_message_id: 'source',
        session_id: 'session-1',
        task_id: 'task-1',
        target_uuid: 'old-2',
        kind: 'retracted',
      },
      {
        source_message_id: 'source',
        session_id: 'session-1',
        task_id: 'task-1',
        target_uuid: 'old-1',
        kind: 'superseded',
      },
    ]);
  });

  test('is idempotent', () => {
    runMigration163(db);
    expect(() => runMigration163(db)).not.toThrow();
  });

  test('is a no-op without sdk_messages', () => {
    db.exec(`DROP TABLE sdk_messages`);
    expect(() => runMigration163(db)).not.toThrow();
  });
});
