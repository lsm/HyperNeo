import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { ChangeRecorder, type DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

let db: Database;
let gateway: DbGateway;
let core: NeoAskTodoRepository;
const draft = { title: 'Work', doneWhen: 'Observed', check: null, named: null, instruction: null };
const command = (mode: 'Reads' | 'Writes', method: string, args: unknown[] = []) =>
  gateway.run(DB_OPS.get(`coding.todoStorage${mode}`)!, { method, args });
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.exec('PRAGMA foreign_keys=ON');
  gateway = new DbGateway(':memory:', db);
  core = new NeoAskTodoRepository(db);
  core.openAsk({
    id: 'ask',
    title: 'Work',
    request: 'Keep association',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    repo: 'github.com/synthetic/history',
    createdAt: 1,
  });
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

const candidate = (changed = () => {}) => {
  const invoke = <T>(mode: 'Reads' | 'Writes', method: string, args: unknown[]) =>
    (DB_OPS.get(`coding.todoStorage${mode}`)! as DbOp<{ method: string; args: unknown[] }, T>).run(
      db,
      { method, args },
      new ChangeRecorder()
    );
  const storage = {
    project: (todo: NeoTodo) => invoke<NeoTodo>('Reads', 'project', [todo]),
    insert: (
      commit: NeoAskTodoRepository['addTodo'],
      args: Parameters<NeoAskTodoRepository['addTodo']>
    ) => {
      const [id, askId, draft, now, repo = null] = args;
      const todo = commit(id, askId, draft, now);
      invoke('Writes', 'record', [todo.id, repo]);
      return storage.project(todo);
    },
  };
  return Reflect.construct(NeoAskTodoRepository, [
    db,
    changed,
    undefined,
    undefined,
    undefined,
    storage,
  ]) as NeoAskTodoRepository;
};

test('facts fail before explicit preparation and read after it', async () => {
  await expect(command('Reads', 'facts', ['ask'])).rejects.toThrow('no such table');
  await command('Writes', 'prepare');
  await expect(command('Reads', 'facts', ['ask'])).resolves.toEqual({
    legacy: 'github.com/synthetic/history',
    repositories: [],
  });
});

test('projection fails before explicit preparation and reads after it', async () => {
  const historical = core.addTodo('historical', 'ask', draft, 2);
  await expect(command('Reads', 'project', [historical])).rejects.toThrow('no such table');
  await command('Writes', 'prepare');
  await expect(command('Reads', 'project', [historical])).resolves.toEqual(historical);
});

test('explicit storage projects all six readers while default readers stay legacy', async () => {
  const legacy = core.addTodo('stored', 'ask', draft, 2, 'github.com/synthetic/old');
  await command('Writes', 'prepare');
  await command('Writes', 'record', [legacy.id, 'github.com/synthetic/canonical']);
  const legacyReader = core;
  core = candidate();
  const reads = [
    core.getTodo(legacy.id),
    ...core.getTodos([legacy.id]),
    ...core.listTodos('ask'),
    ...core.listTodosForAsks(['ask']),
    ...core.listCheckable(),
    core.getCheckable(legacy.id),
  ];
  expect(reads.map((todo) => todo?.repo)).toEqual(Array(6).fill('github.com/synthetic/canonical'));
  expect(legacyReader.getTodo(legacy.id)?.repo).toBe('github.com/synthetic/old');
});

test('explicit storage inserts only the pack repository fact and freezes legacy hints', async () => {
  await command('Writes', 'prepare');
  core = candidate();
  const receipt = core.addTodo('new', 'ask', draft, 2, 'github.com/synthetic/new');
  expect(receipt.repo).toBe('github.com/synthetic/new');
  expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('new')).toEqual({
    repo: 'github.com/synthetic/new',
  });
  expect(db.prepare('SELECT repo FROM neo_todos WHERE id=?').get('new')).toEqual({ repo: null });
  expect(core.getAsk('ask')?.repo).toBe('github.com/synthetic/history');
});

test('an outer failure rolls back successful nested preparation and its backfill', () => {
  core.addTodo('old', 'ask', draft, 2, 'github.com/synthetic/old');
  const op = DB_OPS.get('coding.todoStorageWrites')! as DbOp<
    { method: string; args: unknown[] },
    unknown
  >;
  expect(() =>
    db.transaction(() => {
      op.run(db, { method: 'prepare', args: [] }, new ChangeRecorder());
      expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('old')).toEqual({
        repo: 'github.com/synthetic/old',
      });
      throw new Error('outer failure after savepoint');
    })()
  ).toThrow('outer failure after savepoint');
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_todos'").get()
  ).toBeNull();
  expect(core.getTodo('old')?.repo).toBe('github.com/synthetic/old');
});

test('a late injected storage failure rolls back insertion without announcing a change', async () => {
  await command('Writes', 'prepare');
  let notices = 0;
  core = candidate(() => {
    notices++;
  });
  const before = core.getAsk('ask');
  db.exec(
    "CREATE TRIGGER fail_pack BEFORE INSERT ON pack_coding_todos BEGIN SELECT RAISE(ABORT,'late failure'); END"
  );
  expect(() => core.addTodo('failed', 'ask', draft, 20, 'github.com/synthetic/new')).toThrow(
    'late failure'
  );
  expect(core.getTodo('failed')).toBeNull();
  expect(core.getAsk('ask')).toEqual(before);
  expect(notices).toBe(0);
});
