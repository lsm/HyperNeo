import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Snapshot = { ask: NeoAsk; todos: NeoTodo[] };
type Receipt =
  | { ok: false; reason: string }
  | ({ ok: true; refs: { todoId: string; ref: WorkRef | null }[]; records?: string[] } & Snapshot);
describe('Data-only atomic ask settlement', () => {
  let db: Database,
    store: NeoAskTodoRepository,
    sessions: NeoTodoSessionRepository,
    gateway: DbGateway,
    changes: string[];
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (events) => {
      changes.push(...events.map((event) => event.table));
    };
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Full work',
      request: 'Keep work',
      createdAt: 1,
    });
    for (const id of ['first', 'second'])
      store.addTodo(
        id,
        'ask',
        { title: id, doneWhen: `Observe ${id}`, check: null, instruction: null, named: null },
        1
      );
    store.askQuestion(
      'card',
      'ask',
      {
        kind: 'reply',
        text: 'Choose',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      2
    );
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const run = <T>(name: string, method: string, args: unknown[]) =>
    gateway.run(DB_OPS.get(name) as DbOp<unknown, T>, { method, args });
  const settle = (status: 'done' | 'dropped' = 'done', askId = 'ask') =>
    run<Receipt>('neo.askSettlementWrites', 'settle', [
      { askId, status, outcome: 'Closed by the human' },
      10,
    ]);
  const split = () => run<Receipt | null>('neo.askSettlementWrites', 'splitParent', ['ask', 10]);
  const snapshot = () => ({
    ask: store.getAsk('ask'),
    todos: store.listTodos('ask'),
    cards: store.listQuestions('ask'),
    children: store
      .listChildAsks('ask')
      .map((ask) => ({ ask, todos: store.listTodos(ask.id), cards: store.listQuestions(ask.id) })),
  });
  const child = () =>
    store.openAsk({
      id: 'child',
      parentId: 'ask',
      repo: 'github.com/synthetic/child',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Child',
      request: 'Keep child work',
      createdAt: 3,
    });
  const emptiedParent = () => {
    child();
    for (const todo of store.listTodos('ask'))
      store.moveTodo(todo, 'child', 'github.com/synthetic/child', 4);
  };

  test('a read snapshot preserves current full reports without a write', async () => {
    const report = 'Entire work 🦊\n'.repeat(20000);
    store.updateTodo(store.getTodo('first')!, { report }, 3);
    const before = snapshot();
    expect(await run<Snapshot>('neo.askSettlementReads', 'snapshot', ['ask'])).toMatchObject({
      ask: { status: 'open' },
      todos: [{ id: 'first', report }, {}],
    });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });
  test('done closes unfinished work unverified and preserves failure diagnostics and full reports', async () => {
    const report = 'Complete prior report 🦊\n'.repeat(20000);
    store.updateTodo(
      store.getTodo('first')!,
      { state: 'failed', reason: 'check_failed: exit 7', report },
      3
    );
    store.updateTodo(store.getTodo('second')!, { state: 'done', evidence: 'Observed' }, 3);
    sessions.create('first', { verb: 'send', ref: { adapter: 'hyperneo', id: 'current' } });
    sessions.recordRef('first', { adapter: 'hyperneo', id: 'current' }, 3);
    const result = await settle();
    expect(result).toMatchObject({
      ok: true,
      ask: { status: 'done' },
      todos: [
        {
          id: 'first',
          state: 'closed_unverified',
          report,
          reason: expect.stringContaining('check_failed: exit 7'),
        },
        { id: 'second', state: 'done', evidence: 'Observed' },
      ],
      refs: [
        { todoId: 'first', ref: { id: 'current' } },
        { todoId: 'second', ref: null },
      ],
      records: [expect.stringContaining('todos_unfinished:')],
    });
    expect(store.getQuestion('card')?.state).toBe('retired');
    expect(new Set(changes)).toEqual(new Set(['neo_asks', 'neo_todos', 'neo_questions']));
  });
  test('dropped removes active work without certifying it', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'doing', report: 'Retain this' }, 3);
    expect(await settle('dropped')).toMatchObject({
      ok: true,
      todos: [{ state: 'removed', report: 'Retain this' }, { state: 'removed' }],
    });
    expect(store.getQuestion('card')?.state).toBe('retired');
  });
  test.each(['todo', 'question'] as const)(
    'a late %s write failure rolls back the whole settlement',
    async (kind) => {
      const before = snapshot();
      db.exec(
        kind === 'todo'
          ? "CREATE TRIGGER reject_row BEFORE UPDATE ON neo_todos WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
          : "CREATE TRIGGER reject_card BEFORE UPDATE ON neo_questions BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
      );
      await expect(settle()).rejects.toThrow('synthetic rollback');
      expect(snapshot()).toEqual(before);
      expect(changes).toEqual([]);
    }
  );
  test('the writer uses changed current state instead of an earlier snapshot', async () => {
    await run<Snapshot>('neo.askSettlementReads', 'snapshot', ['ask']);
    store.updateTodo(store.getTodo('first')!, { state: 'done', evidence: 'New evidence' }, 4);
    const result = await settle();
    expect(result).toMatchObject({
      ok: true,
      todos: [
        { id: 'first', state: 'done', evidence: 'New evidence' },
        { id: 'second', state: 'closed_unverified' },
      ],
      records: [expect.not.stringContaining('Observe first')],
    });
  });
  test('a settled ask rejects a stale plan without changing its existing outcome', async () => {
    await run<Snapshot>('neo.askSettlementReads', 'snapshot', ['ask']);
    store.settleAsk(store.getAsk('ask')!, 'dropped', 'Earlier decision', 4);
    const before = snapshot();
    expect(await settle()).toEqual({ ok: false, reason: 'ask_settled: this ask is dropped.' });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });
  test('competing settlements produce one successful receipt', async () => {
    const receipts = await Promise.all([settle(), settle('dropped')]);
    expect(receipts.filter((result) => result.ok)).toHaveLength(1);
    expect(receipts[1]).toMatchObject({
      ok: false,
      reason: expect.stringContaining('ask_settled:'),
    });
  });
  test('an empty ask announces only its header change', async () => {
    store.openAsk({
      id: 'empty',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Empty',
      request: 'Empty',
      createdAt: 1,
    });
    expect(await settle('done', 'empty')).toMatchObject({ ok: true, todos: [], refs: [] });
    expect(changes).toEqual(['neo_asks']);
  });
  test('missing asks return a quiet rejection', async () => {
    expect(await settle('done', 'missing')).toEqual({
      ok: false,
      reason: 'not_found: no such ask.',
    });
    expect(changes).toEqual([]);
  });
  test('split-parent settlement leaves child work and needs-human cards open', async () => {
    emptiedParent();
    store.updateTodo(
      store.getTodo('first')!,
      { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Answer the card' },
      5
    );
    store.askQuestion(
      'child-card',
      'child',
      {
        kind: 'choice',
        todoId: 'first',
        text: 'Go?',
        options: ['Go', 'Stop'],
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      5
    );
    const before = snapshot().children;
    expect(await split()).toMatchObject({
      ok: true,
      ask: { status: 'done', outcome: expect.stringContaining('Filed 2 todos') },
      todos: [],
      refs: [],
    });
    expect(snapshot().children).toEqual(before);
    expect(store.getQuestion('card')?.state).toBe('retired');
    store.retireQuestion(store.getQuestion('child-card')!, 'Neo decided per the human', null, 12);
    const released = await store.recompute(
      store.getTodo('first')!,
      {},
      20,
      { state: 'no_opinion' },
      async () => {}
    );
    expect(released.blockedBy).not.toBe('needs-human');
    expect(['todo', 'doing']).toContain(released.state);
  });
  test('a root that gained its own todo is not auto-settled', async () => {
    emptiedParent();
    store.addTodo(
      'late',
      'ask',
      { title: 'Late', doneWhen: 'Observed', check: null, instruction: null, named: null },
      5
    );
    const before = snapshot();
    expect(await split()).toBeNull();
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });
  test('an absent or already settled split root stays quiet', async () => {
    expect(await split()).toBeNull();
    emptiedParent();
    await split();
    changes.length = 0;
    expect(await split()).toBeNull();
    expect(await run('neo.askSettlementWrites', 'splitParent', ['missing', 10])).toBeNull();
    expect(changes).toEqual([]);
  });
  test.each(['done', 'dropped'] as const)(
    'explicit %s settlement ends a needs-human hold using current policy',
    async (status) => {
      store.updateTodo(
        store.getTodo('first')!,
        { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Waiting' },
        3
      );
      expect(await settle(status)).toMatchObject({
        ok: true,
        todos: [
          {
            id: 'first',
            state: status === 'done' ? 'closed_unverified' : 'removed',
            blockedBy: null,
          },
          {},
        ],
      });
    }
  );
  test('shared stop context returns the current ask, adopted ref and live status without writes', async () => {
    child();
    store.moveTodo(store.getTodo('first')!, 'child', 'github.com/synthetic/child', 4);
    sessions.bind('first', { adapter: 'hyperneo', id: 'adopted' }, 5);
    sessions.recordLive('first', 'done', undefined);
    expect(
      await gateway.call(
        DB_OPS.get('neo.todoSessionReads') as never,
        'stopContext' as never,
        'first' as never
      )
    ).toMatchObject({
      todo: { id: 'first', askId: 'child' },
      ask: { id: 'child' },
      ref: { id: 'adopted' },
      live: 'done',
      adopted: true,
    });
    expect(changes).toEqual([]);
  });
});
