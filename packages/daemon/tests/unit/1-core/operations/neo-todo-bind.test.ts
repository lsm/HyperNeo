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
  test.each(['neo.ask.open', 'neo.todo.add', 'neo.todo.edit'])(
    '%s refuses a bind target and points to neo.todo.bind or a send target',
    async (name) => {
      const { db, sessions, calls, invoke } = setup();
      try {
        const target = { verb: 'bind', ref };
        const input =
          name === 'neo.ask.open'
            ? {
                title: 'Synthetic work',
                request: 'Give the worker a task',
                todos: [
                  {
                    check: pendingTodoCheck,
                    title: 'Running work',
                    instruction: 'Do the task',
                    target,
                  },
                ],
              }
            : name === 'neo.todo.add'
              ? { askId: 'ask', title: 'Running work', check: pendingTodoCheck, target }
              : { todoId: 'todo', instruction: 'Do the task', target };
        await expect(invoke(name, input)).rejects.toThrow(
          'bind is its own operation: use neo.todo.bind {todoId, ref} for work already running; to give a worker a new task use target {verb: send, ref}.'
        );
        expect(db.prepare('SELECT COUNT(*) AS n FROM neo_todo_sessions').get()).toEqual({ n: 0 });
        expect(sessions.readRef('todo')).toBeNull();
        expect(calls).toEqual([]);
      } finally {
        db.close();
      }
    }
  );
  test('explicit bind refreshes identity for an unbound todo without dispatch', async () => {
    const { db, sessions, calls, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Observed worker',
        request: 'Track work',
        todos: [{ title: 'Worker task', check: pendingTodoCheck }],
      });
      const todoId = opened.todos[0].id;
      const result = await invoke('neo.todo.bind', { todoId, ref });
      expect(result.ok).toBe(true);
      expect(calls).toEqual(['work.status']);
      expect(sessions.readCard(todoId)).toMatchObject({
        ref,
        model: 'claude-opus-5-5',
        effort: 'medium',
      });
    } finally {
      db.close();
    }
  });

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
      await invoke('neo.todo.hold', { todoId: todo.id, reason: 'The human said wait.' });
      const bound = await invoke('neo.todo.bind', { todoId: todo.id, ref });
      expect(bound.ok).toBe(false);
      expect(store.getTodo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'held' });
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('hold is its own operation: neo.todo.hold holds and releases, edit refuses hold', async () => {
    const { db, store, calls, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Synthetic work',
        request: 'Track work',
        todos: [{ check: pendingTodoCheck, title: 'Waiting step', doneWhen: 'Result verified' }],
      });
      const todo = opened.todos[0];
      await expect(
        invoke('neo.todo.edit', { todoId: todo.id, hold: 'The human said wait.' })
      ).rejects.toThrow('hold is its own operation: use neo.todo.hold {todoId, reason}');
      expect(store.getTodo(todo.id)?.blockedBy).not.toBe('held');
      const held = await invoke('neo.todo.hold', {
        todoId: todo.id,
        reason: 'The human said wait.',
      });
      expect(held.ok).toBe(true);
      expect(store.getTodo(todo.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'held',
        blockedReason: 'The human said wait.',
      });
      const released = await invoke('neo.todo.hold', { todoId: todo.id, reason: null });
      expect(released.ok).toBe(true);
      expect(store.getTodo(todo.id)).toMatchObject({ state: 'todo', blockedBy: null });
      expect(await invoke('neo.todo.hold', { todoId: todo.id, reason: null })).toMatchObject({
        ok: false,
      });
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});
