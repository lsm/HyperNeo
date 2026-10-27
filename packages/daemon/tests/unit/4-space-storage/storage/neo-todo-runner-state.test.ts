import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type State = {
  todo: NeoTodo | null;
  startNext: string | null;
  changed: boolean;
  records?: string[];
};
type Claim =
  | { ok: false; reason: string; changed: boolean }
  | {
      ok: true;
      todo: NeoTodo;
      ask?: NeoAsk;
      target?: NeoDriverTarget;
      changed: boolean;
      records?: string[];
    };
describe('Data-only atomic runner state commands', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let gateway: DbGateway;
  let changes: string[];
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
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
      title: 'Ordered work',
      request: 'Keep the complete work',
      createdAt: 1,
    });
    for (const id of ['first', 'next']) {
      store.addTodo(
        id,
        'ask',
        { title: id, doneWhen: 'Observed', check: null, instruction: 'Continue work', named: null },
        1
      );
      sessions.create(id, { verb: 'send', ref: { adapter: 'hyperneo', id: `worker-${id}` } });
    }
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const run = <T>(method: 'recompute' | 'claim', args: unknown[]) => {
    const op = DB_OPS.get('neo.todoRunnerWrites') as
      | DbOp<{ method: string; args: unknown[] }, T>
      | undefined;
    expect(op, 'register the internal runner command without activating callers').toBeDefined();
    if (!op) throw new Error('Runner state command unavailable');
    expect(op.mode).toBe('write');
    return gateway.run(op, { method, args });
  };
  const snapshot = () => ({
    asks: store.listOpenAsks(),
    todos: store.listTodos('ask'),
    cards: store.listQuestions('ask'),
    target: sessions.get('first'),
  });
  const startCard = () =>
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
      2
    );

  test('completion returns full committed work and a successor candidate without dispatch', async () => {
    const report = 'Stored report 🦊\n'.repeat(20000);
    db.prepare("UPDATE neo_todos SET state='doing',started_at=2,report=? WHERE id='first'").run(
      report
    );
    startCard();
    const result = await run<State>('recompute', [
      'first',
      null,
      {},
      10,
      { state: 'done', evidence: 'Complete' },
    ]);
    expect(result).toMatchObject({
      todo: { state: 'done', report },
      startNext: 'next',
      changed: true,
    });
    expect(store.getTodo('next')!.state).toBe('todo');
    expect(store.getQuestion('start')!.state).toBe('retired');
    expect(changes).toContain('neo_todos');
  });

  test('a genuinely unchanged recomputation has no committed-change indication', async () => {
    const before = snapshot();
    expect(
      await run<State>('recompute', ['first', null, {}, 10, { state: 'no_opinion' }])
    ).toMatchObject({ changed: false, startNext: null });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('pruning alone is a committed question change even when the todo is unchanged', async () => {
    db.prepare("UPDATE neo_todos SET state='doing',started_at=2 WHERE id='first'").run();
    startCard();
    expect(
      await run<State>('recompute', ['first', null, {}, 10, { state: 'no_opinion' }])
    ).toMatchObject({ todo: { state: 'doing' }, changed: true });
    expect(store.getQuestion('start')!.state).toBe('retired');
    expect(changes).toContain('neo_questions');
  });

  test('a changed completion check refuses the stale judgement without changing work', async () => {
    store.updateTodo(
      store.getTodo('first')!,
      { check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/new-check' } } },
      2
    );
    const before = snapshot();
    expect(
      await run<State>('recompute', [
        'first',
        null,
        {},
        10,
        { state: 'done', evidence: 'Old check' },
      ])
    ).toMatchObject({ changed: false, records: [expect.stringContaining('todo_changed:')] });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('only one of competing claims wins and it returns the current target', async () => {
    startCard();
    db.prepare('UPDATE neo_todo_sessions SET target=? WHERE todo_id=?').run(
      JSON.stringify({ verb: 'send', ref: { adapter: 'hyperneo', id: 'current-worker' } }),
      'first'
    );
    const results = await Promise.all([
      run<Claim>('claim', ['first', 10]),
      run<Claim>('claim', ['first', 11]),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: true,
      todo: { state: 'doing', startedAt: 10 },
      target: { ref: { id: 'current-worker' } },
      changed: true,
    });
    expect(results[1]).toMatchObject({
      ok: false,
      changed: false,
      reason: expect.stringContaining('already_started:'),
    });
    expect(store.getQuestion('start')!.state).toBe('retired');
    expect(sessions.readRef('first')).toBeNull();
  });

  test('a newly adopted target is not claimed or dispatched', async () => {
    sessions.bind('first', { adapter: 'hyperneo', id: 'adopted-worker' }, 3);
    const before = snapshot();
    expect(await run<Claim>('claim', ['first', 10])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unsupported_target:'),
      changed: false,
    });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('claim relocation returns the current child ask and preserves the report', async () => {
    db.prepare("UPDATE neo_asks SET repo='github.com/synthetic/base' WHERE id='ask'").run();
    const report = 'Full report before claim';
    store.updateTodo(
      store.getTodo('first')!,
      {
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/synthetic/other/pull/1'] },
        },
        report,
      },
      2
    );
    const result = await run<Claim>('claim', ['first', 10]);
    expect(result).toMatchObject({
      ok: true,
      todo: { state: 'doing', repo: 'github.com/synthetic/other', report },
      ask: { repo: 'github.com/synthetic/other', parentId: 'ask' },
      changed: true,
    });
    expect(result.ok && result.todo.askId).not.toBe('ask');
    expect(store.listChildAsks('ask')).toHaveLength(1);
    expect(sessions.readRef('first')).toBeNull();
  });

  test('a failed relocation rolls the earlier claim and card pruning back too', async () => {
    db.prepare("UPDATE neo_asks SET repo='github.com/synthetic/base' WHERE id='ask'").run();
    store.updateTodo(
      store.getTodo('first')!,
      {
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/synthetic/other/pull/1'] },
        },
      },
      2
    );
    startCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_child BEFORE INSERT ON neo_asks WHEN NEW.parent_id='ask' BEGIN SELECT RAISE(ABORT, 'relocation rollback'); END"
    );
    await expect(run<Claim>('claim', ['first', 10])).rejects.toThrow('relocation rollback');
    expect(snapshot()).toEqual(before);
    expect(store.listChildAsks('ask')).toEqual([]);
    expect(changes).toEqual([]);
  });

  test.each(['claim', 'recompute'] as const)(
    '%s rolls back todo, card and notifications on an ask-stamp failure',
    async (method) => {
      startCard();
      const before = snapshot();
      db.exec(
        "CREATE TRIGGER refuse_ask_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
      );
      await expect(
        run(
          method,
          method === 'claim'
            ? ['first', 10]
            : ['first', null, {}, 10, { state: 'done', evidence: 'Complete' }]
        )
      ).rejects.toThrow('synthetic rollback');
      expect(snapshot()).toEqual(before);
      expect(changes).toEqual([]);
    }
  );

  test('a settled ask is a successful unchanged claim receipt', async () => {
    store.settleAsk(store.getAsk('ask')!, 'done', 'Settled', 3);
    const before = snapshot();
    expect(await run<Claim>('claim', ['first', 10])).toMatchObject({
      ok: true,
      changed: false,
      records: [expect.stringContaining('ask_settled:')],
    });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('missing state work returns a quiet empty result', async () => {
    expect(
      await run<State>('recompute', ['missing', null, {}, 10, { state: 'no_opinion' }])
    ).toEqual({ todo: null, startNext: null, changed: false });
    expect(changes).toEqual([]);
  });
});
