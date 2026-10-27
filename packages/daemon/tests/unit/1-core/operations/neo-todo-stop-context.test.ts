import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';

describe('current worker stop context', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let runner: ReturnType<typeof createNeoTodoRunner>;
  let beforeRead: () => void;
  let outcome: () => Promise<OperationOutcome>;
  const calls: { ref: unknown; sessionId?: string }[] = [];
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Work',
      request: 'Keep work',
      createdAt: 1,
    });
    store.addTodo(
      'todo',
      'ask',
      { title: 'Work', instruction: 'Continue', check: null, doneWhen: 'Observed', named: null },
      1
    );
    store.updateTodo(
      store.getTodo('todo')!,
      { state: 'doing', report: 'Full report 🦊\n'.repeat(20000) },
      2
    );
    sessions.create('todo', { verb: 'send', ref: { adapter: 'hyperneo', id: 'old' } });
    sessions.recordRef('todo', { adapter: 'hyperneo', id: 'old' }, 2);
    beforeRead = () => {};
    calls.length = 0;
    outcome = async () => ({ kind: 'completed', value: { ok: true } });
    const read = sessions.read.bind(sessions);
    sessions.read = ((...args: Parameters<typeof sessions.read>) => {
      beforeRead();
      return Reflect.apply(read, sessions, args);
    }) as typeof sessions.read;
    runner = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      store,
      sessions,
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      packs: () => [],
      changed: () => {},
      tell: async () => {},
      invoke: async (caller, name, input) => {
        expect(name).toBe('work.stop');
        db.exec('BEGIN');
        db.exec('ROLLBACK');
        calls.push({ ref: input.ref, sessionId: caller.sessionId });
        return outcome();
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await gatewayFor(db).close();
    db.close();
  });
  const stop = () => runner.stop(store.getTodo('todo')!);

  test('stops the current replacement using reader context without main-thread observations', async () => {
    const prior = store.getTodo('todo')!;
    beforeRead = () => {
      new NeoTodoSessionRepository(db).recordRef(
        'todo',
        { adapter: 'hyperneo', id: 'replacement' },
        3
      );
    };
    vi.spyOn(sessions, 'readRef').mockImplementation(() => {
      throw new Error('Main-thread stop read');
    });
    vi.spyOn(sessions, 'readLiveStatus').mockImplementation(() => {
      throw new Error('Main-thread stop read');
    });
    expect(await runner.stop(prior)).toBeNull();
    expect(calls).toEqual([{ ref: { adapter: 'hyperneo', id: 'replacement' }, sessionId: 'neo' }]);
    expect(store.getTodo('todo')).toEqual(prior);
  });

  test('a stale doing argument cannot stop a currently completed worker', async () => {
    const prior = store.getTodo('todo')!;
    store.updateTodo(prior, { state: 'done' }, 3);
    sessions.recordLive('todo', 'done');
    expect(await runner.stop(prior)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a stale settled argument cannot skip a currently doing replacement', async () => {
    const prior = { ...store.getTodo('todo')!, state: 'done' as const };
    sessions.recordLive('todo', 'stopped');
    expect(await runner.stop(prior)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('a newly adopted worker is exempt even after the caller planned a stop', async () => {
    beforeRead = () => sessions.bind('todo', { adapter: 'hyperneo', id: 'adopted' }, 3);
    expect(await stop()).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a missing current todo stops nothing', async () => {
    const stale = store.getTodo('todo')!;
    db.prepare('DELETE FROM neo_todos WHERE id=?').run('todo');
    expect(await runner.stop(stale)).toBeNull();
    expect(calls).toEqual([]);
  });

  test.each([
    [
      'driver refusal',
      async () =>
        ({
          kind: 'completed',
          value: { ok: false, reason: 'refused', detail: 'Keep running' },
        }) as OperationOutcome,
      'Keep running',
    ],
    [
      'operation failure',
      async () => ({ kind: 'failed', message: 'Unavailable' }) as OperationOutcome,
      'Unavailable',
    ],
    [
      'driver throw',
      async () => {
        throw new Error('Disconnected');
      },
      'Disconnected',
    ],
  ])('%s retains the complete report', async (_name, fail, reason) => {
    outcome = fail;
    const before = store.getTodo('todo');
    const result = await stop();
    expect(result).toContain('stop_failed: ');
    expect(result).toContain(reason);
    expect(store.getTodo('todo')).toEqual(before);
  });

  test('unsupported stop remains a successful no-op', async () => {
    outcome = async () => ({ kind: 'completed', value: { ok: false, reason: 'unsupported' } });
    expect(await stop()).toBeNull();
  });
});
