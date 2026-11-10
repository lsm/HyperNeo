import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { ChangeRecorder, type DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoStorageBoundary,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { codingTodoStorage } from '../../../../src/lib/neo/packs/coding/todo-storage.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

let db: Database;
let gateway: DbGateway;
let core: NeoAskTodoRepository;
const draft = { title: 'Work', doneWhen: 'Observed', check: null, named: null, instruction: null };
const command = (mode: 'Writes', method: string, args: unknown[] = []) =>
  gateway.run(DB_OPS.get(`coding.todoStorage${mode}`)!, { method, args });
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.exec('PRAGMA foreign_keys=ON');
  gateway = new DbGateway(':memory:', db);
  const legacy: NeoTodoStorageBoundary = {
    insert: (commit, [id, askId, draft, now]) => commit(id, askId, draft, now),
  };
  core = new NeoAskTodoRepository(db, undefined, undefined, undefined, undefined, legacy);
  core.openAsk({
    id: 'ask',
    title: 'Work',
    request: 'Keep association',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  db.prepare('UPDATE neo_asks SET repo=? WHERE id=?').run('github.com/synthetic/history', 'ask');
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

const candidate = (changed = () => {}) =>
  new NeoAskTodoRepository(db, changed, undefined, undefined, undefined, codingTodoStorage(db));

test('explicit storage inserts only the pack repository fact and keeps the ask association', async () => {
  await command('Writes', 'prepare');
  let notices = 0;
  core = candidate(() => {
    notices++;
    expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('new')).toEqual({
      repo: 'github.com/synthetic/new',
    });
  });
  const receipt = core.addTodo('new', 'ask', draft, 2, 'github.com/synthetic/new');
  expect(receipt).not.toHaveProperty('repo');
  expect(db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id=?').get('new')).toEqual({
    repo: 'github.com/synthetic/new',
  });
  expect(db.prepare('SELECT repo FROM neo_asks WHERE id=?').get('ask')).toEqual({
    repo: 'github.com/synthetic/history',
  });
  expect(notices).toBe(1);
});

test('an outer failure rolls back successful nested preparation', () => {
  db.exec('DROP TABLE pack_coding_todos');
  const op = DB_OPS.get('coding.todoStorageWrites')! as DbOp<
    { method: string; args: unknown[] },
    unknown
  >;
  expect(() =>
    db.transaction(() => {
      op.run(db, { method: 'prepare', args: [] }, new ChangeRecorder());
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_todos'").get()
      ).not.toBeNull();
      throw new Error('outer failure after savepoint');
    })()
  ).toThrow('outer failure after savepoint');
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_todos'").get()
  ).toBeNull();
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
