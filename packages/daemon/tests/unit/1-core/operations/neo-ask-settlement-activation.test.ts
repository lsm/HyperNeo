import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Receipt =
  | { ok: false; reason: string }
  | { ok: true; ask: NeoAsk; todos: NeoTodo[]; records?: string[] };
describe('activated ask settlement', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let ops: ReturnType<typeof createNeoAskRecordOperations>;
  let beforeWrite: () => void | Promise<void>;
  let afterWrite: () => void | Promise<void>;
  let onStop: (todo: NeoTodo) => Promise<string | null>;
  const effects: string[] = [];
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    effects.length = 0;
    beforeWrite = () => {};
    afterWrite = () => {};
    onStop = async () => null;
    const gateway = gatewayFor(db),
      call = gateway.call.bind(gateway);
    gateway.call = (async (op, method, ...args) => {
      if (op.name === 'neo.askSettlementWrites') await beforeWrite();
      const result = await Reflect.apply(call, gateway, [op, method, ...args]);
      if (op.name === 'neo.askSettlementWrites') await afterWrite();
      return result;
    }) as typeof gateway.call;
    ops = Reflect.apply(createNeoAskRecordOperations, undefined, [
      store,
      sessions,
      {
        start: async () => {
          throw new Error('No dispatch');
        },
        proceed: async () => {},
        retry: async () => {},
        stop: async (todo: NeoTodo) => {
          db.exec('BEGIN');
          db.exec('ROLLBACK');
          effects.push(`stop:${todo.id}`);
          return onStop(todo);
        },
      },
      () => null,
      () => true,
      () => [],
      () => [],
      () => null,
      async (todos: NeoTodo[]) => todos,
      {
        gateway,
        changed: () => {
          effects.push('changed');
        },
      },
    ]);
    store.openAsk({
      id: 'ask',
      title: 'Work',
      request: 'Keep work',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      createdAt: 1,
    });
    seed('first');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await gatewayFor(db).close();
    db.close();
  });
  const seed = (id: string, askId = 'ask') => {
    const todo = store.addTodo(
      id,
      askId,
      { title: id, doneWhen: 'Observed', check: null, instruction: null, named: null },
      1
    );
    sessions.create(id, { verb: 'send', ref: { adapter: 'hyperneo', id } });
    sessions.recordRef(id, { adapter: 'hyperneo', id }, 2);
    return store.updateTodo(
      todo,
      { state: 'doing', report: 'Full report 🦊\n'.repeat(20000), reason: 'Previous diagnostic' },
      2
    );
  };
  const settle = (status: 'done' | 'dropped' = 'done') =>
    ops
      .find((op) => op.name === 'neo.ask.settle')!
      .execute(
        { askId: 'ask', status, outcome: 'Explicitly ended' },
        { source: 'rpc', principal: 'local' }
      ) as Promise<Receipt>;
  const snapshot = () => ({
    ask: store.getAsk('ask'),
    todos: store.listTodos('ask'),
    questions: store.listQuestions('ask'),
  });
  const question = () =>
    store.askQuestion(
      'card',
      'ask',
      {
        kind: 'reply',
        todoId: 'first',
        text: 'Choose',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      3
    );
  const split = () =>
    ops
      .find((op) => op.name === 'neo.ask.open')!
      .execute(
        { title: 'Work', request: 'Keep work', todos: [] },
        { source: 'mcp', role: 'neo', sessionId: 'neo' }
      ) as Promise<Receipt>;
  const makeSplit = () => {
    db.prepare('DELETE FROM neo_todos WHERE id=?').run('first');
    store.openAsk({
      id: 'child',
      parentId: 'ask',
      repo: 'github.com/fixture/child',
      title: 'Child',
      request: 'Child work',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      createdAt: 1,
    });
    seed('child-work', 'child');
    store.askQuestion(
      'child-card',
      'child',
      {
        kind: 'reply',
        todoId: 'child-work',
        text: 'Choose',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      3
    );
  };

  test('current admission, sweeps and receipts avoid the main repository', async () => {
    const report = store.getTodo('first')!.report;
    vi.spyOn(store, 'getAsk').mockImplementation(() => {
      throw new Error('Main settlement admission');
    });
    vi.spyOn(store, 'listTodos').mockImplementation(() => {
      throw new Error('Main settlement sweep');
    });
    const result = await settle();
    expect(result).toMatchObject({ ok: true, todos: [{ state: 'closed_unverified', report }] });
    expect(effects).toEqual(['stop:first', 'changed']);
  });

  test('late failure rolls back the header, full todos and open card without publishing', async () => {
    question();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER fail_card BEFORE UPDATE ON neo_questions BEGIN SELECT RAISE(ABORT, 'late settlement failure'); END"
    );
    await expect(settle()).rejects.toThrow('late settlement failure');
    expect(snapshot()).toEqual(before);
    expect(effects).toEqual(['stop:first']);
  });

  test.each(['done', 'dropped'] as const)(
    '%s stop failure leaves work open with its partial-stop diagnostic',
    async (status) => {
      seed('second');
      sessions.recordRef('first', { adapter: 'hyperneo', id: 'worker' }, 2);
      onStop = async (todo) => (todo.id === 'second' ? 'stop_failed: offline' : null);
      const before = snapshot(),
        result = await settle(status);
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining('stopped: first'),
      });
      expect(result).toMatchObject({
        reason: expect.stringContaining('second: stop_failed: offline'),
      });
      expect(snapshot()).toEqual(before);
      expect(effects).toEqual(['stop:first', 'stop:second']);
    }
  );

  test('current unfinished work and a late bound worker survive in the committed receipt', async () => {
    onStop = async () => {
      seed('late');
      sessions.recordRef('late', { adapter: 'hyperneo', id: 'late-worker' }, 3);
      onStop = async () => null;
      return null;
    };
    const result = await settle();
    expect(result).toMatchObject({
      ok: true,
      todos: [
        { id: 'first', state: 'closed_unverified' },
        { id: 'late', state: 'closed_unverified' },
      ],
    });
    expect(result.ok && result.records?.[0]).toContain('late (late)');
    expect(effects).toEqual(['stop:first', 'changed', 'stop:late']);
  });

  test('a replacement binding is cleaned up after commit', async () => {
    sessions.recordRef('first', { adapter: 'hyperneo', id: 'prior-worker' }, 2);
    beforeWrite = () => {
      sessions.recordRef('first', { adapter: 'hyperneo', id: 'replacement' }, 3);
    };
    expect((await settle()).ok).toBe(true);
    expect(effects).toEqual(['stop:first', 'changed', 'stop:first']);
  });

  test('settlement publishes only after its writer receipt returns', async () => {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      atWrite = new Promise<void>((resolve) => {
        reached = resolve;
      });
    afterWrite = async () => {
      reached();
      await gate;
    };
    const pending = settle();
    try {
      expect(await Promise.race([atWrite.then(() => 'write'), pending.then(() => 'early')])).toBe(
        'write'
      );
      expect(store.getAsk('ask')!.status).toBe('done');
      expect(effects).toEqual(['stop:first']);
    } finally {
      release();
      await pending;
    }
    expect(effects).toEqual(['stop:first', 'changed']);
  });

  test('a competing settle wins without an overwrite or a new publication', async () => {
    beforeWrite = () => {
      store.settleAsk(store.getAsk('ask')!, 'dropped', 'Other actor', 3);
    };
    expect(await settle()).toMatchObject({
      ok: false,
      reason: 'ask_settled: this ask is dropped.',
    });
    expect(store.getAsk('ask')!.outcome).toBe('Other actor');
    expect(effects).toEqual(['stop:first']);
  });

  test('missing and settled asks cause neither stops nor publications', async () => {
    store.settleAsk(store.getAsk('ask')!, 'done', 'Ended', 3);
    expect(await settle()).toMatchObject({ ok: false, reason: 'ask_settled: this ask is done.' });
    db.prepare('DELETE FROM neo_asks WHERE id=?').run('ask');
    expect(await settle()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_found:'),
    });
    expect(effects).toEqual([]);
  });

  test('split-parent settlement retains child reports and cards and announces once', async () => {
    makeSplit();
    const child = store.getTodo('child-work'),
      card = store.getQuestion('child-card');
    expect(await split()).toMatchObject({
      ok: true,
      ask: { status: 'done' },
      todos: [{ id: 'child-work', report: child!.report }],
    });
    expect(store.getTodo('child-work')).toEqual(child);
    expect(store.getQuestion('child-card')).toEqual(card);
    expect(effects).toEqual(['changed']);
    await split();
    expect(effects).toEqual(['changed']);
  });

  test('a split parent gaining root work before commit remains open', async () => {
    makeSplit();
    beforeWrite = () => {
      seed('root-late');
    };
    expect(await split()).toMatchObject({ ok: true, ask: { status: 'open' } });
    expect(store.getTodo('root-late')!.state).toBe('doing');
    expect(effects).toEqual([]);
  });
});
