import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
const caller: OperationCaller = { source: 'mcp', sessionId: 'synthetic-neo', role: 'neo' };
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db),
    sessions = new NeoTodoSessionRepository(db);
  const packs = createTodoCheckPacks(db);
  const calls: string[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => packs,
    tell: async () => {},
    changed: () => {},
    invoke: async (_caller, name) => {
      calls.push(name);
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: {
            status: 'running',
            lastActivityAt: Date.now(),
            model: 'claude-opus-5-5',
            effort: 'medium',
          },
        },
      };
    },
  });
  const operations = [
    ...createNeoTodoOperations(
      store,
      sessions,
      { ...runner, resolveTarget: existingTodoTarget },
      () => packs,
      () => null
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      { ...runner, resolveTarget: existingTodoTarget },
      () => null,
      (id) => id === caller.sessionId,
      () => [],
      () => packs,
      undefined,
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
    ),
  ];
  const invoke = async (name: string, input: unknown) => {
    const op = operations.find((op) => op.name === name);
    expect(op).toBeDefined();
    return (await op!.execute(op!.inputSchema.parse(input), caller)) as {
      ok: boolean;
      todo: NeoTodo;
      todos: NeoTodo[];
      reason?: string;
    };
  };
  return { db, store, sessions, runner, calls, invoke };
}

describe('bind an already running worker without dispatch', () => {
  test.each([{}, { instruction: 'Work is already running', start: true }])(
    'ask-open binds immediately without dispatch even with options %j',
    async (options) => {
      const { db, sessions, calls, invoke } = setup();
      try {
        const result = await invoke('neo.ask.open', {
          title: 'Synthetic work',
          request: 'Track work already in progress',
          todos: [
            {
              check: pendingTodoCheck,
              title: 'Running work',
              doneWhen: 'Result verified',
              ...options,
              target: { verb: 'bind', ref },
            },
          ],
        });
        expect(result.ok).toBe(true);
        expect(result.todos[0].state).toBe('doing');
        expect(result.todos[0].instruction).toBe(options.instruction ?? null);
        expect(sessions.readRef(result.todos[0].id)).toEqual(ref);
        expect(calls).toEqual(['work.status']);
        expect(sessions.readCard(result.todos[0].id)).toMatchObject({
          model: 'claude-opus-5-5',
          effort: 'medium',
        });
      } finally {
        db.close();
      }
    }
  );
  test('a failed backfill can be rebound in place, clearing failure and stale delivery without sending', async () => {
    const { db, store, sessions, calls, invoke, runner } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Synthetic work',
        request: 'Track work',
        todos: [
          {
            check: pendingTodoCheck,
            title: 'Failed backfill',
            doneWhen: 'Result verified',
            instruction: 'Original task already running',
            target: { verb: 'send', ref },
          },
        ],
      });
      const todo = opened.todos[0];
      store.updateTodo(
        todo,
        { state: 'failed', reason: 'Delivery was not confirmed', finishedAt: 2 },
        2
      );
      sessions.create(todo.id, { verb: 'send', ref });
      sessions.recordRef(todo.id, ref, 1);
      sessions.recordSent(todo.id, { inputBefore: 1, opening: 'Old instruction' });
      const rebound = await invoke('neo.todo.bind', { todoId: todo.id, ref });
      expect(rebound.ok).toBe(true);
      expect(rebound.todo).toMatchObject({
        id: todo.id,
        state: 'doing',
        reason: null,
        finishedAt: null,
      });
      expect(sessions.readRef(todo.id)).toEqual(ref);
      expect(sessions.readSent(todo.id)).toBeNull();
      expect(calls).toEqual([]);
      await runner.refresh((message) => {
        throw new Error(message);
      });
      expect(store.getTodo(todo.id)?.state).toBe('doing');
      expect(calls.filter((name) => name !== 'work.status')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a held todo cannot be bound to a worker', async () => {
    const { db, store, calls, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Synthetic work',
        request: 'Track work',
        todos: [{ check: pendingTodoCheck, title: 'Held step', doneWhen: 'Result verified' }],
      });
      const todo = opened.todos[0];
      await invoke('neo.todo.edit', { todoId: todo.id, hold: 'The human said wait.' });
      const bound = await invoke('neo.todo.bind', { todoId: todo.id, ref });
      expect(bound.ok).toBe(false);
      expect(store.getTodo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'held' });
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});
