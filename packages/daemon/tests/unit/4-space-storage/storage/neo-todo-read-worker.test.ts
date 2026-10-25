import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';

test('Neo snapshot facts, check lists and done-page facts come from a reader snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-read-worker-'));
  const path = join(dir, 'synthetic.db');
  const db = new Database(path);
  const gateway = new DbGateway(path, null);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db, () => {});
    createTables(db);
    bindGateway(db, gateway);
    const todos = new NeoAskTodoRepository(db);
    todos.openAsk({
      id: 'a',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Synthetic read card',
      request: '',
      createdAt: 1,
    });
    for (let i = 0; i < 3; i++)
      todos.addTodo(
        `t${i}`,
        'a',
        { title: `Step ${i}`, doneWhen: 'Observed', check: null, instruction: null, named: null },
        i
      );
    const expected = todos.listTodos('a');
    const snapshot = await todos.read('snapshot', undefined, 50);
    expect(snapshot.asks.map((ask) => ask.id)).toEqual(['a']);
    expect(snapshot.unlisted).toBe(0);
    expect(snapshot.facts.todos).toEqual(expected);
    expect(snapshot.facts.questions).toEqual([]);
    expect(await todos.read('listCheckable')).toEqual(todos.listCheckable());
    expect(await todos.read('listOpenAsks')).toEqual(todos.listOpenAsks());
    const page = await todos.read('doneTodoFacts', 'a');
    expect(page.ask?.id).toBe('a');
    expect(page.todos).toEqual(expected);
    expect(page.links).toBeInstanceOf(Map);
    expect((await todos.read('doneTodoFacts', 'missing')).ask).toBeNull();
  } finally {
    await gateway.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
