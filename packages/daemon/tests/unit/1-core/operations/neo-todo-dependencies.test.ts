import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  createTodoCheckPacks,
  existingTodoTarget,
  pendingTodoCheck,
} from '../../helpers/todo-check-packs.ts';

const caller: OperationCaller = { source: 'mcp', sessionId: 'synthetic-neo', role: 'neo' };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const packs = createTodoCheckPacks(db);
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => packs,
    tell: async () => {},
    changed: () => {},
    invoke: async () => ({ kind: 'completed', value: { ok: true, value: {} } }),
  });
  const controls = { ...runner, resolveTarget: existingTodoTarget };
  const gateway = gatewayFor(db);
  const operations = [
    ...wireNeoTodoMutations(
      createNeoTodoOperations(
        store,
        sessions,
        controls,
        () => packs,
        () => null
      ),
      {
        gateway,
        write: gateway.run.bind(gateway),
        packs: () => packs,
        artifact: () => null,
        stop: async () => null,
        advance: () => runner.advance(),
        changed: () => {},
        project: async (todos) => [...todos],
      }
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      controls,
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
    const op = operations.find((candidate) => candidate.name === name)!;
    return (await op.execute(op.inputSchema.parse(input), caller)) as {
      ok: boolean;
      reason?: string;
      todo: NeoTodo;
      todos: NeoTodo[];
    };
  };
  const step = (title: string, after?: (string | number)[]) => ({
    check: pendingTodoCheck,
    title,
    doneWhen: 'Result verified',
    ...(after ? { after } : {}),
  });
  return { db, store, invoke, step };
}

describe('todo dependencies', () => {
  test('a plan names which earlier steps each step waits for; unnamed steps keep the order', async () => {
    const { db, invoke, step } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Plan',
        request: 'Plan with a join',
        todos: [step('A'), step('B', []), step('C', [0, 1])],
      });
      expect(opened.ok).toBe(true);
      const [a, b, c] = opened.todos;
      expect(a.dependsOn).toBeNull();
      expect(b.dependsOn).toEqual([]);
      expect(c.dependsOn).toEqual([a.id, b.id]);
    } finally {
      db.close();
    }
  });

  test('missing, self and circular dependencies are refused', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Plan',
        request: 'Plan',
        todos: [step('A'), step('B', [0])],
      });
      const [a, b] = opened.todos;
      const askId = a.askId;
      expect(await invoke('neo.todo.add', { askId, ...step('C', ['no-such-todo']) })).toMatchObject(
        { ok: false, reason: expect.stringContaining('dependency_not_found') }
      );
      expect(await invoke('neo.todo.edit', { todoId: a.id, after: [a.id] })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('self_dependency'),
      });
      expect(await invoke('neo.todo.edit', { todoId: a.id, after: [b.id] })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('dependency_cycle'),
      });
      expect(store.getTodo(a.id)?.dependsOn).toBeNull();
      expect(await invoke('neo.todo.edit', { todoId: b.id, after: [] })).toMatchObject({
        ok: true,
      });
      expect(store.getTodo(b.id)?.dependsOn).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a bad reference anywhere in a plan refuses the whole plan before anything is saved', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Plan',
        request: 'Plan with a forward reference',
        todos: [step('A'), step('B', [2]), step('C')],
      });
      expect(opened).toMatchObject({ ok: false, reason: expect.stringContaining('dependency') });
      expect(store.listOpenAsks()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('start is refused for a step that still waits for unfinished steps', async () => {
    const { db, invoke, step } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Plan',
        request: 'Plan',
        todos: [step('A')],
      });
      const added = await invoke('neo.todo.add', {
        askId: opened.todos[0].askId,
        ...step('B', [opened.todos[0].id]),
        instruction: 'Do B.',
        target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } },
        start: true,
      });
      expect(added).toMatchObject({ ok: false, reason: expect.stringContaining('not_ready') });
    } finally {
      db.close();
    }
  });

  test('a repeated plan that changes what a recorded step waits for says to use edit', async () => {
    const { db, invoke, step } = setup();
    try {
      const plan = { title: 'Plan', request: 'Plan' };
      await invoke('neo.ask.open', { ...plan, todos: [step('A'), step('B')] });
      const again = (await invoke('neo.ask.open', {
        ...plan,
        todos: [step('A'), step('B', [])],
      })) as unknown as { records?: string[] };
      expect(again.records).toEqual([expect.stringContaining('neo.todo.edit')]);
    } finally {
      db.close();
    }
  });

  test('a repeated plan cannot start a recorded step that still waits for unfinished steps', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const plan = { title: 'Plan', request: 'Plan' };
      const work = {
        instruction: 'Do it.',
        target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } },
      };
      const opened = await invoke('neo.ask.open', {
        ...plan,
        todos: [
          { ...step('A'), ...work },
          { ...step('B'), ...work },
        ],
      });
      const again = await invoke('neo.ask.open', {
        ...plan,
        todos: [
          { ...step('A'), ...work },
          { ...step('B'), ...work, start: true },
        ],
      });
      expect(again).toMatchObject({ ok: false, reason: expect.stringContaining('not_ready') });
      expect(store.getTodo(opened.todos[1].id)?.state).toBe(opened.todos[1].state);
    } finally {
      db.close();
    }
  });

  test('a repeated plan may start a step whose index points at a recorded, finished step', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const plan = { title: 'Plan', request: 'Plan' };
      const opened = await invoke('neo.ask.open', { ...plan, todos: [step('A')] });
      store.updateTodo(opened.todos[0], { state: 'done', evidence: 'Done.' }, 5);
      const again = await invoke('neo.ask.open', {
        ...plan,
        todos: [
          step('A'),
          {
            ...step('B', [0]),
            instruction: 'Do B.',
            target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } },
            start: true,
          },
        ],
      });
      expect(again.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test('what a started todo waits for cannot change under its running worker', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Plan',
        request: 'Plan',
        todos: [step('A'), step('B', [])],
      });
      const [a, b] = opened.todos;
      store.updateTodo(b, { state: 'doing', startedAt: 5 }, 5);
      expect(await invoke('neo.todo.edit', { todoId: b.id, after: [a.id] })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('already_started'),
      });
      expect(store.getTodo(b.id)?.dependsOn).toEqual([]);
    } finally {
      db.close();
    }
  });
});
