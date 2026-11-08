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
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Child',
      request: 'Keep child work',
      createdAt: 3,
    });
  const moveToChild = (id: string) => {
    db.prepare('UPDATE neo_todos SET ask_id = ? WHERE id = ?').run('child', id);
    db.prepare(
      `INSERT INTO pack_coding_todos (todo_id, repo) VALUES (?, ?)
        ON CONFLICT(todo_id) DO UPDATE SET repo = excluded.repo`
    ).run(id, 'github.com/synthetic/child');
  };
  const emptiedParent = () => {
    child();
    for (const todo of store.listTodos('ask')) moveToChild(todo.id);
  };

  test.each(['todo', 'doing', 'blocked', 'failed', 'removed'] as const)(
    'done refuses an unfinished %s row without changing work or cards',
    async (state) => {
      db.prepare('UPDATE neo_todos SET state = ?, reason = NULL WHERE id = ?').run(state, 'first');
      store.updateTodo(store.getTodo('second')!, { state: 'done', evidence: 'Observed' }, 3);
      const before = snapshot();
      expect(await settle()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('todos_unfinished:'),
      });
      expect(snapshot()).toEqual(before);
      expect(changes).toEqual([]);
    }
  );

  test('a todo added after the snapshot prevents done inside the writer transaction', async () => {
    for (const todo of store.listTodos('ask'))
      store.updateTodo(todo, { state: 'done', evidence: 'Observed' }, 3);
    await run<Snapshot>('neo.askSettlementReads', 'snapshot', ['ask']);
    store.addTodo(
      'late',
      'ask',
      {
        title: 'Late step',
        doneWhen: 'Observed late work',
        check: null,
        instruction: null,
        named: null,
      },
      4
    );
    const before = snapshot();
    expect(await settle()).toMatchObject({ ok: false, reason: expect.stringContaining('late') });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

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
  test('done refuses unfinished work and preserves its diagnostic, report and worker', async () => {
    const report = 'Complete prior report 🦊\n'.repeat(20000);
    store.updateTodo(
      store.getTodo('first')!,
      { state: 'failed', reason: 'check_failed: exit 7', report },
      3
    );
    store.updateTodo(store.getTodo('second')!, { state: 'done', evidence: 'Observed' }, 3);
    sessions.create('first', { verb: 'send', ref: { adapter: 'hyperneo', id: 'current' } });
    sessions.recordRef('first', { adapter: 'hyperneo', id: 'current' }, 3);
    const before = snapshot();
    expect(await settle()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todos_unfinished:'),
    });
    expect(snapshot()).toEqual(before);
    expect(sessions.readRef('first')).toMatchObject({ id: 'current' });
    expect(changes).toEqual([]);
  });

  test.each(['done', 'closed_unverified', 'removed'] as const)(
    'done accepts existing terminal %s rows without relabeling them',
    async (state) => {
      for (const todo of store.listTodos('ask'))
        store.writeTodo(todo, { state, reason: 'Explicitly ended', evidence: 'Recorded' }, 3);
      const before = store.listTodos('ask');
      expect(await settle()).toMatchObject({ ok: true, ask: { status: 'done' }, todos: before });
      expect(store.listTodos('ask')).toEqual(before);
      expect(store.getQuestion('card')?.state).toBe('retired');
    }
  );

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
      await expect(settle('dropped')).rejects.toThrow('synthetic rollback');
      expect(snapshot()).toEqual(before);
      expect(changes).toEqual([]);
    }
  );
  test('the writer checks current state instead of an earlier snapshot', async () => {
    await run<Snapshot>('neo.askSettlementReads', 'snapshot', ['ask']);
    store.updateTodo(store.getTodo('first')!, { state: 'done', evidence: 'New evidence' }, 4);
    const before = snapshot();
    const result = await settle();
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('second (second)') });
    expect(!result.ok && result.reason).not.toContain('first (first)');
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
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
    for (const todo of store.listTodos('ask'))
      store.updateTodo(todo, { state: 'done', evidence: 'Observed' }, 3);
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
  test('explicit parent settlement leaves historical child work and needs-human cards open', async () => {
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
    expect(await settle()).toMatchObject({
      ok: true,
      ask: { status: 'done', outcome: 'Closed by the human' },
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
  test('a pending child answer still holds needs-human work after the parent settles', async () => {
    emptiedParent();
    store.updateTodo(
      store.getTodo('first')!,
      { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Answer pending' },
      5
    );
    const card = store.askQuestion(
      'answer',
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
    store.questionAnswers.bind(card.id, 'first', {
      adapter: 'codex-desktop',
      id: 'synthetic-thread',
      daemon: null,
    });
    store.answerQuestion(card, { picked: ['Go'] } as never, 'button', 6);
    await settle();
    const held = await store.recompute(
      store.getTodo('first')!,
      {},
      20,
      { state: 'no_opinion' },
      async () => {}
    );
    expect(held).toMatchObject({ state: 'blocked', blockedBy: 'needs-human' });
    expect(store.getQuestion(card.id)?.state).toBe('answered');
  });

  test.each(['done', 'dropped'] as const)(
    '%s preserves or explicitly ends a needs-human hold',
    async (status) => {
      store.updateTodo(
        store.getTodo('first')!,
        { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Waiting' },
        3
      );
      const before = snapshot();
      const result = await settle(status);
      if (status === 'done') {
        expect(result).toMatchObject({
          ok: false,
          reason: expect.stringContaining('todos_unfinished:'),
        });
        expect(snapshot()).toEqual(before);
        expect(changes).toEqual([]);
      } else {
        expect(result).toMatchObject({
          ok: true,
          todos: [{ id: 'first', state: 'removed', blockedBy: null }, {}],
        });
      }
    }
  );
  test('shared stop context returns the current ask, adopted ref and live status without writes', async () => {
    child();
    moveToChild('first');
    sessions.bind('first', { adapter: 'hyperneo', id: 'adopted' }, 5);
    sessions.recordLive('first', 'done', undefined);
    expect(await run('neo.todoSessionReads', 'stopContext', ['first'])).toMatchObject({
      todo: { id: 'first', askId: 'child' },
      ask: { id: 'child' },
      ref: { id: 'adopted' },
      live: 'done',
      adopted: true,
    });
    expect(changes).toEqual([]);
  });
});
