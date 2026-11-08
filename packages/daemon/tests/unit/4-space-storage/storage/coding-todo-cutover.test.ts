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
import { GitHubWatchInventory } from '../../../../src/lib/external-events/github/github-watch-inventory.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';
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
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

test('startup prepares the pack table before a default reader needs it', () => {
  db.exec('DROP TABLE pack_coding_todos');
  createTables(db);
  expect(store.getTodo('stored')?.repo).toBeNull();
  expect(
    (db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[]).map((c) => c.name)
  ).not.toContain('repo');
});

test('default core and the write-op repository read the pack fact', () => {
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
    'stopContext',
    ['stored'],
    (r: unknown) => (r as { todo: NeoTodo }).todo,
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

test('new default writes commit one pack fact and leave the ask association unchanged', () => {
  const created = store.addTodo('new', 'ask', draft, 3, 'github.com/synthetic/new');
  expect(created.repo).toBe('github.com/synthetic/new');
  expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('new')).toEqual({
    repo: 'github.com/synthetic/new',
  });
  expect(store.getAsk('ask')?.repo).toBe('github.com/synthetic/history');
});

test('canonical null survives repeated preparation', async () => {
  await command('coding.todoStorageWrites', 'record', ['stored', null]);
  await command('coding.todoStorageWrites', 'prepare', []);
  expect(((await command('neo.todoReads', 'getTodo', ['stored'])) as NeoTodo).repo).toBeNull();
});

test.each([{ repos: [] }, { repos: ['one'] }, { repos: ['one', 'two'] }])(
  'new draft inheritance uses recorded sibling repositories %j',
  ({ repos }) => {
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

test('watch inventory follows the pack fact', () => {
  db.prepare(
    "INSERT INTO sessions (id,title,created_at,last_active_at,status,config,metadata) VALUES ('neo','Synthetic','now','now','active','{}','{}')"
  ).run();
  db.prepare('UPDATE neo_todos SET check_json=? WHERE id=?').run(
    JSON.stringify({ pack: 'coding', kind: 'pr_merged', params: { urls: [] } }),
    'stored'
  );
  const inventory = new GitHubWatchInventory(db, new SessionEventSubscriptionRepository(db));
  expect(inventory.list()).toEqual([{ owner: 'synthetic', repo: 'canonical' }]);
});

test('a fresh schema can precede migrations without reading a missing source table', () => {
  const fresh = new Database(':memory:');
  try {
    createTables(fresh);
    runMigrations(fresh, () => {});
    createTables(fresh);
    expect(
      fresh.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_todos'").get()
    ).not.toBeNull();
  } finally {
    fresh.close();
  }
});

test('the add writer publishes the pack fact notification after committing', async () => {
  const tables: string[] = [];
  gateway.onChanges = (changes) => tables.push(...changes.map((change) => change.table));
  const result = (await gateway.run(DB_OPS.get('neo.todoAddWrites')!, {
    askId: 'ask',
    todoId: 'announced',
    draft: {
      title: 'Announced',
      check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/result' } },
      instruction: null,
      named: { repository: 'synthetic/new' },
      start: false,
    },
    now: 5,
  })) as { ok: boolean; todo: NeoTodo };
  expect(result.ok).toBe(true);
  expect(result.todo.repo).toBe('github.com/synthetic/new');
  expect(tables).toContain('pack_coding_todos');
  expect(tables).toContain('neo_todos');
});
