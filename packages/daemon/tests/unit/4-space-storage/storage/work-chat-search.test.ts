import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  fuseWorkChats,
  searchWorkChats,
  vectorWorkChats,
} from '../../../../src/storage/work-chat-search';
import { saveTurnVector } from '../../../../src/storage/turn-vectors';
import { runMigration297 } from '../../../../src/storage/schema/m297-message-search-vectors';

const tables = { sessions: true, spaceTasks: false };

describe('searchWorkChats', () => {
  let db: Database;
  let next = 0;
  const insert = (sessionId: string | null, taskId: string | null, body: string, at: number) => {
    next += 1;
    db.prepare(
      `INSERT INTO message_search_content
         (kind, source_id, message_id, session_id, task_id, message_type, title, body, timestamp)
       VALUES (?, ?, ?, ?, ?, 'assistant', 'chat', ?, ?)`
    ).run(sessionId ? 'message' : 'task', `src${next}`, `msg${next}`, sessionId, taskId, body, at);
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
      message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
      message_type TEXT, title TEXT, body TEXT, timestamp INTEGER)`);
    db.exec(`CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body,
      content='message_search_content', content_rowid='id')`);
    db.exec(`CREATE TRIGGER msc_ai AFTER INSERT ON message_search_content BEGIN
      INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END`);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, last_active_at TEXT)`);
    db.exec(`INSERT INTO sessions VALUES ('busy', 'active', '2026-10-05T00:00:00Z'),
      ('quiet', 'active', '2026-10-05T00:00:00Z'), ('gone', 'archived', '2026-10-05T00:00:00Z'),
      ('w1', 'active', '2026-10-05T00:00:00Z')`);
  });
  afterEach(() => db.close());

  test('returns each matching chat once, so a busy chat cannot crowd out a quiet one', () => {
    for (let n = 0; n < 120; n++) insert('busy', null, `the 16px font change, take ${n}`, 1000 + n);
    insert('quiet', null, 'moved the body text to 16px', 500);
    const chats = searchWorkChats(db, tables, '16px', 50);
    expect(chats.map((chat) => [chat.sessionId, chat.hits, chat.snippets.length])).toEqual([
      ['busy', 120, 2],
      ['quiet', 1, 1],
    ]);
    expect(chats[0].lastHitAt).toBe(1119);
    expect(chats[1].snippets[0]).toEqual({
      match: 'exact',
      messageId: 'msg121',
      sessionId: 'quiet',
      role: 'assistant',
      at: 500,
      text: 'moved the body text to 16px',
    });
  });

  test('tags each chat with its kind so adapters can keep their own', () => {
    insert('quiet', null, 'otter migration plan', 10);
    db.prepare(
      `INSERT INTO message_search_content
         (kind, source_id, message_id, session_id, message_type, title, body, timestamp)
       VALUES ('codex', 'r1:4', 'm-r1', 'thread-1', 'assistant', 'rollout', 'otter migration done', 20)`
    ).run();
    expect(
      searchWorkChats(db, tables, 'otter', 10).map((chat) => [chat.kind, chat.sessionId])
    ).toEqual([
      ['codex', 'thread-1'],
      ['message', 'quiet'],
    ]);
  });

  test('groups a task across its sessions and skips archived chats', () => {
    insert('w1', 't1', 'coder said 16px', 10);
    insert(null, 't1', 'task asks for 16px', 20);
    insert('gone', null, 'archived 16px talk', 30);
    const chats = searchWorkChats(db, tables, '16px', 50);
    expect(chats.map((chat) => [chat.taskId, chat.hits])).toEqual([['t1', 2]]);
  });

  test('finds nothing for text with no searchable terms', () => {
    insert('quiet', null, 'anything', 1);
    expect(searchWorkChats(db, tables, 'a', 50)).toEqual([]);
  });
});

describe('fuseWorkChats', () => {
  test('adds relevance and recency ranks, and breaks ties by the newest hit', () => {
    const chat = (sessionId: string, lastHitAt: number) => ({
      kind: 'message' as const,
      sessionId,
      taskId: null,
      hits: 1,
      lastHitAt,
      snippets: [],
    });
    const fused = fuseWorkChats([chat('best', 5), chat('newest', 9), chat('stale', 1)]);
    expect(fused.map((c) => [c.sessionId, c.score])).toEqual([
      ['newest', 132.522],
      ['best', 132.522],
      ['stale', 131.746],
    ]);
  });
});

describe('vectorWorkChats', () => {
  test('finds chats by meaning, newest vectors only, tagged semantic', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
      message_id TEXT, session_id TEXT, task_id TEXT, message_type TEXT, body TEXT, timestamp INTEGER)`);
    runMigration297(db);
    const insert = db.prepare(
      `INSERT INTO message_search_content (kind, source_id, message_id, session_id, message_type, body, timestamp)
       VALUES ('message', ?, ?, ?, 'assistant', ?, ?)`
    );
    insert.run('r1', 'm1', 'font-chat', 'bumped message text to sixteen pixels', 10);
    insert.run('r2', 'm2', 'font-chat', 'composer text matches now', 20);
    insert.run('r3', 'm3', 'other', 'unrelated database work', 30);
    const save = (id: number, values: number[]) => {
      const { bodyLength } = db
        .prepare(`SELECT length(body) AS bodyLength FROM message_search_content WHERE id = ?`)
        .get(id) as { bodyLength: number };
      saveTurnVector(db, { id, bodyLength }, 'm', Float32Array.from(values), 1);
    };
    save(1, [1, 0, 0]);
    save(2, [0.9, 0.1, 0]);
    save(3, [0, 0, 1]);
    const chats = vectorWorkChats(
      db,
      { sessions: false, spaceTasks: false },
      Float32Array.from([1, 0, 0]),
      'm',
      10
    );
    expect(chats.map((chat) => [chat.sessionId, chat.hits, chat.lastHitAt])).toEqual([
      ['font-chat', 2, 20],
    ]);
    expect(chats[0].snippets[0]).toEqual({
      match: 'semantic',
      messageId: 'm1',
      sessionId: 'font-chat',
      role: 'assistant',
      at: 10,
      text: 'bumped message text to sixteen pixels',
    });
    db.close();
  });
});

describe('fuseWorkChats with meaning matches', () => {
  test('keeps exact matches above semantic-only ones and lifts chats found both ways', () => {
    const chat = (sessionId: string, lastHitAt: number) => ({
      kind: 'message' as const,
      sessionId,
      taskId: null,
      hits: 1,
      lastHitAt,
      snippets: [],
    });
    const fused = fuseWorkChats(
      [chat('keyword-only', 9), chat('both', 1)],
      [chat('meaning-only', 10), chat('both', 1)]
    );
    expect(fused.map((c) => c.sessionId)).toEqual(['both', 'keyword-only', 'meaning-only']);
    expect(fused[2].score).toBeLessThan(fused[1].score);
    expect(fused[1].score).toBeGreaterThan(100);
  });
});
