import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/migrations';
import { reclaimPendingMigrationSpace } from '../../../../../src/storage/schema/migration-space-reclaim';

interface MessageRow {
  id: string;
  session_id: string;
  message_type: string;
  message_subtype: string | null;
  sdk_message: string;
  timestamp: string;
  send_status: string;
}

describe('migration space reclaim', () => {
  let db: BunDatabase | null = null;
  let testDir: string | null = null;

  afterEach(() => {
    db?.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test('retries and reclaims a rewrite without deleting rows', () => {
    testDir = join(tmpdir(), `migration-reclaim-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec(`
      PRAGMA page_size = 4096;
      PRAGMA auto_vacuum = NONE;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('session');
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_subtype TEXT,
        sdk_message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        send_status TEXT DEFAULT 'consumed'
          CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_sdk_messages_session_timestamp
        ON sdk_messages(session_id, timestamp, id);
      CREATE TABLE migration_markers (
        key TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE migration_space_reclaims (
        migration_key TEXT PRIMARY KEY,
        reclaimed_at INTEGER NOT NULL
      );
      CREATE TABLE message_search_content (
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        message_id TEXT,
        session_id TEXT,
        task_id TEXT,
        space_id TEXT,
        task_number INTEGER,
        message_type TEXT,
        title TEXT,
        body TEXT,
        timestamp INTEGER,
        PRIMARY KEY (kind, source_id)
      );
      CREATE VIRTUAL TABLE message_search_fts USING fts5(
        title,
        body,
        content='message_search_content',
        content_rowid='rowid',
        detail=column,
        tokenize='unicode61'
      );
      CREATE TRIGGER message_search_content_ai
      AFTER INSERT ON message_search_content BEGIN
        INSERT INTO message_search_fts(rowid, title, body)
        VALUES (new.rowid, new.title, new.body);
      END;
      CREATE TRIGGER message_search_content_ad
      AFTER DELETE ON message_search_content BEGIN
        INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
      END;
      CREATE TRIGGER message_search_content_au
      AFTER UPDATE OF title, body ON message_search_content BEGIN
        INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
        INSERT INTO message_search_fts(rowid, title, body)
        VALUES (new.rowid, new.title, new.body);
      END;
    `);
    db.prepare(
      `INSERT INTO message_search_content (kind, source_id, title, body) VALUES (?, ?, ?, ?)`
    ).run('task', 'search-sentinel', 'Search sentinel', 'vacuum searchable needle');

    const insert = db.prepare(`
      INSERT INTO sdk_messages (
        id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status
      ) VALUES (?, 'session', ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 128; index++) {
      insert.run(
        `message-${String(index).padStart(3, '0')}`,
        index % 2 === 0 ? 'assistant' : 'user',
        index % 3 === 0 ? 'text' : null,
        JSON.stringify({ index, payload: `${index}:`.repeat(8_192) }),
        new Date(index * 1_000).toISOString(),
        index % 2 === 0 ? 'enqueued' : 'consumed'
      );
    }

    const mark = db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES (?, ?)`);
    for (let version = 1; version <= 210; version++) {
      if (version === 183) continue;
      mark.run(`migration_${String(version).padStart(3, '0')}`, version);
    }
    mark.run('migration_room_cleanup', 0);
    db.exec(`
      INSERT INTO migration_space_reclaims (migration_key, reclaimed_at)
      SELECT key, 1 FROM migration_markers
    `);

    const before = db
      .prepare(`
        SELECT id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status
        FROM sdk_messages
        ORDER BY id
      `)
      .all() as MessageRow[];
    const firstPending = runMigrations(db, () => {});
    expect(firstPending).toEqual([
      { migrationKey: 'migration_183' },
      { migrationKey: 'migration_211' },
    ]);
    const afterRewrite = db
      .prepare(`
        SELECT id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status
        FROM sdk_messages
        ORDER BY id
      `)
      .all();
    expect(afterRewrite).toEqual(before);

    db.close();
    db = null;
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    const retryPending = runMigrations(db, () => {});
    expect(retryPending).toEqual(firstPending);
    const freelistBefore = db.prepare('PRAGMA main.freelist_count').get() as {
      freelist_count: number;
    };
    expect(freelistBefore.freelist_count).toBeGreaterThan(100);

    const reclaim = reclaimPendingMigrationSpace(db, retryPending);
    expect(reclaim).toEqual({
      kind: 'reclaimed',
      vacuumed: true,
      freelistBefore: freelistBefore.freelist_count,
      reclaimedMigrations: 2,
    });
    expect(db.prepare('PRAGMA main.freelist_count').get()).toEqual({ freelist_count: 0 });
    const acknowledgmentCheckpoint = db.prepare('PRAGMA main.wal_checkpoint(PASSIVE)').get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    expect(acknowledgmentCheckpoint.busy).toBe(0);
    expect(acknowledgmentCheckpoint.checkpointed).toBe(acknowledgmentCheckpoint.log);
    expect(acknowledgmentCheckpoint.log).toBeLessThan(10);
    expect(
      db
        .prepare(`
          SELECT msc.source_id
          FROM message_search_fts
          JOIN message_search_content msc ON msc.id = message_search_fts.rowid
          WHERE message_search_fts MATCH ?
        `)
        .all('needle')
    ).toEqual([{ source_id: 'search-sentinel' }]);
    expect(
      db
        .prepare(`
          SELECT id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status
          FROM sdk_messages
          ORDER BY id
        `)
        .all()
    ).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(runMigrations(db, () => {})).toEqual([]);

    db.prepare(`DELETE FROM migration_space_reclaims WHERE migration_key = ?`).run('migration_183');
    expect(runMigrations(db, () => {})).toEqual([{ migrationKey: 'migration_183' }]);
    const noVacuum = reclaimPendingMigrationSpace(db, [{ migrationKey: 'migration_183' }]);
    expect(noVacuum).toEqual({
      kind: 'reclaimed',
      vacuumed: false,
      freelistBefore: 0,
      reclaimedMigrations: 1,
    });
  });
});
