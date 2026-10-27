import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { searchNeoCards } from '../../../../src/storage/neo-card-search.ts';
import { searchWorkChats } from '../../../../src/storage/work-chat-search.ts';
import { runMigrations } from '../../../../src/storage/schema/migrations.ts';

describe('shared Chinese card and message search', () => {
  let facade: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    facade = await createTestDb();
    await facade.createSession(createTestSession('cjk-session'));
  });
  afterEach(() => facade.close());

  function card(id: string, title: string, request = '', at = 1) {
    facade
      .getDatabase()
      .prepare(`INSERT INTO neo_asks
      (id,session_id,title,request,created_at,updated_at) VALUES (?, 'neo:cjk', ?, ?, ?, ?)`)
      .run(id, title, request, at, at);
  }

  function message(id: string, title: string, body: string) {
    facade
      .getDatabase()
      .prepare(`INSERT INTO message_search_content
      (kind,source_id,message_id,session_id,message_type,title,body,timestamp)
      VALUES ('message', ?, ?, 'cjk-session', 'assistant', ?, ?, 1)`)
      .run(id, id, title, body);
  }

  const cards = (query: string, cursor?: string, limit?: number) =>
    searchNeoCards(
      (sql, bindings) =>
        facade
          .getDatabase()
          .prepare(sql)
          .all(...bindings),
      query,
      cursor,
      limit
    );
  const messages = (query: string) => facade.getSDKMessageRepo().searchMessages({ query }).results;
  const chats = (query: string) =>
    searchWorkChats(facade.getDatabase(), { sessions: true, spaceTasks: true }, query, 10);

  test('finds a three-character substring in the middle of an unspaced Han run', () => {
    card('old', '历史记录', '旧记录里的构建版本已完成');
    message('old-message', 'Archive', '旧记录里的构建版本已完成');
    expect(cards('构建版').results).toMatchObject([{ askId: 'old', field: 'meta' }]);
    expect(messages('构建版')).toMatchObject([{ messageId: 'old-message' }]);
    expect(chats('构建版')).toMatchObject([{ sessionId: 'cjk-session', hits: 1 }]);
  });

  test.each(['构', '构建'])(
    'short query %s searches all card fields but only message titles',
    (query) => {
      card('old', '历史记录', '旧记录里的构建版本已完成');
      message('body-only', 'Archive', '旧记录里的构建版本已完成');
      message('title-match', '历史构建版本', 'Unrelated body');
      expect(cards(query).results).toMatchObject([{ askId: 'old', field: 'meta' }]);
      expect(messages(query).map((row) => row.messageId)).toEqual(['title-match']);
      expect(chats(query)).toMatchObject([{ hits: 1, snippets: [{ messageId: 'title-match' }] }]);
    }
  );

  test('short card queries page in recency order and end at a null cursor', () => {
    card('old', '历史构建记录', '', 1);
    card('new', '最新构建记录', '', 2);
    const first = cards('构建', undefined, 1);
    expect(first.results).toMatchObject([{ askId: 'new', field: 'title' }]);
    expect(first.nextCursor).toBe('1');
    const last = cards('构建', first.nextCursor!, 1);
    expect(last.results).toMatchObject([{ askId: 'old' }]);
    expect(last.nextCursor).toBeNull();
  });

  test.each(['%', '_', '\\'])('short literal %s cannot act as a LIKE wildcard', (query) => {
    card('literal', `Literal ${query} sign`);
    card('other', 'Unrelated title');
    message('literal', `Literal ${query} sign`, 'Unrelated body');
    message('other', 'Unrelated title', `Only the body has ${query}`);
    expect(cards(query).results.map((row) => row.askId)).toEqual(['literal']);
    expect(messages(query).map((row) => row.messageId)).toEqual(['literal']);
    expect(chats(query)).toMatchObject([{ hits: 1 }]);
  });

  test('retains ASCII prefix and mixed-query behavior', () => {
    card('catalog', 'Garden catalog');
    message('catalog', 'Archive', 'Garden catalog');
    expect(cards('cat').results).toMatchObject([{ askId: 'catalog' }]);
    expect(messages('a cat')).toMatchObject([{ messageId: 'catalog' }]);
    expect(chats('cat')).toMatchObject([{ hits: 1 }]);
  });

  test('upgrades legacy indexes without losing content and keeps triggers working after restart', () => {
    card('old', '旧的构建版本');
    message('old-message', 'Archive', '旧的构建版本');
    const db = facade.getDatabase();
    for (const [name, columns, content] of [
      ['neo_card_search_fts', 'title, meta, body', 'neo_card_search_content'],
      ['message_search_fts', 'title, body', 'message_search_content'],
    ])
      db.exec(`DROP TABLE ${name}; CREATE VIRTUAL TABLE ${name} USING fts5(
      ${columns}, content='${content}', content_rowid='id', detail=column, tokenize='unicode61');
      INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
    const before = db.prepare('SELECT * FROM message_search_content').all();
    db.exec("DELETE FROM migration_markers WHERE key = 'migration_462'");
    runMigrations(db, () => {});
    expect(cards('构建版').results).toHaveLength(1);
    expect(messages('构建版')).toHaveLength(1);
    expect(db.prepare('SELECT * FROM message_search_content').all()).toEqual(before);
    const marker = db
      .prepare("SELECT applied_at FROM migration_markers WHERE key='migration_462'")
      .get();
    runMigrations(db, () => {});
    expect(
      db.prepare("SELECT applied_at FROM migration_markers WHERE key='migration_462'").get()
    ).toEqual(marker);
    db.exec("UPDATE neo_asks SET title='历史发布版本' WHERE id='old'");
    expect(cards('发布版').results).toHaveLength(1);
    expect(cards('构建版').results).toHaveLength(0);
    db.exec("DELETE FROM message_search_content WHERE source_id='old-message'");
    expect(messages('构建版')).toHaveLength(0);
  });
});
