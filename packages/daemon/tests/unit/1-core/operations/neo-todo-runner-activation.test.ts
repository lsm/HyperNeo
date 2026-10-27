import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { RunDbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('Runtime runner commits before external effects', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let gateway: DbGateway;
  let effects: string[];
  let beforeWrite: () => void | Promise<void>;
  let afterWrite: () => void | Promise<void>;
  let runner: ReturnType<typeof createNeoTodoRunner>;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    gateway = new DbGateway(':memory:', db);
    effects = [];
    beforeWrite = () => {};
    afterWrite = () => {};
    const write: RunDbOp = async (op, args) => {
      await beforeWrite();
      const result = await gateway.run(op, args);
      await afterWrite();
      return result;
    };
    runner = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      store,
      sessions,
      ...{ write },
      packs: () => [],
      changed: () => {
        effects.push('changed');
      },
      tell: async () => {
        effects.push('tell');
      },
      invoke: async (_caller, name) => {
        expect(store.getTodo('first')?.state).toBe('doing');
        effects.push(name);
        return {
          kind: 'completed',
          value: {
            ok: true,
            value: { delivered: true, ref: { adapter: 'hyperneo', id: 'worker' } },
          },
        };
      },
    });
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Work',
      request: 'Preserve work',
      createdAt: 1,
    });
    store.addTodo(
      'first',
      'ask',
      { title: 'First', doneWhen: 'Observed', check: null, instruction: 'Continue', named: null },
      1
    );
    sessions.create('first', { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } });
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
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
  const snapshot = () => ({
    todo: store.getTodo('first'),
    ask: store.getAsk('ask'),
    cards: store.listQuestions('ask'),
  });

  test('a late stamp failure rolls back pruned cards and full work without effects', async () => {
    const report = 'Complete report 🦊\n'.repeat(20000);
    store.updateTodo(store.getTodo('first')!, { state: 'doing', report }, 2);
    startCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    await expect(
      runner.recompute(store.getTodo('first')!, {}, 10, { state: 'done', evidence: 'Complete' })
    ).rejects.toThrow('synthetic rollback');
    expect(snapshot()).toEqual(before);
    expect(effects).toEqual([]);
  });

  test('a claim failure leaves its start card open and dispatches nothing', async () => {
    startCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    await expect(runner.start('first')).rejects.toThrow('synthetic rollback');
    expect(snapshot()).toEqual(before);
    expect(effects).toEqual([]);
  });

  test('a queued claim dispatches only after commit and uses the current target', async () => {
    let release!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeWrite = () => pendingGate;
    const pending = runner.start('first');
    await Promise.resolve();
    await Promise.resolve();
    expect(effects).toEqual([]);
    expect(store.getTodo('first')?.state).toBe('todo');
    db.prepare('UPDATE neo_todo_sessions SET target=? WHERE todo_id=?').run(
      JSON.stringify({ verb: 'adopt', ref: { adapter: 'hyperneo', id: 'adopted' } }),
      'first'
    );
    release();
    expect(await pending).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unsupported_target:'),
    });
    expect(effects).toEqual([]);
  });

  test('recovery cannot interrupt a start while its committed claim is returning', async () => {
    let release!: () => void;
    let committed!: () => void;
    const reached = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterWrite = async () => {
      committed();
      await gate;
    };
    const pending = runner.start('first');
    await reached;
    afterWrite = () => {};
    try {
      await runner.refresh((_message, error) => {
        throw error;
      });
      expect(store.getTodo('first')?.state).toBe('doing');
      expect(sessions.readStartInterrupted('first')).toBe(false);
      expect(effects).toEqual([]);
    } finally {
      release();
      await pending.catch(() => {});
    }
  });

  test('a refused recovery commit preserves the interruption flag and cards without notices', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'doing', report: 'Keep full work' }, 2);
    startCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic recovery rollback'); END"
    );
    const warnings: string[] = [];
    await runner.refresh((_message, error) => {
      warnings.push(String(error));
    });
    expect(warnings.some((warning) => warning.includes('synthetic recovery rollback'))).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(sessions.readStartInterrupted('first')).toBe(false);
    expect(effects).toEqual([]);
  });

  test('a recovery notice waits for the committed receipt and is sent once', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'doing', report: 'Full prior report' }, 2);
    let committed!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterWrite = async () => {
      committed();
      await gate;
    };
    const pending = runner.refresh((_message, error) => {
      throw error;
    });
    await reached;
    try {
      expect(store.getTodo('first')).toMatchObject({
        state: 'failed',
        report: 'Full prior report',
      });
      expect(sessions.readStartInterrupted('first')).toBe(true);
      expect(effects).toEqual([]);
    } finally {
      release();
      await pending;
    }
    expect(effects).toEqual(['changed', 'tell']);
    afterWrite = () => {};
    await runner.refresh((_message, error) => {
      throw error;
    });
    expect(effects).toEqual(['changed', 'tell']);
  });

  test('a completion queued behind a changed check cannot advance the todo', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'doing' }, 2);
    const checked = store.getTodo('first')!;
    beforeWrite = () => {
      db.prepare('UPDATE neo_todos SET check_json=? WHERE id=?').run(
        JSON.stringify({ pack: 'core', kind: 'evidence', params: { path: '/synthetic/new' } }),
        'first'
      );
    };
    const result = await runner.recompute(checked, {}, 10, {
      state: 'done',
      evidence: 'Stale evidence',
    });
    expect(result.state).toBe('doing');
    expect(result.evidence).toBeNull();
    expect(effects).toEqual([]);
  });

  test('pruning alone announces one committed change, a repeated no-op stays quiet', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'doing' }, 2);
    startCard();
    await runner.recompute(store.getTodo('first')!);
    expect(store.getQuestion('start')?.state).toBe('retired');
    expect(effects).toEqual(['changed']);
    await runner.recompute(store.getTodo('first')!);
    expect(effects).toEqual(['changed']);
  });

  test('a settled ask returns a successful no-op receipt without dispatch or notice', async () => {
    store.settleAsk(store.getAsk('ask')!, 'done', 'Settled', 2);
    const before = snapshot();
    expect(await runner.start('first')).toEqual({
      ok: true,
      todo: before.todo,
      records: ['ask_settled: this ask is done; no work was dispatched.'],
    });
    expect(snapshot()).toEqual(before);
    expect(effects).toEqual([]);
  });
});
