import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      type TEXT,
      session_context TEXT,
      visible_message_count INTEGER NOT NULL DEFAULT 0
    );

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
      task_id TEXT,
      sdk_uuid TEXT,
      consumed_seq INTEGER,
      replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE sdk_message_replacements (
      source_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      target_uuid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
      PRIMARY KEY (source_message_id, target_uuid, kind),
      FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE delivery_turn_end (
      session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_uuid)
    );

    CREATE TABLE delivery_consumed_seq (
      singleton INTEGER PRIMARY KEY DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 1);

    CREATE TABLE job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
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
      INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
    CREATE TRIGGER message_search_content_ad
    AFTER DELETE ON message_search_content BEGIN
      INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
    END;

    CREATE INDEX idx_sdk_messages_session_timestamp_id
      ON sdk_messages(session_id, timestamp DESC, id DESC);
    CREATE INDEX idx_sdk_messages_session_uuid ON sdk_messages(session_id, sdk_uuid);
  `);
  return db;
}

interface MessageSeed {
  id: string;
  sessionId: string;
  daysAgo: number;
  sendStatus?: string | null;
  messageType?: string;
  sdkUuid?: string | null;
}

function insertSession(db: Database, id: string, overrides: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO sessions (id, title, status, type, session_context, visible_message_count)
     VALUES (?, '', ?, ?, ?, ?)`
  ).run(
    id,
    (overrides.status ?? 'archived') as string,
    (overrides.type ?? 'worker') as string,
    (overrides.sessionContext ?? null) as string | null,
    (overrides.visibleMessageCount ?? 0) as number
  );
}

function insertMessage(db: Database, seed: MessageSeed): void {
  db.prepare(
    `INSERT INTO sdk_messages (
       id, session_id, message_type, message_subtype, sdk_message, timestamp,
       send_status, sdk_uuid
     ) VALUES (?, ?, ?, NULL, '{}', ?, ?, ?)`
  ).run(
    seed.id,
    seed.sessionId,
    seed.messageType ?? 'assistant',
    iso(seed.daysAgo),
    seed.sendStatus ?? 'consumed',
    seed.sdkUuid ?? null
  );
}

describe('SDKMessageRepository.deleteExpiredArchivedSessionMessages', () => {
  let db: Database;
  let repository: SDKMessageRepository;

  beforeEach(() => {
    db = createTestDb();
    repository = new SDKMessageRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('deletes old consumed messages of archived worker sessions and keeps recent ones', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm-old', sessionId: 's1', daysAgo: 60 });
    insertMessage(db, { id: 'm-recent', sessionId: 's1', daysAgo: 2 });

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result.deleted).toBe(1);
    expect(result.affectedSessions).toEqual(['s1']);
    expect(result.hasMore).toBe(false);
    expect(
      db
        .prepare(`SELECT id FROM sdk_messages`)
        .all()
        .map((r) => (r as { id: string }).id)
    ).toEqual(['m-recent']);
  });

  it('does not touch messages of non-archived sessions', () => {
    insertSession(db, 'active', { status: 'active' });
    insertSession(db, 'ended', { status: 'ended' });
    insertMessage(db, { id: 'm1', sessionId: 'active', daysAgo: 60 });
    insertMessage(db, { id: 'm2', sessionId: 'ended', daysAgo: 60 });

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result.deleted).toBe(0);
  });

  it('does not delete messages with a pending delivery status', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm-enqueued', sessionId: 's1', daysAgo: 60, sendStatus: 'enqueued' });
    insertMessage(db, { id: 'm-deferred', sessionId: 's1', daysAgo: 60, sendStatus: 'deferred' });
    insertMessage(db, { id: 'm-submitted', sessionId: 's1', daysAgo: 60, sendStatus: 'submitted' });
    insertMessage(db, { id: 'm-failed', sessionId: 's1', daysAgo: 60, sendStatus: 'failed' });
    insertMessage(db, { id: 'm-consumed', sessionId: 's1', daysAgo: 60, sendStatus: 'consumed' });
    insertMessage(db, { id: 'm-null', sessionId: 's1', daysAgo: 60, sendStatus: null });

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result.deleted).toBe(3);
    const remaining = (
      db.prepare(`SELECT id FROM sdk_messages`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(remaining.sort()).toEqual(['m-deferred', 'm-enqueued', 'm-submitted']);
  });

  it('skips sessions that still have an active message_delivery job', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm1', sessionId: 's1', daysAgo: 60 });
    db.prepare(
      `INSERT INTO job_queue (id, queue, status, payload, run_at, created_at)
       VALUES ('j1', 'message_delivery', 'pending', '{"sessionId":"s1"}', 0, 0)`
    ).run();

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result.deleted).toBe(0);
  });

  it('ignores completed message_delivery jobs when deciding to retain', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm1', sessionId: 's1', daysAgo: 60 });
    db.prepare(
      `INSERT INTO job_queue (id, queue, status, payload, run_at, created_at)
       VALUES ('j1', 'message_delivery', 'completed', '{"sessionId":"s1"}', 0, 0)`
    ).run();

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result.deleted).toBe(1);
  });

  it('skips space and room sessions, including ad-hoc members with worker type', () => {
    insertSession(db, 'space:room-1', { type: 'space_chat' });
    insertSession(db, 'worker1', { type: 'space_task_agent' });
    insertSession(db, 'worker2', { sessionContext: JSON.stringify({ taskId: 'task-1' }) });
    insertSession(db, 'worker3', { sessionContext: JSON.stringify({ spaceId: 'space-1' }) });
    insertSession(db, 'worker4', { sessionContext: JSON.stringify({ roomId: 'room-1' }) });
    insertMessage(db, { id: 'm1', sessionId: 'space:room-1', daysAgo: 60 });
    insertMessage(db, { id: 'm2', sessionId: 'worker1', daysAgo: 60 });
    insertMessage(db, { id: 'm3', sessionId: 'worker2', daysAgo: 60 });
    insertMessage(db, { id: 'm4', sessionId: 'worker3', daysAgo: 60 });
    insertMessage(db, { id: 'm5', sessionId: 'worker4', daysAgo: 60 });

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result.deleted).toBe(0);
  });

  it('deletes search content rows and clears delivery turn ends for removed messages', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm1', sessionId: 's1', daysAgo: 60, sdkUuid: 'uuid-1' });
    insertMessage(db, { id: 'm2', sessionId: 's1', daysAgo: 60, sdkUuid: 'uuid-2' });
    db.prepare(
      `INSERT INTO message_search_content (kind, source_id, message_id, session_id, message_type, title, body, timestamp)
       VALUES ('message', 'm1', 'uuid-1', 's1', 'assistant', '', 'hello', 0)`
    ).run();
    db.prepare(
      `INSERT INTO delivery_turn_end (session_id, message_uuid, ended_at)
       VALUES ('s1', 'uuid-1', 'now')`
    ).run();

    repository.deleteExpiredArchivedSessionMessages({ olderThanIso: iso(30), batchLimit: 100 });

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM message_search_content`).get() as { n: number }
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM message_search_fts`).get() as { n: number }
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM delivery_turn_end`).get() as { n: number }
    ).toEqual({ n: 0 });
  });

  it('recomputes the visible message count for affected sessions', () => {
    insertSession(db, 's1', { visibleMessageCount: 10 });
    insertMessage(db, { id: 'm1', sessionId: 's1', daysAgo: 60, messageType: 'assistant' });
    insertMessage(db, { id: 'm2', sessionId: 's1', daysAgo: 2, messageType: 'assistant' });

    repository.deleteExpiredArchivedSessionMessages({ olderThanIso: iso(30), batchLimit: 100 });

    const row = db
      .prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = 's1'`)
      .get() as {
      n: number;
    };
    expect(row.n).toBe(1);
  });

  it('cascades sdk_message_replacements when the source message is deleted', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm-old', sessionId: 's1', daysAgo: 60, sdkUuid: 'uuid-old' });
    db.prepare(
      `INSERT INTO sdk_message_replacements (source_message_id, session_id, task_id, target_uuid, kind)
       VALUES ('m-old', 's1', NULL, 'uuid-new', 'superseded')`
    ).run();

    repository.deleteExpiredArchivedSessionMessages({ olderThanIso: iso(30), batchLimit: 100 });

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM sdk_message_replacements`).get() as { n: number }
    ).toEqual({ n: 0 });
  });

  it('respects the batch limit and reports hasMore', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm1', sessionId: 's1', daysAgo: 60 });
    insertMessage(db, { id: 'm2', sessionId: 's1', daysAgo: 60 });
    insertMessage(db, { id: 'm3', sessionId: 's1', daysAgo: 60 });

    const first = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 2,
    });
    expect(first.deleted).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 2,
    });
    expect(second.deleted).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages`).get() as { n: number }).toEqual({
      n: 0,
    });
  });

  it('returns no-op when the cutoff deletes nothing', () => {
    insertSession(db, 's1');
    insertMessage(db, { id: 'm1', sessionId: 's1', daysAgo: 2 });

    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 100,
    });

    expect(result).toEqual({ deleted: 0, affectedSessions: [], hasMore: false });
  });

  it('returns no-op for a non-positive batch limit', () => {
    const result = repository.deleteExpiredArchivedSessionMessages({
      olderThanIso: iso(30),
      batchLimit: 0,
    });
    expect(result).toEqual({ deleted: 0, affectedSessions: [], hasMore: false });
  });
});
