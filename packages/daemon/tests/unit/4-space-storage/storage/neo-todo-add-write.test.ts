import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';

type Receipt =
  | { ok: false; reason: string }
  | { ok: true; todo?: NeoTodo; start?: string; records?: string[] };
describe('Whole todo-add writer', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  let changes: string[];
  const draft = () => ({
    title: 'Ship 🦊',
    check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/result' } },
    instruction: 'Do the whole job',
    target: { verb: 'start', adapter: 'hyperneo' },
    named: null,
    start: false,
    priority: 'high',
  });
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Work',
      request: 'Ship it',
      createdAt: 1,
    });
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (events) => changes.push(...events.map((event) => event.table));
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const add = (id: string, input: object = draft()) => {
    const op = DB_OPS.get('neo.todoAddWrites') as DbOp<object, Receipt> | undefined;
    expect(op).toBeDefined();
    if (!op) throw new Error('Whole todo-add command unavailable');
    return gateway.run(op, { askId: 'ask', todoId: id, draft: input, now: 10, split: false });
  };
  test('commits target, complete instruction and one shared start question', async () => {
    const input = { ...draft(), instruction: '完整工作 🦊\n'.repeat(20000) };
    expect(await add('one', input)).toMatchObject({
      ok: true,
      todo: { id: 'one', instruction: input.instruction, state: 'blocked', priority: 'high' },
    });
    expect(await add('two')).toMatchObject({ ok: true });
    expect(store.listQuestions('ask')).toMatchObject([
      { kind: 'start', startTodos: ['one', 'two'] },
    ]);
    expect(new NeoTodoSessionRepository(db).get('one')).toMatchObject(input.target);
    expect(changes).toContain('neo_questions');
  });
  test('late question failure rolls back todo, target and all notifications', async () => {
    db.exec(
      "CREATE TRIGGER refuse_start BEFORE INSERT ON neo_questions BEGIN SELECT RAISE(ABORT, 'late start failure'); END"
    );
    const before = store.getAsk('ask');
    await expect(add('one')).rejects.toThrow('late start failure');
    expect(store.getAsk('ask')).toEqual(before);
    expect(store.listTodos('ask')).toEqual([]);
    expect(new NeoTodoSessionRepository(db).get('one')).toBeNull();
    expect(changes).toEqual([]);
  });
  test('concurrent additions join one question without losing a selected todo', async () => {
    await Promise.all([add('one'), add('two')]);
    expect(store.listQuestions('ask')).toMatchObject([{ startTodos: ['one', 'two'] }]);
  });
  test('settled ask is an accepted quiet no-op', async () => {
    store.settleAsk(store.getAsk('ask')!, 'dropped', 'No longer needed', 2);
    expect(await add('one')).toMatchObject({
      ok: true,
      records: [expect.stringContaining('ask_settled')],
    });
    expect(store.listTodos('ask')).toEqual([]);
    expect(changes).toEqual([]);
  });
  test('returns start intent without starting a worker or creating a start card', async () => {
    expect(await add('one', { ...draft(), start: true })).toMatchObject({
      ok: true,
      start: 'one',
      todo: { state: 'todo' },
    });
    expect(store.listQuestions('ask')).toEqual([]);
  });
  test('bind records an existing worker atomically without a start card', async () => {
    const ref = { adapter: 'hyperneo', id: 'existing-worker' };
    expect(await add('one', { ...draft(), target: { verb: 'bind', ref } })).toMatchObject({
      ok: true,
      todo: { state: 'doing', startedAt: 10 },
    });
    expect(new NeoTodoSessionRepository(db).readRef('one')).toEqual(ref);
    expect(store.listQuestions('ask')).toEqual([]);
  });
  test('unsupported check refuses without side effects', async () => {
    expect(
      await add('one', { ...draft(), check: { pack: 'missing', kind: 'unknown', params: {} } })
    ).toMatchObject({ ok: false });
    expect(store.listTodos('ask')).toEqual([]);
    expect(changes).toEqual([]);
  });
  test('records current PR peers while concurrent additions stay nonblocking', async () => {
    const coding = {
      ...draft(),
      instruction: null,
      target: undefined,
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/synthetic/work/pull/1'] },
      },
    };
    const results = await Promise.all([add('one', coding), add('two', coding)]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({
      ok: true,
      records: [expect.stringContaining('pr_already_tracked:')],
    });
    expect(store.listTodos('ask')).toHaveLength(2);
  });
  test('a late question failure also rolls back a newly routed child ask', async () => {
    db.exec("UPDATE neo_asks SET repo='synthetic/original' WHERE id='ask'");
    db.exec(
      "CREATE TRIGGER refuse_child_start BEFORE INSERT ON neo_questions BEGIN SELECT RAISE(ABORT, 'child start failure'); END"
    );
    const coding = {
      ...draft(),
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/synthetic/other/pull/1'] },
      },
    };
    await expect(add('one', coding)).rejects.toThrow('child start failure');
    expect(store.listChildAsks('ask')).toEqual([]);
    expect(store.getTodo('one')).toBeNull();
    expect(changes).toEqual([]);
  });
});
