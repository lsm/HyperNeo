import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoStorageBoundary,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

let db: Database;
let gateway: DbGateway;
let core: NeoAskTodoRepository;
const draft = { title: 'Work', doneWhen: 'Observed', check: null, named: null, instruction: null };
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.exec('PRAGMA foreign_keys=ON');
  gateway = new DbGateway(':memory:', db);
  const legacy: NeoTodoStorageBoundary = {
    project: (todo) => todo,
    insert: (commit, args) => commit(...args),
  };
  core = new NeoAskTodoRepository(db, undefined, undefined, undefined, undefined, legacy);
  core.openAsk({
    id: 'ask',
    title: 'Legacy',
    request: 'Keep history',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    repo: 'github.com/synthetic/legacy',
    createdAt: 1,
  });
});
afterEach(async () => {
  await gateway.close();
  db.close();
});
const invoke = (mode: 'Reads' | 'Writes', method: string, args: unknown[] = []) => {
  const op = DB_OPS.get(`coding.todoStorage${mode}`);
  expect(op, 'registered data-only storage command').toBeDefined();
  return gateway.run(op!, { method, args });
};
const rows = () => db.prepare('SELECT todo_id,repo FROM pack_coding_todos ORDER BY todo_id').all();
const create = (id: string, repo: string | null) =>
  invoke('Writes', 'create', [{ id, askId: 'ask', draft, now: 10, repo }]);

test('startup prepares storage and the core todo table holds no repository', () => {
  expect(
    (db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[]).map((c) => c.name)
  ).not.toContain('repo');
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_todos'").get()
  ).not.toBeNull();
});

test('explicit preparation is idempotent and keeps recorded facts', async () => {
  core.addTodo('old', 'ask', draft, 2);
  core.addTodo('ask-only', 'ask', draft, 2);
  const before = core.listTodos('ask');
  await invoke('Writes', 'record', ['old', 'github.com/synthetic/old']);
  await invoke('Writes', 'prepare');
  expect(rows()).toEqual([{ todo_id: 'old', repo: 'github.com/synthetic/old' }]);
  await invoke('Writes', 'record', ['old', null]);
  await invoke('Writes', 'prepare');
  expect(rows()).toEqual([{ todo_id: 'old', repo: null }]);
  expect(core.listTodos('ask')).toEqual(before);
  expect(core.getAsk('ask')?.repo).toBe('github.com/synthetic/legacy');
});

test('creation writes one pack fact and leaves the legacy column null', async () => {
  await invoke('Writes', 'prepare');
  expect(await create('new', 'github.com/synthetic/new')).toMatchObject({
    id: 'new',
    repo: 'github.com/synthetic/new',
  });
  expect(rows()).toEqual([{ todo_id: 'new', repo: 'github.com/synthetic/new' }]);
  expect(core.getTodo('new')?.repo).toBeNull();
  expect(core.getAsk('ask')?.repo).toBe('github.com/synthetic/legacy');
});

test('a late pack write failure rolls back core creation and ask timestamps', async () => {
  await invoke('Writes', 'prepare');
  const before = core.getAsk('ask');
  db.exec(
    "CREATE TRIGGER reject_pack BEFORE INSERT ON pack_coding_todos BEGIN SELECT RAISE(ABORT,'late pack failure'); END"
  );
  await expect(create('failed', 'github.com/synthetic/new')).rejects.toThrow('late pack failure');
  expect(core.getTodo('failed')).toBeNull();
  expect(core.getAsk('ask')).toEqual(before);
  expect(rows()).toEqual([]);
});

test('projection reads a recorded null without writing', async () => {
  const old = core.addTodo('old', 'ask', draft, 2);
  await invoke('Writes', 'prepare');
  await invoke('Writes', 'record', ['old', null]);
  const before = rows();
  expect(await invoke('Reads', 'project', [old])).toMatchObject({ id: 'old', repo: null });
  expect(rows()).toEqual(before);
  expect(core.getTodo('old')).toEqual(old);
});

test.each([0, 4])(
  'historical fallback facts survive with %i sibling repositories',
  async (peers) => {
    core.addTodo('historical', 'ask', draft, 2);
    for (let i = 0; i < peers; i++) {
      core.addTodo(`peer-${i}`, 'ask', draft, 2);
      await invoke('Writes', 'record', [`peer-${i}`, `github.com/synthetic/peer-${i}`]);
    }
    await invoke('Writes', 'prepare');
    expect(await invoke('Reads', 'facts', ['ask'])).toEqual({
      legacy: 'github.com/synthetic/legacy',
      repositories: Array.from({ length: peers }, (_, i) => `github.com/synthetic/peer-${i}`),
    });
    expect(rows()).toHaveLength(peers);
    expect(core.getTodo('historical')?.repo).toBeNull();
  }
);

test('candidate repository rows follow core foreign-key deletion', async () => {
  await invoke('Writes', 'prepare');
  await create('delete-me', 'github.com/synthetic/new');
  db.prepare('DELETE FROM neo_todos WHERE id=?').run('delete-me');
  expect(rows()).toEqual([]);
});

test('a missing candidate row projects no repository', async () => {
  await invoke('Writes', 'prepare');
  const legacy = core.addTodo('late', 'ask', draft, 2);
  expect(legacy.repo).toBeNull();
  expect(await invoke('Reads', 'project', [legacy])).toEqual(legacy);
  expect(rows()).toEqual([]);
});
