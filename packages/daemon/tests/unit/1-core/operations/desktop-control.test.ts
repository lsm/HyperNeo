import { beforeEach, expect, test } from 'vitest';
import { createDesktopControlOperation } from '../../../../src/lib/desktop/control-operation.ts';
import { desktopOptIn, readDesktopTodos } from '../../../../src/lib/desktop/opt-in.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Errands',
    request: '',
    createdAt: 1,
  });
  for (const [index, [todo, worker, named]] of (
    [
      ['dentist', 'worker-a', null],
      ['taxes', 'worker-b', { folder: 'docs' }],
    ] as const
  ).entries()) {
    todos.addTodo(
      todo,
      'ask',
      { title: todo, doneWhen: 'Observed', check: null, instruction: null, named },
      index
    );
    db.prepare("UPDATE neo_todos SET state = 'doing', approved_at = 1 WHERE id = ?").run(todo);
    db.prepare('INSERT INTO neo_todo_sessions(todo_id, target, ref) VALUES(?, ?, ?)').run(
      todo,
      '{}',
      JSON.stringify({ adapter: 'hyperneo', id: worker })
    );
  }
});

const optedIn = (worker: string) => desktopOptIn(readDesktopTodos(db), worker)?.id ?? null;
function set(input: { todoId: string; on: boolean }, caller = human) {
  return invokeOperation(
    createOperationRegistry([createDesktopControlOperation(db)]),
    'desktop.control.set',
    input,
    caller
  );
}

test('desktop control is off for every todo until the human turns it on', () => {
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual([null, null]);
});

test('turning desktop control on is per todo, and it turns back off', async () => {
  expect(await set({ todoId: 'taxes', on: true })).toMatchObject({
    kind: 'completed',
    value: { accepted: true, desktopControl: true },
  });
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual([null, 'taxes']);
  expect(
    JSON.parse(
      (db.prepare('SELECT named FROM neo_todos WHERE id = ?').get('taxes') as { named: string })
        .named
    )
  ).toEqual({ folder: 'docs', desktopControl: true });
  await set({ todoId: 'taxes', on: false });
  expect(optedIn('worker-b')).toBeNull();
});

test('a finished or unknown todo cannot turn desktop control on', async () => {
  db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = 'dentist'").run();
  for (const todoId of ['dentist', 'missing'])
    expect(await set({ todoId, on: true })).toMatchObject({
      kind: 'completed',
      value: { accepted: false },
    });
  expect(
    db.prepare("SELECT named FROM neo_todos WHERE id = 'dentist'").get() as { named: null }
  ).toEqual({ named: null });
});

test('agents and Neo cannot turn desktop control on', async () => {
  for (const caller of [
    { source: 'mcp', role: 'neo' },
    { source: 'rpc', principal: 'local', device: { deviceId: 'test-agent', kind: 'agent' } },
  ] as OperationCaller[])
    expect(await set({ todoId: 'dentist', on: true }, caller)).not.toMatchObject({
      kind: 'completed',
    });
  expect(optedIn('worker-a')).toBeNull();
});
