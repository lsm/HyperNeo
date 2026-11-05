import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Result =
  | { ok: false; reason: string }
  | { ok: true; todo: NeoTodo; todos: NeoTodo[]; records?: string[]; startNext?: string | null };
describe('Atomic todo mutation commits', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  let changes: string[];
  const url = 'https://github.com/synthetic/commit/pull/1';
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (events) => changes.push(...events.map((event) => event.table));
    store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Commit',
      request: 'Preserve work',
      createdAt: 1,
    });
    for (const id of ['first', 'peer'])
      store.addTodo(
        id,
        'ask',
        {
          title: id,
          doneWhen: 'Merged',
          check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } },
          instruction: null,
          named: null,
        },
        1
      );
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const snapshot = () => ({
    ask: store.getAsk('ask'),
    todos: store.listTodos('ask'),
    cards: store.listQuestions('ask'),
  });
  const commit = (input: object, checked?: object) => {
    const op = DB_OPS.get('neo.todoMutations') as DbOp<object, Result> | undefined;
    expect(op, 'register the atomic command without activating runtime callers').toBeDefined();
    if (!op) throw new Error('Atomic mutation command unavailable');
    expect(op.mode).toBe('write');
    return gateway.run(op, { input, checked, now: 10 });
  };
  const replyCard = () =>
    store.askQuestion(
      'reply',
      'ask',
      {
        kind: 'reply',
        todoId: 'first',
        text: 'Answer before finishing',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      3
    );

  test('returns the entire committed report and announces before the caller resumes', async () => {
    const report = 'Whole report 🦊\n'.repeat(20000);
    const result = await commit({
      kind: 'edit',
      todoId: 'first',
      done: 'reported',
      evidence: report,
    });
    expect(result).toMatchObject({
      ok: true,
      todo: { state: 'blocked', blockedBy: 'check', report },
    });
    expect(store.getTodo('first')!.report).toBe(report);
    expect(changes).toContain('neo_todos');
  });

  test('re-reads the current check instead of accepting a stale external completion', async () => {
    const previous = store.getTodo('first')!.check;
    store.updateTodo(
      store.getTodo('first')!,
      {
        check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/new-check' } },
      },
      2
    );
    const before = snapshot();
    expect(
      await commit(
        { kind: 'close', todoId: 'first', reason: 'Finished' },
        {
          check: previous,
          result: { done: true },
        }
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('todo_changed:') });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('a card opened after planning refuses completion without writes or announcements', async () => {
    replyCard();
    const before = snapshot();
    expect(
      await commit(
        { kind: 'edit', todoId: 'first', done: 'reported', evidence: 'Done' },
        {
          check: store.getTodo('first')!.check,
          result: { done: true },
        }
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('card_unanswered:') });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('a passed current check completes and prunes the start card atomically', async () => {
    store.askQuestion(
      'start',
      'ask',
      {
        kind: 'start',
        text: 'Start?',
        startTodos: ['first'],
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      3
    );
    expect(
      await commit(
        { kind: 'close', todoId: 'first', reason: 'Finished' },
        {
          check: store.getTodo('first')!.check,
          result: { done: true },
        }
      )
    ).toMatchObject({ ok: true, todo: { state: 'done' } });
    expect(store.getQuestion('start')!.state).toBe('retired');
    expect(changes).toContain('neo_todos');
  });

  test.each(['done', 'dropped'] as const)(
    'a %s ask returns an unchanged successful receipt',
    async (status) => {
      store.settleAsk(store.getAsk('ask')!, status, 'Human settled it', 2);
      const before = snapshot();
      expect(await commit({ kind: 'edit', todoId: 'first', title: 'Ignored' })).toMatchObject({
        ok: true,
        todo: { title: 'first' },
        records: [expect.stringContaining('ask_settled:')],
      });
      expect(snapshot()).toEqual(before);
      expect(changes).toEqual([]);
    }
  );

  test('duplicate PR edits both commit with ownership bookkeeping on the second receipt', async () => {
    expect(await commit({ kind: 'edit', todoId: 'first', addUrls: [url] })).toMatchObject({
      ok: true,
    });
    expect(await commit({ kind: 'edit', todoId: 'peer', addUrls: [url] })).toMatchObject({
      ok: true,
      todo: { check: { params: { urls: [url] } } },
      records: [expect.stringContaining('pr_already_tracked:')],
    });
    expect(store.listTodos('ask').every((todo) => JSON.stringify(todo.check).includes(url))).toBe(
      true
    );
  });

  test('a changed requirement reopens a completed todo without dropping its stored report', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'done', report: 'Keep this report' }, 2);
    expect(
      await commit({
        kind: 'edit',
        todoId: 'first',
        check: {
          pack: 'core',
          kind: 'evidence',
          params: { path: '/synthetic/new-check' },
        },
      })
    ).toMatchObject({ ok: true, todo: { state: 'todo', report: 'Keep this report' } });
  });

  test('a late SQL failure rolls back the todo, card pruning and every announcement', async () => {
    replyCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_ask_touch BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    await expect(commit({ kind: 'remove', todoId: 'first', reason: 'Replaced' })).rejects.toThrow(
      'synthetic rollback'
    );
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });
});
