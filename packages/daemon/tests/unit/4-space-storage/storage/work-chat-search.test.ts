import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { fuseWorkChats, searchWorkChats } from '../../../../src/storage/work-chat-search';

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
      messageId: 'msg121',
      sessionId: 'quiet',
      role: 'assistant',
      at: 500,
      text: 'moved the body text to 16px',
    });
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
      sessionId,
      taskId: null,
      hits: 1,
      lastHitAt,
      snippets: [],
    });
    const fused = fuseWorkChats([chat('best', 5), chat('newest', 9), chat('stale', 1)]);
    expect(fused.map((c) => [c.sessionId, c.score])).toEqual([
      ['newest', 32.522],
      ['best', 32.522],
      ['stale', 31.746],
    ]);
  });
});
