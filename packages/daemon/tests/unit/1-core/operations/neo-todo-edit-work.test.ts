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
  const told: string[] = [];
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
    tell: async (_ask, _todo, note) => void told.push(note),
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
        resolveTarget: existingTodoTarget,
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
  return { db, store, sessions, runner, told, invoke, step };
}

const work = {
  instruction: 'Do B.',
  target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } },
};

async function approvedPlan() {
  const world = setup();
  const opened = await world.invoke('neo.ask.open', {
    title: 'Plan',
    request: 'Plan',
    todos: [world.step('A'), world.step('B')],
  });
  const [first, second] = opened.todos;
  world.store.updateTodo(
    first,
    { state: 'done', evidence: 'Done.', startedAt: 3, finishedAt: 4 },
    4
  );
  world.store.retireQuestions(first.askId, 5);
  return { ...world, first, second };
}

describe('todos given work later', () => {
  test('an approved step with nothing to run it is told to Neo once', async () => {
    const { db, sessions, runner, told, second } = await approvedPlan();
    try {
      expect(sessions.queueFacts().unworked).toEqual([second.id]);
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      expect(told.filter((note) => note.includes('nothing runs it'))).toEqual([
        expect.stringContaining(second.id),
      ]);
    } finally {
      db.close();
    }
  });

  test('edit gives a waiting step its work and the queue picks it up', async () => {
    const { db, store, sessions, invoke, second } = await approvedPlan();
    try {
      const edited = await invoke('neo.todo.edit', { todoId: second.id, ...work });
      expect(edited.ok).toBe(true);
      expect(store.getTodo(second.id)?.instruction).toBe('Do B.');
      expect(sessions.get(second.id)?.verb).toBe('send');
      expect(sessions.queueFacts().unworked).toEqual([]);
      expect(store.getTodo(second.id)?.startedAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test('work needs both parts and only goes to a step that has none and has not started', async () => {
    const { db, invoke, first, second } = await approvedPlan();
    try {
      expect(
        await invoke('neo.todo.edit', { todoId: second.id, instruction: 'Do B.' })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('work_incomplete') });
      expect(await invoke('neo.todo.edit', { todoId: first.id, ...work })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('has_work'),
      });
      await invoke('neo.todo.edit', { todoId: second.id, ...work });
      expect(await invoke('neo.todo.edit', { todoId: second.id, ...work })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('has_work'),
      });
    } finally {
      db.close();
    }
  });

  test('coding work with a start target but no place is refused when added or edited', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const ask = store.openAsk({
        id: 'coding-ask',
        projectId: null,
        goalId: null,
        sessionId: caller.sessionId!,
        originMessageId: 'coding-origin',
        title: 'Coding',
        request: 'Coding',
        createdAt: 1,
        repo: 'synthetic/repo',
      });
      const placeless = {
        instruction: 'Do it.',
        target: { verb: 'start', adapter: 'hyperneo' },
      };
      expect(
        await invoke('neo.todo.add', { askId: ask.id, ...step('New'), ...placeless })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('place_required') });
      const waiting = store.addTodo(
        'waiting',
        ask.id,
        {
          title: 'Waiting',
          doneWhen: 'Result verified',
          check: null,
          instruction: null,
          named: null,
        },
        2,
        'synthetic/repo'
      );
      expect(await invoke('neo.todo.edit', { todoId: waiting.id, ...placeless })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('place_required'),
      });
    } finally {
      db.close();
    }
  });
});
