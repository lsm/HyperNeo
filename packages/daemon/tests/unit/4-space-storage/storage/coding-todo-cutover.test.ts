import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import {
  NeoAskTodoRepository,
  neoTodoWrites,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { codingTodoRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { neoTodoRepository } from '../../../../src/lib/neo/pack-contract.ts';

let db: Database;
let gateway: DbGateway;
let store: NeoAskTodoRepository;
const draft = { title: 'Work', doneWhen: 'Observed', check: null, instruction: null, named: null };
const command = (name: string, method: string, args: unknown[]) =>
  gateway.run(DB_OPS.get(name)!, { method, args });
beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  gateway = new DbGateway(':memory:', db);
  store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'History',
    request: 'Keep association',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    repo: 'github.com/synthetic/history',
    createdAt: 1,
  });
  store.addTodo('stored', 'ask', draft, 2, 'github.com/synthetic/legacy');
  await command('coding.todoStorageWrites', 'prepare', []);
  await command('coding.todoStorageWrites', 'record', ['stored', 'github.com/synthetic/canonical']);
  db.prepare('UPDATE neo_todos SET repo=? WHERE id=?').run('github.com/synthetic/legacy', 'stored');
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

test('startup prepares the pack table before a default reader needs it', () => {
  db.exec('DROP TABLE pack_coding_todos');
  createTables(db);
  expect(store.getTodo('stored')?.repo).toBe('github.com/synthetic/legacy');
  expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('stored')).toEqual({
    repo: 'github.com/synthetic/legacy',
  });
});

test('default core and the write-op repository cannot fall back to stale columns', () => {
  expect(store.getTodo('stored')?.repo).toBe('github.com/synthetic/canonical');
  expect(new neoTodoWrites.Repository(db).getTodo('stored')?.repo).toBe(
    'github.com/synthetic/canonical'
  );
});

test.each([
  ['neo.todoReads', 'getTodo', ['stored'], (r: unknown) => r as NeoTodo],
  [
    'neo.askSettlementReads',
    'snapshot',
    ['ask'],
    (r: unknown) => (r as { todos: NeoTodo[] }).todos[0],
  ],
  [
    'neo.todoMutationReads',
    'plan',
    [{ kind: 'edit', todoId: 'stored', title: 'Updated' }, 3, []],
    (r: unknown) => (r as { todo: NeoTodo }).todo,
  ],
  [
    'neo.todoSessionReads',
    'queueFacts',
    [],
    (r: unknown) => (r as { waiting: { next: NeoTodo }[] }).waiting[0].next,
  ],
] as const)(
  'gateway %s creates canonical readers independently',
  async (name, method, args, result) => {
    expect(result(await command(name, method, [...args])).repo).toBe(
      'github.com/synthetic/canonical'
    );
  }
);

test('runner state receipts also use the canonical repository', async () => {
  const result = (await command('neo.todoRunnerWrites', 'recompute', [
    'stored',
    null,
    {},
    3,
    { state: 'no_opinion' },
  ])) as { todo: NeoTodo };
  expect(result.todo.repo).toBe('github.com/synthetic/canonical');
});

test('mutation commit receipts do not recreate an unprojected repository', async () => {
  const result = (await gateway.run(DB_OPS.get('neo.todoMutations')!, {
    input: { kind: 'edit', todoId: 'stored', title: 'Updated' },
    now: 3,
  })) as { todo: NeoTodo };
  expect(result.todo.repo).toBe('github.com/synthetic/canonical');
});

test('new default writes commit one pack fact and freeze both legacy columns', () => {
  const created = store.addTodo('new', 'ask', draft, 3, 'github.com/synthetic/new');
  expect(created.repo).toBe('github.com/synthetic/new');
  expect(db.prepare('SELECT repo FROM neo_todos WHERE id=?').get('new')).toEqual({ repo: null });
  expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('new')).toEqual({
    repo: 'github.com/synthetic/new',
  });
  expect(store.getAsk('ask')?.repo).toBe('github.com/synthetic/history');
});

test('canonical null survives repeated preparation and a stale non-null legacy column', async () => {
  await command('coding.todoStorageWrites', 'record', ['stored', null]);
  await command('coding.todoStorageWrites', 'prepare', []);
  expect(((await command('neo.todoReads', 'getTodo', ['stored'])) as NeoTodo).repo).toBeNull();
});

test.each([[], ['one'], ['one', 'two']])(
  'new draft inheritance uses recorded sibling repositories %j',
  (repos) => {
    const scope = {
      ask: { repo: 'github.com/synthetic/history' },
      peers: repos.map((repo) => ({ repo: `github.com/synthetic/${repo}` })),
    };
    expect(codingTodoRepository({ check: null, named: null }, [], scope)).toBe(
      repos.length === 1 ? 'github.com/synthetic/one' : null
    );
    expect(
      codingTodoRepository(
        {
          check: null,
          named: null,
          target: {
            verb: 'start',
            adapter: 'hyperneo',
            place: { machine: 'synthetic', name: 'Own', folder: '/synthetic' },
          },
        },
        [],
        scope
      )
    ).toBeNull();
  }
);

test('empty pack answers do not hide a later repository', () => {
  expect(
    neoTodoRepository(
      { check: null, named: null },
      [
        { todos: { repository: () => '' } },
        { todos: { repository: () => 'github.com/synthetic/canonical' } },
      ],
      { ask: null }
    )
  ).toBe('github.com/synthetic/canonical');
});

test('historical ask-only association stays readable without invented pack rows', async () => {
  store.addTodo('historical', 'ask', draft, 3);
  db.prepare('DELETE FROM pack_coding_todos WHERE todo_id=?').run('historical');
  await command('coding.todoStorageWrites', 'prepare', []);
  const todo = (await command('neo.todoReads', 'getTodo', ['historical'])) as NeoTodo;
  expect(codingTodoRepository(todo, [], { ask: store.getAsk('ask'), todo })).toBe(
    'github.com/synthetic/history'
  );
  expect(
    db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('historical')
  ).toBeNull();
});
