import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

test('todo worker reads preserve lists, recovery and PR windows; live writes commit before reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-todo-gateway-'));
  const path = join(dir, 'synthetic.db');
  const db = new Database(path);
  const gateway = new DbGateway(path, null);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db, () => {});
    createTables(db);
    bindGateway(db, gateway);
    const todos = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const prs = new CodingTodoPrRepository(db);
    todos.openAsk({
      id: 'a',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Synthetic ask',
      request: '',
      createdAt: 1,
    });
    const ref = { adapter: 'hyperneo' as const, id: 'synthetic' };
    for (let i = 0; i < 3; i++) {
      const id = `t${i}`;
      todos.addTodo(
        id,
        'a',
        { title: id, doneWhen: 'Observed', instruction: null, named: null, check: null },
        1
      );
      db.prepare("UPDATE neo_todos SET state = 'doing', started_at = ? WHERE id = ?").run(i, id);
      sessions.bind(id, ref, i);
    }
    db.exec("UPDATE neo_todo_sessions SET ref = NULL WHERE todo_id = 't2'");
    const expected = {
      recovery: sessions.unrecordedStarts(),
      awaiting: sessions.awaitingReports(),
      window: prs.window('t0'),
    };
    expect(await sessions.read('unrecordedStarts')).toEqual(expected.recovery);
    expect(await sessions.read('awaitingReports')).toEqual(expected.awaiting);
    expect(await prs.readWindow('t0')).toEqual(expected.window);
    expect(
      await sessions.write(
        'recordLive',
        't0',
        'running',
        '/session/synthetic',
        'https://example.com/synthetic'
      )
    ).toBe(true);
    expect(sessions.readLiveStatus('t0')).toBe('running');
    expect(
      await sessions.write(
        'recordLive',
        't0',
        'running',
        '/session/synthetic',
        'https://example.com/synthetic'
      )
    ).toBe(false);
    expect(await sessions.write('recordLive', 't0', 'done', undefined)).toBe(true);
    expect(sessions.readLinks('t0')).toMatchObject({
      link: '/session/synthetic',
      remoteLink: null,
    });
  } finally {
    await gateway.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
