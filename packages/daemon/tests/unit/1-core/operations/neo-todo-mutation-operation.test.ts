import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';

type Receipt =
  | { ok: false; reason: string }
  | { ok: true; todo: NeoTodo; todos: NeoTodo[]; records?: string[] };
describe('Writer-backed todo operation activation', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let gateway: DbGateway;
  let order: string[];
  let duringStop: () => void;
  let stopFailure: string | null;
  let call: (name: string, input: object, role?: 'neo' | 'direct_task_worker') => Promise<Receipt>;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    gateway = new DbGateway(':memory:', db);
    order = [];
    duringStop = () => {};
    stopFailure = null;
    gateway.onChanges = () => {
      order.push('commit');
    };
    const packs = createTodoCheckPacks(db);
    packs.find((pack) => pack.id === 'coding')!.todos!.check = async () => ({ done: true });
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Atomic operations',
      request: 'Commit first',
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
          instruction: id === 'peer' ? 'Next task' : null,
          named: null,
        },
        1
      );
    const stop = async () => {
      order.push('stop');
      duringStop();
      return stopFailure;
    };
    const start = async (id: string) => {
      order.push(`start:${id}`);
      expect(store.getTodo('first')!.state).toBe('done');
      store.updateTodo(store.getTodo(id)!, { state: 'doing', startedAt: 3 }, 3);
      return { ok: true as const, todo: store.getTodo(id)! };
    };
    const legacy = createNeoTodoOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        resolveTarget: existingTodoTarget,
        recompute: async () => {
          throw new Error('Legacy mutation write was called');
        },
        start,
        stop,
        proceed: async () => ({ ok: false as const, reason: 'unused' }),
        retry: async () => ({ ok: false as const, reason: 'unused' }),
      },
      () => packs,
      () => null
    );
    const registry = createOperationRegistry(
      wireNeoTodoMutations(legacy, {
        gateway,
        write: gateway.run.bind(gateway),
        packs: () => packs,
        artifact: () => null,
        stop,
        start,
        changed: () => {
          order.push('announce');
        },
        project: async (todos) => todos.map((todo) => ({ ...todo, worker: null })),
      })
    );
    call = async (name, input, role = 'neo') => {
      const result = await invokeOperation(registry, name, input, {
        source: 'mcp',
        sessionId: 'neo',
        role,
      });
      expect(result.kind).toBe('completed');
      if (result.kind !== 'completed') throw new Error(result.message);
      return result.value as Receipt;
    };
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  test('edit uses the atomic command and returns the entire committed report', async () => {
    const text = 'Complete report 🦊\n'.repeat(20000).trim();
    expect(
      await call('neo.todo.edit', { todoId: 'first', done: 'reported', evidence: text })
    ).toMatchObject({ ok: true, todo: { state: 'done', report: text } });
    expect(order.slice(0, 2)).toEqual(['commit', 'announce']);
  });

  test('close stops first, commits before dispatch and returns refreshed successor state', async () => {
    const result = await call('neo.todo.close', { todoId: 'first', reason: 'Finished' });
    expect(result).toMatchObject({ ok: true, todo: { state: 'done' } });
    expect(order).toEqual(['stop', 'commit', 'announce', 'start:peer']);
    expect(result.ok && result.todos.find((todo) => todo.id === 'peer')?.state).toBe('doing');
  });

  test('a new human card during stop prevents the final completion write', async () => {
    duringStop = () => {
      store.askQuestion(
        'reply',
        'ask',
        {
          kind: 'reply',
          todoId: 'first',
          text: 'Answer first',
          options: null,
          multiple: false,
          yesLabel: null,
          noLabel: null,
        },
        2
      );
    };
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('card_unanswered:'),
    });
    expect(store.getTodo('first')!.state).toBe('todo');
    expect(order).toEqual(['stop']);
  });

  test('a check changed during stop cannot use the prior passed completion', async () => {
    duringStop = () => {
      store.updateTodo(
        store.getTodo('first')!,
        { check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/new-check' } } },
        2
      );
    };
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todo_changed:'),
    });
    expect(order).toEqual(['stop']);
  });

  test('a failed stop leaves the todo unchanged without announcing or dispatching', async () => {
    stopFailure = 'stop_failed: driver offline';
    expect(await call('neo.todo.remove', { todoId: 'first', reason: 'Replaced' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('stop_failed:'),
    });
    expect(store.getTodo('first')!.state).toBe('todo');
    expect(order).toEqual(['stop']);
  });

  test('remove commits the retired todo only after its stop succeeds', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'done' }, 2);
    expect(await call('neo.todo.remove', { todoId: 'peer', reason: 'Replaced' })).toMatchObject({
      ok: true,
      todo: { state: 'removed', reason: 'Replaced' },
    });
    expect(order).toEqual(['stop', 'commit', 'announce']);
  });

  test('a settled ask stays a successful no-op without stop, announce or dispatch', async () => {
    store.settleAsk(store.getAsk('ask')!, 'done', 'Human settled it', 2);
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Ignored' })).toMatchObject({
      ok: true,
      todo: { worker: null },
      records: [expect.stringContaining('ask_settled:')],
    });
    expect(order).toEqual([]);
  });

  test('a SQL failure never announces a successful mutation', async () => {
    db.exec(
      "CREATE TRIGGER refuse_ask_touch BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    await expect(call('neo.todo.edit', { todoId: 'first', title: 'Ignored' })).rejects.toThrow();
    expect(store.getTodo('first')!.title).toBe('first');
    expect(order).toEqual([]);
  });
});
