import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
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
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => packs,
    tell: async () => {},
    changed: () => {},
    invoke: async () => ({ kind: 'completed', value: { ok: true, value: {} } }),
  });
  const controls = { ...runner, resolveTarget: existingTodoTarget };
  const operations = [
    ...createNeoTodoOperations(
      store,
      sessions,
      controls,
      () => packs,
      () => null
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
});
