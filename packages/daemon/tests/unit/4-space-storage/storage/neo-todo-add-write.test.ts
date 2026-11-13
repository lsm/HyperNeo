import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Receipt =
  | { ok: false; reason: string }
  | { ok: true; todo?: NeoTodo; start?: string; records?: string[] };
describe('Whole todo-add writer', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  let changes: string[];
  const draft = () => ({
    after: [],
    title: 'Ship 🦊',
    check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/result' } },
    instruction: 'Do the whole job',
    target: { verb: 'start', adapter: 'hyperneo' },
    named: null,
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
    return gateway.run(op, {
      askId: 'ask',
      todoId: id,
      draft: input,
      now: 10,
      userFolder: '/synthetic/user',
    });
  };
  test('commits target, complete instruction and start intent with no Start card', async () => {
    const input = { ...draft(), instruction: '完整工作 🦊\n'.repeat(20000) };
    expect(await add('one', input)).toMatchObject({
      ok: true,
      start: 'one',
      todo: { id: 'one', instruction: input.instruction, state: 'todo', approvedAt: 10 },
    });
    expect(await add('two')).toMatchObject({ ok: true, start: 'two' });
    expect(store.listQuestions('ask')).toEqual([]);
    expect(new NeoTodoSessionRepository(db).get('one')).toMatchObject(input.target);
    expect(changes).toContain('neo_todo_sessions');
    expect(changes).not.toContain('neo_questions');
  });
  test('different repositories commit to the same ask without creating children', async () => {
    const placed = {
      ...draft(),
      target: {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'synthetic', name: 'repo' },
      },
    };
    const first = await add('one', { ...placed, named: { repository: 'synthetic/first' } });
    const second = await add('two', { ...placed, named: { repository: 'synthetic/second' } });
    expect(first).toMatchObject({
      ok: true,
      todo: { askId: 'ask' },
    });
    expect(second).toMatchObject({
      ok: true,
      todo: { askId: 'ask' },
    });
    expect(
      db.prepare('SELECT todo_id, repo FROM pack_coding_todos ORDER BY todo_id').all()
    ).toEqual([
      { todo_id: 'one', repo: 'github.com/synthetic/first' },
      { todo_id: 'two', repo: 'github.com/synthetic/second' },
    ]);
    expect(store.getAsk('ask')?.status).toBe('open');
    expect(store.listChildAsks('ask')).toEqual([]);
  });
  test('an add announces the neo tables without re-announcing the pack table', async () => {
    expect(await add('one')).toMatchObject({ ok: true });
    expect(changes).toEqual(expect.arrayContaining(['neo_asks', 'neo_todos']));
    expect(changes).not.toContain('pack_coding_todos');
  });
  test('late target failure rolls back todo, target and all notifications', async () => {
    db.exec(
      "CREATE TRIGGER refuse_target BEFORE INSERT ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'late target failure'); END"
    );
    const before = store.getAsk('ask');
    await expect(add('one')).rejects.toThrow('late target failure');
    expect(store.getAsk('ask')).toEqual(before);
    expect(store.listTodos('ask')).toEqual([]);
    expect(new NeoTodoSessionRepository(db).get('one')).toBeNull();
    expect(changes).toEqual([]);
  });
  test('concurrent additions both commit with no Start card', async () => {
    await Promise.all([add('one'), add('two')]);
    expect(store.listTodos('ask').map((todo) => todo.id)).toEqual(['one', 'two']);
    expect(store.listQuestions('ask')).toEqual([]);
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
  test('a check-only todo returns no start intent', async () => {
    const result = await add('one', { ...draft(), instruction: null, target: undefined });
    expect(result).toMatchObject({ ok: true, todo: { state: 'todo' } });
    expect(result).not.toHaveProperty('start');
  });
  test('unsupported check refuses without side effects', async () => {
    expect(
      await add('one', { ...draft(), check: { pack: 'missing', kind: 'unknown', params: {} } })
    ).toMatchObject({ ok: false });
    expect(store.listTodos('ask')).toEqual([]);
    expect(changes).toEqual([]);
  });
  test('an empty core evidence check gets an assigned path', async () => {
    const receipt = await add('one', {
      ...draft(),
      check: { pack: 'core', kind: 'evidence', params: {} },
    });
    expect(receipt).toMatchObject({ ok: true });
    const todo = store.getTodo('one');
    expect(todo?.check?.params.path).toMatch(/result\.md$/);
    expect(todo?.check?.params.path).toContain('one');
  });
  test('evidence inside the human folder is refused before writing', async () => {
    const coding = {
      ...draft(),
      named: { repository: 'synthetic/repo' },
      target: {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'synthetic', name: 'repo' },
      },
      check: {
        pack: 'core',
        kind: 'evidence',
        params: { path: '/synthetic/user/notes/result.md' },
      },
    };
    const receipt = await add('one', coding);
    expect(receipt).toMatchObject({ ok: false });
    expect((receipt as { reason?: string }).reason).toContain('evidence_in_user_folder');
    expect(store.listTodos('ask')).toEqual([]);
    expect(changes).toEqual([]);
  });
  test('an unknown after reference is refused before writing', async () => {
    const receipt = await add('one', { ...draft(), after: ['ghost'] });
    expect(receipt).toMatchObject({ ok: false });
    expect((receipt as { reason?: string }).reason).toContain('dependency_not_found');
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
  test('a late target failure also rolls back a newly routed child ask', async () => {
    db.exec("UPDATE neo_asks SET repo='synthetic/original' WHERE id='ask'");
    db.exec(
      "CREATE TRIGGER refuse_child_target BEFORE INSERT ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'child start failure'); END"
    );
    const coding = {
      ...draft(),
      target: {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'synthetic', name: 'original' },
      },
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
