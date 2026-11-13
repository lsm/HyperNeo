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

function setup(
  options: { running?: number; stop?: (todo: NeoTodo) => Promise<string | null> } = {}
) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const packs = createTodoCheckPacks(db);
  const sent: Record<string, unknown>[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: options.running ?? 99, perGroup: 99 }),
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
        userFolder: '/synthetic/user-folder',
        stop: options.stop ?? (async () => null),
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
  const step = (title: string, after: (string | number)[] = []) => ({
    check: pendingTodoCheck,
    title,
    doneWhen: 'Result verified',
    after,
  });
  const target = { verb: 'send' as const, ref: { adapter: 'hyperneo', id: 'w' } };
  const work = { target, instruction: 'Perform the step.' };
  const reply = (askId: string) =>
    store.askQuestion(
      crypto.randomUUID(),
      askId,
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
  const seedUnapproved = (todo: NeoTodo) => {
    store.updateTodo(
      todo,
      { state: 'blocked', blockedBy: 'question', approvedAt: null },
      Date.now()
    );
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
  return { db, store, sessions, invoke, step, runner, sent, target, work, reply, seedUnapproved };
}

const complete = (runner: ReturnType<typeof createNeoTodoRunner>, todo: NeoTodo) =>
  runner.recompute(todo, {}, Date.now(), { state: 'done', evidence: 'Completed.' });

const openCards = (store: NeoAskTodoRepository, askId: string) =>
  store.listQuestions(askId).filter((q) => q.state === 'open');

describe('todo automatic start', () => {
  test('an added chain starts step by step with no Start card', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Chain',
        request: 'A, then B, then C.',
        todos: [
          { ...step('A', []), ...work },
          { ...step('B', [0]), ...work },
          { ...step('C', [1]), ...work },
        ],
      });
      const [a, b, c] = opened.todos;
      expect(openCards(store, a.askId)).toEqual([]);
      expect(store.getTodo(a.id)?.state).toBe('doing');
      expect(store.getTodo(b.id)).toMatchObject({ state: 'todo', startedAt: null });
      await complete(runner, store.getTodo(a.id)!);
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)?.state).toBe('doing');
      expect(store.getTodo(c.id)?.state).toBe('todo');
      await complete(runner, store.getTodo(b.id)!);
      await runner.refresh(() => {});
      expect(store.getTodo(c.id)?.state).toBe('doing');
      expect(openCards(store, a.askId)).toEqual([]);
      expect(sent).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test('a todo added to a running ask starts with no Start card', async () => {
    const { db, store, invoke, step, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Running',
        request: 'A now, B later.',
        todos: [{ ...step('A', []), ...work }],
      });
      const added = await invoke('neo.todo.add', {
        askId: opened.todos[0].askId,
        ...step('B', []),
        ...work,
        target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w2' } },
      });
      expect(added).toMatchObject({ ok: true });
      expect(store.getTodo(added.todo.id)?.state).toBe('doing');
      expect(openCards(store, added.todo.askId)).toEqual([]);
      expect(sent).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('closing an unrelated card leaves a held todo held', async () => {
    const { db, store, invoke, step, runner, sent, work, reply } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Held',
        request: 'B waits for the human.',
        todos: [step('X', []), { ...step('B', [0]), ...work }],
      });
      const [x, b] = opened.todos;
      await invoke('neo.todo.hold', { todoId: b.id, reason: 'Human said wait.' });
      const unrelated = reply(x.askId);
      store.updateTodo(store.getTodo(x.id)!, { state: 'done' }, Date.now());
      store.answerQuestion(unrelated, 'The next one', 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'held',
        startedAt: null,
      });
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('closing an unrelated card leaves an unapproved todo held', async () => {
    const { db, store, invoke, step, runner, sent, work, reply, seedUnapproved } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Unapproved',
        request: 'B waits for its Start card.',
        todos: [step('X', []), { ...step('B', [0]), ...work }],
      });
      const [x, b] = opened.todos;
      seedUnapproved(b);
      const unrelated = reply(x.askId);
      store.updateTodo(store.getTodo(x.id)!, { state: 'done' }, Date.now());
      store.answerQuestion(unrelated, 'The next one', 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)).toMatchObject({ approvedAt: null, startedAt: null });
      expect(openCards(store, b.askId).map((q) => q.kind)).toEqual(['start']);
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('every start path refuses an unapproved todo', async () => {
    const { db, store, invoke, step, runner, sent, work, seedUnapproved } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Gate',
        request: 'B waits for its Start card.',
        todos: [step('X', []), { ...step('B', [0]), ...work }],
      });
      const [x, b] = opened.todos;
      seedUnapproved(b);
      store.updateTodo(store.getTodo(x.id)!, { state: 'done' }, Date.now());
      expect(await runner.start(b.id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not_approved'),
      });
      expect(
        await invoke('neo.todo.bind', { todoId: b.id, ref: { adapter: 'hyperneo', id: 'other' } })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('not_approved') });
      expect(store.getTodo(b.id)?.startedAt).toBeNull();
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('an open question on the parent ask holds a child step', async () => {
    const { db, store, invoke, step, runner, sent, work, reply } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Split',
        request: 'A here, B elsewhere.',
        todos: [step('A', []), { ...step('B', [0]), ...work }],
      });
      const [a, b] = opened.todos;
      const child = store.openAsk({
        ...store.getAsk(a.askId)!,
        id: 'historical-child',
        parentId: a.askId,
      });
      db.prepare('UPDATE neo_todos SET ask_id = ? WHERE id = ?').run(child.id, b.id);
      const parent = reply(a.askId);
      store.updateTodo(store.getTodo(a.id)!, { state: 'done' }, Date.now());
      expect(await runner.start(b.id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('question_open'),
      });
      await runner.refresh(() => {});
      expect(sent).toHaveLength(0);
      store.answerQuestion(parent, 'Next one', 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(b.id)?.state).toBe('doing');
    } finally {
      db.close();
    }
  });
  test('a fill that overlaps a stop admits nothing over the limit', async () => {
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { db, store, invoke, step, runner, sent, work } = setup({
      running: 1,
      stop: async () => {
        stopping.resolve();
        await release.promise;
        return null;
      },
    });
    let removing: Promise<unknown> | undefined;
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Limit',
        request: 'One at a time.',
        todos: [
          { ...step('A', []), ...work },
          {
            ...step('B', []),
            ...work,
            target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w2' } },
          },
        ],
      });
      const [a, b] = opened.todos;
      expect(store.getTodo(a.id)?.state).toBe('doing');
      expect(store.getTodo(b.id)?.state).toBe('todo');
      removing = invoke('neo.todo.remove', { todoId: a.id, reason: 'Not needed.' });
      await stopping.promise;
      await runner.fill();
      expect(store.getTodo(b.id)).toMatchObject({ state: 'todo', startedAt: null });
      expect(sent).toHaveLength(1);
      release.resolve();
      await removing;
      await runner.fill();
      expect(store.getTodo(a.id)?.state).toBe('removed');
      expect(store.getTodo(b.id)?.state).toBe('doing');
      expect(sent).toHaveLength(2);
    } finally {
      release.resolve();
      await removing;
      db.close();
    }
  });
});
