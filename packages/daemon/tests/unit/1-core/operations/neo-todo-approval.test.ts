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
  const sent: Record<string, unknown>[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => packs,
    tell: async () => {},
    changed: () => {},
    invoke: async (_caller, name, input) => {
      if (name === 'work.send') {
        sent.push(input);
        return {
          kind: 'completed',
          value: {
            ok: true,
            value: { delivered: true, receipt: { executionId: 'w', inputId: crypto.randomUUID() } },
          },
        };
      }
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: { ref: { adapter: 'hyperneo', id: 'w' }, status: 'done', lastActivityAt: 0 },
        },
      };
    },
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
  const target = { verb: 'send' as const, ref: { adapter: 'hyperneo', id: 'w' } };
  const work = { target, instruction: 'Perform the approved step.' };
  const seedLegacy = (todo: NeoTodo) => {
    store.updateTodo(todo, { state: 'blocked', blockedBy: 'question' }, Date.now());
    store.askQuestion(
      crypto.randomUUID(),
      todo.askId,
      {
        text: 'Start legacy step?',
        kind: 'start',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: [todo.id],
      },
      Date.now()
    );
  };
  return { db, store, sessions, invoke, step, runner, sent, target, work, seedLegacy };
}

const complete = (runner: ReturnType<typeof createNeoTodoRunner>, todo: NeoTodo) =>
  runner.recompute(todo, {}, Date.now(), { state: 'done', evidence: 'Completed.' });

const card = (store: NeoAskTodoRepository, todo: NeoTodo) =>
  store
    .listQuestions(store.getTodo(todo.id)!.askId)
    .find((q) => q.state === 'open' && q.startTodos?.includes(todo.id));

describe('todo approval', () => {
  test('one Start answer approves the whole chain and asks nothing more', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Chain',
        request: 'A, then B, then C.',
        todos: [
          { ...step('A', []), ...work },
          { ...step('B'), ...work },
          { ...step('C'), ...work },
        ],
      });
      const [a, b, c] = opened.todos;
      store.answerQuestion(card(store, a)!, [a.id, b.id, c.id], 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(c.id)?.approvedAt).not.toBeNull();
      expect(store.getTodo(a.id)?.state).toBe('doing');
      await complete(runner, store.getTodo(a.id)!);
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)?.state).toBe('doing');
      expect(store.getTodo(c.id)?.state).toBe('todo');
      await complete(runner, store.getTodo(b.id)!);
      await runner.refresh(() => {});
      expect(store.getTodo(c.id)?.state).toBe('doing');
      expect(store.listQuestions(a.askId).filter((q) => q.state === 'open')).toHaveLength(0);
      expect(sent).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test('start:true records approval and the queue runs the step once it is ready', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Approved plan',
        request: 'A, then B.',
        todos: [
          { ...step('A', []), ...work, start: true },
          { ...step('B'), ...work, start: true },
        ],
      });
      expect(opened).toMatchObject({ ok: true });
      const [a, b] = opened.todos;
      expect(card(store, b)).toBeUndefined();
      expect(store.getTodo(b.id)).toMatchObject({ state: 'todo', startedAt: null });
      await complete(runner, store.getTodo(a.id)!);
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)?.state).toBe('doing');
      expect(sent).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('another step having started never approves an unapproved step', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Partly approved',
        request: 'A now, B needs a yes.',
        todos: [
          { ...step('A', []), ...work, start: true },
          { ...step('B'), ...work },
        ],
      });
      const [a, b] = opened.todos;
      await complete(runner, store.getTodo(a.id)!);
      store.retireQuestion(card(store, b)!, 'Neo withdrew the card.', null, Date.now());
      await invoke('neo.todo.hold', { todoId: b.id, reason: null });
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)).toMatchObject({ approvedAt: null, startedAt: null });
      expect(card(store, b)).toBeDefined();
      expect(sent).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('edits never touch approval or take a step off its card', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Unapproved',
        request: 'Independent steps.',
        todos: [{ ...step('X', []) }, { ...step('A', []), ...work }, { ...step('B', []), ...work }],
      });
      const [x, a, b] = opened.todos;
      store.updateTodo(x, { state: 'done' }, Date.now());
      expect(await invoke('neo.todo.edit', { todoId: a.id, after: [x.id] })).toMatchObject({
        ok: true,
      });
      await runner.refresh(() => {});
      for (const todo of [a, b]) {
        expect(store.getTodo(todo.id)).toMatchObject({
          approvedAt: null,
          state: 'blocked',
          blockedBy: 'question',
        });
        expect(card(store, todo)).toBeDefined();
      }
      store.answerQuestion(card(store, b)!, [], 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)?.blockedBy).toBe('held');
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('a held step stays held through a Start answer that approves its ask', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Held',
        request: 'A now; the check waits for the human.',
        todos: [{ ...step('A', []), ...work }, step('Check only', [])],
      });
      const [a, check] = opened.todos;
      await invoke('neo.todo.hold', { todoId: check.id, reason: 'Human said wait.' });
      store.answerQuestion(card(store, a)!, [a.id], 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(check.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'held',
        blockedReason: 'Human said wait.',
      });
      expect(sent).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('every start path uses the gate', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Gate',
        request: 'B needs a yes.',
        todos: [{ ...step('B', []), ...work }, step('Check only', [])],
      });
      const [b, check] = opened.todos;
      expect(await runner.start(b.id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not_approved'),
      });
      expect(
        await invoke('neo.todo.bind', { todoId: b.id, ref: { adapter: 'hyperneo', id: 'other' } })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('not_approved') });
      store.updateTodo(store.getTodo(b.id)!, { state: 'failed', reason: 'Check failed.' }, 2);
      expect(
        await invoke('neo.todo.bind', { todoId: b.id, ref: { adapter: 'hyperneo', id: 'other' } })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('not_approved') });
      expect(
        await invoke('neo.todo.bind', {
          todoId: check.id,
          ref: { adapter: 'hyperneo', id: 'other' },
        })
      ).toMatchObject({ ok: true });
      expect(store.getTodo(b.id)?.startedAt).toBeNull();
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('an open question on the parent ask holds an approved child step', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Split',
        request: 'A here, B elsewhere.',
        todos: [step('A', []), { ...step('B', []), ...work }],
      });
      const [a, b] = opened.todos;
      const child = store.openAsk({
        ...store.getAsk(a.askId)!,
        id: 'historical-child',
        parentId: a.askId,
        repo: 'synthetic/second',
      });
      db.prepare('UPDATE neo_todos SET ask_id = ? WHERE id = ?').run(child.id, b.id);
      store.retireQuestions(a.askId, Date.now());
      store.joinStartQuestion(store.getTodo(a.id)!, Date.now());
      store.joinStartQuestion(store.getTodo(b.id)!, Date.now());
      const parent = crypto.randomUUID();
      store.askQuestion(
        parent,
        a.askId,
        {
          text: 'Which release?',
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
        },
        Date.now()
      );
      store.answerQuestion(card(store, b)!, [b.id], 'button', Date.now());
      expect(await runner.start(b.id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('question_open'),
      });
      await runner.refresh(() => {});
      expect(sent).toHaveLength(0);
      store.answerQuestion(store.getQuestion(parent)!, 'Next one', 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)?.state).toBe('doing');
    } finally {
      db.close();
    }
  });
});
