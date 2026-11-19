import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { historicalAsk } from '../../helpers/accepted-ask.ts';
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
  historicalAsk(store, 'synthetic-neo', 'Observed worker');
  historicalAsk(store, 'synthetic-neo', 'Synthetic work');
  const packs = createTodoCheckPacks(db);
  const calls: string[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => packs,
    tell: async () => {},
    attend: async () => {},
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
  test.each(['neo.ask.open', 'neo.todo.add'])(
    '%s refuses a bind target with an instruction',
    async (name) => {
      const { db, calls, invoke } = setup();
      try {
        const draft = {
          after: [],
          check: pendingTodoCheck,
          title: 'Running work',
          instruction: 'Do the task',
          target: { verb: 'bind', ref },
        };
        const input =
          name === 'neo.ask.open'
            ? { title: 'Synthetic work', request: 'Track work', todos: [draft] }
            : { ...draft, askId: 'ask' };
        await expect(invoke(name, input)).rejects.toThrow(
          'A bind target attaches work that is already running; leave instruction out.'
        );
        expect(db.prepare('SELECT COUNT(*) AS n FROM neo_todo_sessions').get()).toEqual({ n: 0 });
        expect(calls).toEqual([]);
      } finally {
        db.close();
      }
    }
  );

  test('neo.todo.edit refuses a bind target', async () => {
    const { db, invoke } = setup();
    try {
      await expect(
        invoke('neo.todo.edit', { todoId: 'todo', target: { verb: 'bind', ref } })
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  test('add with a bind target records the todo as doing on that worker without dispatch', async () => {
    const { db, sessions, calls, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Observed worker',
        request: 'Track work',
        todos: [{ after: [], title: 'Merge', check: pendingTodoCheck }],
      });
      const added = await invoke('neo.todo.add', {
        after: [],
        askId: opened.todos[0].askId,
        title: 'Worker task',
        check: pendingTodoCheck,
        target: { verb: 'bind', ref },
      });
      expect(added.ok).toBe(true);
      expect(added.todo).toMatchObject({ state: 'doing', instruction: null });
      expect(added.todo.startedAt).not.toBeNull();
      expect(calls).toEqual(['work.status']);
      expect(sessions.readCard(added.todo.id)).toMatchObject({
        ref,
        model: 'claude-opus-5-5',
        effort: 'medium',
      });
    } finally {
      db.close();
    }
  });

  test('a bind target waits for nothing unfinished: it is refused and adds no todo', async () => {
    const { db, store, calls, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Observed worker',
        request: 'Track work',
        todos: [{ after: [], title: 'First step', check: pendingTodoCheck }],
      });
      const [first] = opened.todos;
      const refused = await invoke('neo.todo.add', {
        after: [first.id],
        askId: first.askId,
        title: 'Worker task',
        check: pendingTodoCheck,
        target: { verb: 'bind', ref },
      });
      expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining('not_ready') });
      expect(store.listTodos(first.askId).map((todo) => todo.title)).toEqual(['First step']);
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a passive hold through the base operation opens no decision card', async () => {
    const { db, store, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Synthetic work',
        request: 'Track work',
        todos: [
          {
            after: [],
            check: pendingTodoCheck,
            title: 'Waiting step',
            doneWhen: 'Result verified',
          },
        ],
      });
      const todo = opened.todos[0];
      expect(await invoke('neo.todo.hold', { todoId: todo.id, reason: 'Wait.' })).toMatchObject({
        ok: true,
        todo: { state: 'blocked', blockedBy: 'held' },
      });
      expect(store.todoCards(store.getTodo(todo.id)!)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('hold is its own operation: neo.todo.hold opens a hold card, edit refuses hold', async () => {
    const { db, store, calls, invoke } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Synthetic work',
        request: 'Track work',
        todos: [
          {
            after: [],
            check: pendingTodoCheck,
            title: 'Waiting step',
            doneWhen: 'Result verified',
          },
        ],
      });
      const todo = opened.todos[0];
      await expect(
        invoke('neo.todo.edit', { todoId: todo.id, hold: 'The human said wait.' })
      ).rejects.toThrow('hold is its own operation: use neo.todo.hold {todoId, reason}');
      expect(store.getTodo(todo.id)?.blockedBy).not.toBe('held');
      const held = await invoke('neo.todo.hold', {
        todoId: todo.id,
        reason: 'The human said wait.',
        decision: true,
      });
      expect(held.ok).toBe(true);
      expect(store.getTodo(todo.id)).toMatchObject({ state: 'todo', blockedBy: null });
      expect(store.todoCards(store.getTodo(todo.id)!)).toMatchObject([
        {
          state: 'open',
          cause: 'hold',
          options: ['Start', 'Remove'],
          text: 'The human said wait.',
        },
      ]);
      expect(
        await invoke('neo.todo.hold', { todoId: todo.id, reason: 'Again.', decision: true })
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining('already_waiting'),
      });
      expect(await invoke('neo.todo.hold', { todoId: todo.id, reason: null })).toMatchObject({
        ok: false,
      });
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});
