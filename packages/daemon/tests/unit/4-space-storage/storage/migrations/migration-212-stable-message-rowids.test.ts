import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration212 } from '../../../../../src/storage/schema/index.ts';

describe('Migration 212: stable sdk_messages rowids', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(tmpdir(), `migration-212-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('session-1');
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_subtype TEXT,
        message_subtype_norm TEXT GENERATED ALWAYS AS (COALESCE(message_subtype, '')) VIRTUAL,
        sdk_message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        send_status TEXT,
        consumed_seq INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_sdk_messages_session_timestamp
        ON sdk_messages(session_id, timestamp, id);
      CREATE INDEX idx_sdk_messages_consumed_seq
        ON sdk_messages(consumed_seq)
        WHERE consumed_seq IS NOT NULL;
      CREATE TABLE sdk_message_replacements (
        source_message_id TEXT NOT NULL,
        target_uuid TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (source_message_id, target_uuid, kind),
        FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
      );
    `);
    const insert = db.prepare(`
      INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, consumed_seq)
      VALUES (?, 'session-1', 'assistant', ?, ?, ?, 'consumed', ?)
    `);
    for (let index = 0; index < 24; index++) {
      insert.run(
        `message-${String(index).padStart(2, '0')}`,
        index % 2 === 0 ? 'text' : null,
        JSON.stringify({ index }),
        new Date(Math.floor(index / 4) * 1_000).toISOString(),
        index % 3 === 0 ? index : null
      );
    }
    db.prepare(
      `INSERT INTO sdk_message_replacements (source_message_id, target_uuid, kind) VALUES (?, ?, 'superseded')`
    ).run('message-00', 'uuid-1');
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('preserves rowids, rows, indexes, and foreign keys across the rewrite and VACUUM', () => {
    const rowIdsBefore = db
      .prepare(`SELECT id, rowid AS cursor FROM sdk_messages ORDER BY rowid`)
      .all() as Array<{ id: string; cursor: number }>;
    const rowsBefore = db
      .prepare(
        `SELECT id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, consumed_seq
         FROM sdk_messages ORDER BY id`
      )
      .all();
    const replacementsBefore = db
      .prepare(`SELECT * FROM sdk_message_replacements ORDER BY source_message_id`)
      .all();

    runMigration212(db);
    db.exec('VACUUM');
    runMigration212(db);

    const tableSql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sdk_messages'`)
      .get() as { sql: string };
    expect(tableSql.sql).toContain('seq INTEGER PRIMARY KEY');
    expect(tableSql.sql).toContain('id TEXT NOT NULL UNIQUE');
    expect(db.prepare(`SELECT id, rowid AS cursor FROM sdk_messages ORDER BY rowid`).all()).toEqual(
      rowIdsBefore
    );
    expect(
      db
        .prepare(
          `SELECT id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, consumed_seq
           FROM sdk_messages ORDER BY id`
        )
        .all()
    ).toEqual(rowsBefore);
    expect(
      db.prepare(`SELECT * FROM sdk_message_replacements ORDER BY source_message_id`).all()
    ).toEqual(replacementsBefore);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sdk_messages' AND name IN ('idx_sdk_messages_session_timestamp', 'idx_sdk_messages_consumed_seq') ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'idx_sdk_messages_consumed_seq' },
      { name: 'idx_sdk_messages_session_timestamp' },
    ]);
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(db.prepare(`PRAGMA integrity_check`).get()).toEqual({ integrity_check: 'ok' });
    db.prepare(
      `INSERT INTO sdk_message_replacements (source_message_id, target_uuid, kind) VALUES (?, ?, 'superseded')`
    ).run('message-01', 'uuid-2');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_message_replacements`).get()).toEqual({
      n: 2,
    });

    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
       VALUES ('message-new', 'session-1', 'user', '{}', '2026-08-24T00:00:00.000Z')`
    ).run();
    expect(
      db.prepare(`SELECT rowid AS cursor FROM sdk_messages WHERE id = 'message-new'`).get()
    ).toEqual({ cursor: 25 });
    expect(() =>
      db
        .prepare(
          `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
           VALUES ('message-00', 'session-1', 'user', '{}', '2026-08-24T00:00:00.000Z')`
        )
        .run()
    ).toThrow();
  });
});
