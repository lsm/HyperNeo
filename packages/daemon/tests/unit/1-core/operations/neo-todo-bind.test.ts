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
  const store = new NeoAskTodoRepository(db),
    sessions = new NeoTodoSessionRepository(db);
  const calls: string[] = [];
  const runner = createNeoTodoRunner({
    store,
    sessions,
    packs: () => [],
    tell: async () => {},
    changed: () => {},
    invoke: async (_caller, name) => {
      calls.push(name);
      return {
        kind: 'completed',
        value: { ok: true, value: { status: 'running', lastActivityAt: Date.now() } },
      };
    },
  });
  const operations = [
    ...createNeoTodoOperations(
      store,
      sessions,
      runner,
      () => [],
      () => null
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      runner,
      () => null,
      (id) => id === caller.sessionId,
      () => [],
      () => []
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
            { title: 'Running work', doneWhen: 'Result verified', target: { verb: 'bind', ref } },
          ],
        });
        expect(result.ok).toBe(true);
        expect(result.todos[0].state).toBe('doing');
        expect(sessions.readRef(result.todos[0].id)).toEqual(ref);
        expect(calls).toEqual([]);
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
});
