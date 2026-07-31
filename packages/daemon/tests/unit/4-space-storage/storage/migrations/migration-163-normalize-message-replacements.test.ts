import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import {
  reconcileSdkMessageReplacementProjection,
  runMigration163,
} from '../../../../../src/storage/schema/migrations';

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
        message_subtype TEXT,
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
    db.prepare(
      `UPDATE sdk_messages SET message_subtype = 'model_refusal_fallback' WHERE id = 'source'`
    ).run();
    insert.run('malformed', 'session-1', 'task-1', '{not-json');
    insert.run(
      'scalar',
      'session-1',
      'task-1',
      JSON.stringify({ uuid: 'scalar-uuid', supersedes: 'not-an-array' })
    );
    insert.run(
      'object',
      'session-1',
      'task-1',
      JSON.stringify({
        uuid: 'object-uuid',
        retracted_message_uuids: { accidental: 'old-3' },
      })
    );
    insert.run(
      'non-fallback-retraction',
      'session-1',
      'task-1',
      JSON.stringify({
        uuid: 'non-fallback-uuid',
        retracted_message_uuids: ['must-remain-visible'],
      })
    );
    insert.run(
      'empty-uuid',
      'session-1',
      'task-1',
      JSON.stringify({
        uuid: '',
        supersedes: [],
      })
    );

    runMigration163(db);

    expect(db.prepare(`SELECT id, sdk_uuid FROM sdk_messages ORDER BY id`).all()).toEqual([
      { id: 'empty-uuid', sdk_uuid: null },
      { id: 'malformed', sdk_uuid: null },
      { id: 'non-fallback-retraction', sdk_uuid: 'non-fallback-uuid' },
      { id: 'object', sdk_uuid: 'object-uuid' },
      { id: 'scalar', sdk_uuid: 'scalar-uuid' },
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
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sdk_messages
            WHERE replacement_metadata_normalized = 1`
        )
        .get()
    ).toEqual({ count: 6 });
  });

  test('reconciles JSON-only rows written by an old binary after rollback', () => {
    runMigration163(db);
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, task_id, sdk_message) VALUES (?, ?, ?, ?)`
    ).run(
      'rollback-source',
      'session-1',
      'task-1',
      JSON.stringify({
        uuid: 'rollback-uuid',
        supersedes: ['rollback-target'],
      })
    );

    reconcileSdkMessageReplacementProjection(db);

    expect(
      db
        .prepare(
          `SELECT sdk_uuid, replacement_metadata_normalized
             FROM sdk_messages
            WHERE id = 'rollback-source'`
        )
        .get()
    ).toEqual({
      sdk_uuid: 'rollback-uuid',
      replacement_metadata_normalized: 1,
    });
    expect(
      db
        .prepare(
          `SELECT source_message_id, target_uuid, kind
             FROM sdk_message_replacements
            WHERE source_message_id = 'rollback-source'`
        )
        .get()
    ).toEqual({
      source_message_id: 'rollback-source',
      target_uuid: 'rollback-target',
      kind: 'superseded',
    });
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
