import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  runMigration134,
  runMigration141,
  runMigration211,
} from '../../../../../src/storage/schema/index.ts';

function tableExists(db: BunDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

function seedSearchFixtures(db: BunDatabase): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id, title) VALUES (?, ?)`).run('session-1', 'Bug Hunt');
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
		 VALUES (?, ?, ?, ?, ?)`
  ).run(
    'msg-1',
    'session-1',
    'user',
    JSON.stringify({
      type: 'user',
      uuid: 'uuid-1',
      message: { content: [{ type: 'text', text: 'needle architecture note' }] },
    }),
    now
  );
  db.prepare(
    `INSERT INTO space_tasks (id, space_id, task_number, title, description, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run('task-1', 'space-1', 7, 'Needle task title', '', Date.now());
}

describe('Migration 134: message search FTS', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-134', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec(`
			CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT,
				origin TEXT,
				is_renderable INTEGER NOT NULL DEFAULT 1,
				is_terminal INTEGER NOT NULL DEFAULT 0,
				conversation_turn_index INTEGER,
				parent_tool_use_id TEXT,
				task_id TEXT
			);
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
  }, 10_000);

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  }, 10_000);

  test('creates FTS table and backfills messages and tasks', () => {
    seedSearchFixtures(db);

    runMigration134(db);

    expect(tableExists(db, 'message_search_fts')).toBe(true);
    const rows = db
      .prepare(
        `SELECT msc.kind, msc.source_id FROM message_search_fts JOIN message_search_content msc ON msc.id = message_search_fts.rowid WHERE message_search_fts MATCH ?`
      )
      .all('needle') as Array<{ kind: string; source_id: string }>;
    expect(rows.map((row) => `${row.kind}:${row.source_id}`).sort()).toEqual([
      'message:msg-1',
      'task:task-1',
    ]);
  });

  test('is idempotent', () => {
    runMigration134(db);
    runMigration134(db);
    expect(tableExists(db, 'message_search_fts')).toBe(true);
  });

  test('does not backfill again when FTS table already contains rows', () => {
    runMigration134(db);
    db.prepare(
      `INSERT INTO message_search_content (kind, source_id, title, body, timestamp)
			 VALUES ('task', 'sentinel', 'sentinel', 'sentinel body', ?)`
    ).run(Date.now());
    db.prepare(`DELETE FROM sdk_messages`).run();

    runMigration134(db);

    const rows = db
      .prepare(
        `SELECT msc.source_id FROM message_search_fts JOIN message_search_content msc ON msc.id = message_search_fts.rowid WHERE message_search_fts MATCH ?`
      )
      .all('sentinel') as Array<{ source_id: string }>;
    expect(rows.map((row) => row.source_id)).toEqual(['sentinel']);
  });

  test('backfills when FTS table exists but is empty', () => {
    seedSearchFixtures(db);
    runMigration134(db);
    db.prepare(`DELETE FROM message_search_content`).run();

    runMigration134(db);

    const rows = db
      .prepare(
        `SELECT msc.kind, msc.source_id FROM message_search_fts JOIN message_search_content msc ON msc.id = message_search_fts.rowid WHERE message_search_fts MATCH ?`
      )
      .all('needle') as Array<{ kind: string; source_id: string }>;
    expect(rows.map((row) => `${row.kind}:${row.source_id}`).sort()).toEqual([
      'message:msg-1',
      'task:task-1',
    ]);
  });

  test('does not backfill populated FTS table when source rows lack searchable text', () => {
    runMigration134(db);
    db.prepare(
      `INSERT INTO message_search_content (kind, source_id, title, body, timestamp)
			 VALUES ('task', 'sentinel', 'sentinel', 'sentinel body', ?)`
    ).run(Date.now());
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
			 VALUES (?, ?, ?, ?, ?)`
    ).run(
      'empty-msg-1',
      'session-1',
      'system',
      JSON.stringify({ type: 'system', subtype: 'init' }),
      new Date().toISOString()
    );

    runMigration134(db);

    const rows = db
      .prepare(
        `SELECT msc.source_id FROM message_search_fts JOIN message_search_content msc ON msc.id = message_search_fts.rowid WHERE message_search_fts MATCH ?`
      )
      .all('sentinel') as Array<{ source_id: string }>;
    expect(rows.map((row) => row.source_id)).toEqual(['sentinel']);
  });
  test('creates external-content FTS with detail column tuning', () => {
    seedSearchFixtures(db);

    runMigration134(db);
    runMigration141(db);

    const createSql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'message_search_fts'`)
      .get() as { sql: string };
    expect(createSql.sql).toContain("content='message_search_content'");
    expect(createSql.sql).toContain('detail=column');
    expect(
      db.prepare(`SELECT v FROM message_search_fts_config WHERE k = 'automerge'`).get()
    ).toEqual({
      v: 0,
    });
    expect(
      db.prepare(`SELECT v FROM message_search_fts_config WHERE k = 'crisismerge'`).get()
    ).toEqual({
      v: 64,
    });

    const rows = db
      .prepare(
        `SELECT msc.kind, msc.source_id
				 FROM message_search_fts
				 JOIN message_search_content msc ON msc.id = message_search_fts.rowid
				 WHERE message_search_fts MATCH ?`
      )
      .all('needle') as Array<{ kind: string; source_id: string }>;
    expect(rows.map((row) => `${row.kind}:${row.source_id}`).sort()).toEqual([
      'message:msg-1',
      'task:task-1',
    ]);
  });

  test('migration 211 gives legacy FTS content stable ids without losing search rows', () => {
    seedSearchFixtures(db);
    runMigration134(db);
    db.exec(`
      DROP TRIGGER message_search_content_ai;
      DROP TRIGGER message_search_content_ad;
      DROP TRIGGER message_search_content_au;
      DROP TABLE message_search_fts;
      ALTER TABLE message_search_content RENAME TO message_search_content_m211_seed;
      CREATE TABLE message_search_content (
        kind TEXT NOT NULL CHECK(kind IN ('message', 'task')),
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
      INSERT INTO message_search_content (
        kind, source_id, message_id, session_id, task_id, space_id, task_number,
        message_type, title, body, timestamp
      )
      SELECT
        kind, source_id, message_id, session_id, task_id, space_id, task_number,
        message_type, title, body, timestamp
      FROM message_search_content_m211_seed;
      DROP TABLE message_search_content_m211_seed;
      CREATE VIRTUAL TABLE message_search_fts USING fts5(
        title,
        body,
        content='message_search_content',
        content_rowid='rowid',
        detail=column,
        tokenize = 'unicode61'
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
      INSERT INTO message_search_fts(message_search_fts) VALUES('rebuild');
    `);

    const before = db
      .prepare(
        `SELECT msc.kind, msc.source_id
         FROM message_search_fts
         JOIN message_search_content msc ON msc.rowid = message_search_fts.rowid
         WHERE message_search_fts MATCH ?
         ORDER BY msc.kind, msc.source_id`
      )
      .all('needle');

    runMigration211(db);
    db.exec('VACUUM');

    const contentSql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'message_search_content'`)
      .get() as { sql: string };
    const ftsSql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'message_search_fts'`)
      .get() as { sql: string };
    expect(contentSql.sql).toContain('id INTEGER PRIMARY KEY');
    expect(ftsSql.sql).toContain("content_rowid='id'");
    expect(
      db
        .prepare(
          `SELECT msc.kind, msc.source_id
           FROM message_search_fts
           JOIN message_search_content msc ON msc.id = message_search_fts.rowid
           WHERE message_search_fts MATCH ?
           ORDER BY msc.kind, msc.source_id`
        )
        .all('needle')
    ).toEqual(before);
  });

  test('migration 141 prunes policy-excluded rows after legacy FTS upgrade', () => {
    runMigration134(db);
    db.prepare(`INSERT INTO sessions (id, title) VALUES (?, ?)`).run('coder:old', 'Coder');
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-coder',
      'coder:old',
      'user',
      JSON.stringify({
        type: 'user',
        uuid: 'uuid-coder',
        message: { content: [{ type: 'text', text: 'excluded coder marker' }] },
      }),
      new Date().toISOString(),
      'consumed'
    );

    runMigration141(db);

    const rows = db
      .prepare(`SELECT source_id FROM message_search_content WHERE source_id = ?`)
      .all('msg-coder') as Array<{ source_id: string }>;
    expect(rows).toEqual([]);
  });

  test('migration 141 skips rebuild once optimized FTS schema exists', () => {
    seedSearchFixtures(db);
    runMigration134(db);
    runMigration141(db);
    db.prepare(`INSERT INTO message_search_content (kind, source_id, title, body, timestamp)
			 VALUES ('task', 'manual-row', 'Manual', 'manual marker', ?)`).run(Date.now());

    runMigration141(db);

    const rows = db
      .prepare(
        `SELECT msc.source_id
				 FROM message_search_fts
				 JOIN message_search_content msc ON msc.id = message_search_fts.rowid
				 WHERE message_search_fts MATCH ?`
      )
      .all('manual') as Array<{ source_id: string }>;
    expect(rows.map((row) => row.source_id)).toEqual(['manual-row']);
  });
});
