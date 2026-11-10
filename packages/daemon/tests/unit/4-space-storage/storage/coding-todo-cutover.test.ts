import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { codingTodoRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { GitHubWatchInventory } from '../../../../src/lib/external-events/github/github-watch-inventory.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';
import { neoTodoRepository } from '../../../../src/lib/neo/pack-contract.ts';
import { neoTodoPolicies } from '../../../../src/lib/neo/packs/todo-policies.ts';

let db: Database;
let gateway: DbGateway;
let store: NeoAskTodoRepository;
const draft = { title: 'Work', doneWhen: 'Observed', check: null, instruction: null, named: null };
const command = (name: string, method: string, args: unknown[]) =>
  gateway.run(DB_OPS.get(name)!, { method, args });
const recorded = (todoId: string) =>
  db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get(todoId) as {
    repo: string | null;
  } | null;
const stored = (todoId: string) =>
  neoTodoRepository(draft, neoTodoPolicies(db), { ask: { id: 'ask' }, todo: { id: todoId } });
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
    createdAt: 1,
  });
  db.prepare('UPDATE neo_asks SET repo=? WHERE id=?').run('github.com/synthetic/history', 'ask');
  store.addTodo('stored', 'ask', draft, 2, 'github.com/synthetic/legacy');
  await command('coding.todoStorageWrites', 'prepare', []);
  await command('coding.todoStorageWrites', 'record', ['stored', 'github.com/synthetic/canonical']);
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

test('startup prepares the pack table before a default writer needs it', () => {
  db.exec('DROP TABLE pack_coding_todos');
  createTables(db);
  store.addTodo('after', 'ask', draft, 3, 'github.com/synthetic/after');
  expect(recorded('after')).toEqual({ repo: 'github.com/synthetic/after' });
  expect(
    (db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[]).map((c) => c.name)
  ).not.toContain('repo');
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
    'neo.todoSessionReads',
    'stopContext',
    ['stored'],
    (r: unknown) => (r as { todo: NeoTodo }).todo,
  ],
] as const)(
  'gateway %s returns core todos without a repository',
  async (name, method, args, result) => {
    const todo = result(await command(name, method, [...args]));
    expect(todo.id).toBe('stored');
    expect(todo).not.toHaveProperty('repo');
  }
);

test('the coding pack decides a stored place from its recorded fact', () => {
  expect(stored('stored')).toBe('github.com/synthetic/canonical');
});

test('new default writes commit one pack fact and leave the ask association unchanged', () => {
  const created = store.addTodo('new', 'ask', draft, 3, 'github.com/synthetic/new');
  expect(created).not.toHaveProperty('repo');
  expect(recorded('new')).toEqual({ repo: 'github.com/synthetic/new' });
  expect(db.prepare('SELECT repo FROM neo_asks WHERE id=?').get('ask')).toEqual({
    repo: 'github.com/synthetic/history',
  });
});

test('canonical null survives repeated preparation', async () => {
  await command('coding.todoStorageWrites', 'record', ['stored', null]);
  await command('coding.todoStorageWrites', 'prepare', []);
  expect(recorded('stored')).toEqual({ repo: null });
  expect(stored('stored')).toBe('github.com/synthetic/history');
});

test.each([{ repos: [] }, { repos: ['one'] }, { repos: ['one', 'two'] }])(
  'new draft inheritance uses recorded sibling repositories %j',
  ({ repos }) => {
    const facts = {
      ask: 'github.com/synthetic/history',
      peers: repos.map((repo) => `github.com/synthetic/${repo}`),
    };
    expect(codingTodoRepository({ check: null, named: null }, [], facts)).toBe(
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
        facts
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

test('historical ask-only association stays readable without invented pack rows', () => {
  store.addTodo('historical', 'ask', draft, 3);
  db.prepare('DELETE FROM pack_coding_todos WHERE todo_id=?').run('historical');
  expect(stored('historical')).toBe('github.com/synthetic/history');
  expect(recorded('historical')).toBeNull();
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
  expect(recorded('announced')).toEqual({ repo: 'github.com/synthetic/new' });
  expect(tables).toContain('pack_coding_todos');
  expect(tables).toContain('neo_todos');
});
