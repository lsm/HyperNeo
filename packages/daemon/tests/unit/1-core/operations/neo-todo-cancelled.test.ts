import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import { neoMoveTodo } from '../../../../src/lib/neo/todo-repo.ts';
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

describe('cancelled prerequisites', () => {
  test.each(['remove', 'replacement'])(
    'a selected candidate is checked again after prerequisite %s',
    async (mode) => {
      const { db, store, sessions, invoke, step, runner, sent, work } = setup();
      try {
        const {
          todos: [a, b, replacement],
        } = await invoke('neo.ask.open', {
          title: 'Claim cancellation',
          request: 'Finish A before B.',
          todos: [
            step('A', []),
            { ...step('B', [0]), ...work, start: true },
            step('Replacement', []),
          ],
        });
        store.updateTodo(a, { state: 'done' }, Date.now());
        const candidate = sessions.queueFacts().candidates.find((item) => item.id === b.id);
        expect(candidate).toBeDefined();
        expect(
          await invoke('neo.todo.remove', {
            todoId: a.id,
            reason: 'Cancelled before the claim.',
            ...(mode === 'replacement' ? { replacedBy: replacement.id } : {}),
          })
        ).toMatchObject({ ok: true });
        expect(await runner.start(candidate!.id)).toMatchObject({ ok: false });
        expect(store.getTodo(b.id)?.startedAt).toBeNull();
        expect(sent).toHaveLength(0);
        const card = store
          .listQuestions(b.askId)
          .find((q) => q.state === 'open' && q.startTodos?.includes(b.id))!;
        expect(card).toBeDefined();
        store.answerQuestion(card, [b.id], 'button', Date.now());
        await runner.advance();
        if (mode === 'replacement') {
          expect(store.getTodo(b.id)).toMatchObject({ state: 'todo', dependsOn: [replacement.id] });
          await complete(runner, replacement);
          await runner.refresh(() => {});
        }
        expect(store.getTodo(b.id)?.state).toBe('doing');
        await runner.advance();
        expect(sent).toHaveLength(1);
      } finally {
        db.close();
      }
    }
  );

  test.each([
    'explicit',
    'implicit',
    'approved',
    'approved-implicit',
    'middle',
    'middle-implicit',
    'replacement',
    'replacement-implicit',
    'cycle-replacement',
    'legacy-close',
    'decline',
    'held',
    'failed',
    'failed-after-cancel',
  ])('cancelled prerequisites need one human decision: %s', async (mode) => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Cancelled prerequisite',
        request: 'Complete A, B, then C.',
        todos: [
          { ...step('A', []), ...work, start: mode.startsWith('approved') },
          { ...step('B', mode.endsWith('implicit') ? undefined : [0]), ...work, start: true },
          { ...step('C', mode.endsWith('implicit') ? undefined : [1]), ...work, start: true },
          { ...step('Replacement', []), ...work, start: mode.startsWith('replacement') },
        ],
      });
      const [a, b, c, replacement] = opened.todos;
      if (mode.startsWith('approved')) await complete(runner, a);
      const middle = mode.startsWith('approved') || mode.startsWith('middle');
      const cancelled = middle ? b : a;
      const dependent = middle ? c : b;
      const before = sent.length;
      if (mode === 'failed')
        store.updateTodo(
          dependent,
          { state: 'failed', reason: 'Synthetic check failed.' },
          Date.now()
        );
      if (mode === 'held')
        await invoke('neo.todo.hold', { todoId: dependent.id, reason: 'Human said wait.' });
      if (mode === 'legacy-close')
        store.updateTodo(cancelled, { state: 'closed_unverified' }, Date.now());
      else
        expect(
          await invoke('neo.todo.remove', {
            todoId: cancelled.id,
            reason: 'Cancelled by the human.',
            ...(mode.startsWith('replacement')
              ? { replacedBy: replacement.id }
              : mode === 'cycle-replacement'
                ? { replacedBy: b.id }
                : {}),
          })
        ).toMatchObject({ ok: true });
      if (mode === 'failed-after-cancel')
        store.updateTodo(
          store.getTodo(dependent.id)!,
          { state: 'failed', reason: 'Synthetic check failed.' },
          Date.now()
        );
      if (mode.startsWith('failed')) {
        await runner.refresh(() => {});
        expect(store.getTodo(dependent.id)).toMatchObject({
          state: 'failed',
          reason: 'Synthetic check failed.',
        });
        expect(
          store
            .listQuestions(dependent.askId)
            .filter((q) => q.state === 'open' && q.startTodos?.includes(dependent.id))
        ).toHaveLength(0);
        expect(sent).toHaveLength(before);
        return;
      }
      if (mode === 'held') {
        expect(store.getTodo(dependent.id)).toMatchObject({
          blockedBy: 'held',
          blockedReason: 'Human said wait.',
        });
        expect(
          store
            .listQuestions(dependent.askId)
            .filter((q) => q.state === 'open' && q.startTodos?.includes(dependent.id))
        ).toHaveLength(0);
        expect(await invoke('neo.todo.hold', { todoId: dependent.id, reason: null })).toMatchObject(
          { ok: true }
        );
      }
      const initialCard = store
        .listQuestions(dependent.askId)
        .find((q) => q.state === 'open' && q.startTodos?.includes(dependent.id))?.id;
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      expect(sent).toHaveLength(before);
      expect(store.getTodo(dependent.id)?.state).not.toBe('doing');
      const cards = store
        .listQuestions(dependent.askId)
        .filter((q) => q.state === 'open' && q.startTodos?.includes(dependent.id));
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(initialCard!);
      expect(cards[0].text).toContain(cancelled.title);
      expect(cards[0].text).toContain('cancelled');
      if (mode.startsWith('replacement'))
        expect(cards[0].text).toContain(`replaced by "${replacement.title}"`);
      store.answerQuestion(
        cards[0],
        mode === 'decline' ? [] : [dependent.id],
        'button',
        Date.now()
      );
      await runner.refresh(() => {});
      if (mode === 'decline') {
        expect(store.getTodo(dependent.id)?.state).toBe('removed');
        expect(sent).toHaveLength(before);
        expect(
          store
            .listQuestions(c.askId)
            .filter((q) => q.state === 'open' && q.startTodos?.includes(c.id))
        ).toHaveLength(1);
        return;
      }
      if (mode.startsWith('replacement')) {
        expect(store.getTodo(dependent.id)).toMatchObject({
          state: 'todo',
          dependsOn: [replacement.id],
        });
        expect(sent).toHaveLength(before);
        await complete(runner, store.getTodo(replacement.id)!);
        await runner.refresh(() => {});
      }
      expect(store.getTodo(dependent.id)?.state).toBe('doing');
      expect(sent).toHaveLength(before + 1);
      if (dependent.id === b.id) {
        expect(store.getTodo(c.id)?.state).not.toBe('doing');
        await complete(runner, store.getTodo(b.id)!);
        expect(store.getTodo(c.id)?.state).toBe('doing');
      }
      await runner.refresh(() => {});
      expect(
        store
          .listQuestions(dependent.askId)
          .filter((q) => q.state === 'open' && q.startTodos?.includes(dependent.id))
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('answering a cancellation card makes no second card', async () => {
    const { db, store, invoke, step, runner, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'One card',
        request: 'A, then D and E.',
        todos: [
          step('A', []),
          { ...step('D', [0]), ...work, start: true },
          { ...step('E', [0]), ...work, start: true },
        ],
      });
      const [a, d, e] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      const answer = card(store, d)!;
      expect(answer.startTodos).toEqual([d.id, e.id]);
      const before = store.listQuestions(a.askId).length;
      store.answerQuestion(answer, [d.id], 'button', Date.now());
      expect(store.listQuestions(a.askId)).toHaveLength(before);
      await runner.refresh(() => {});
      expect(store.getTodo(e.id)?.state).toBe('removed');
      expect(store.getTodo(d.id)?.state).toBe('doing');
      expect(store.listQuestions(a.askId).filter((q) => q.state === 'open')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('approval follows a replaced replacement to the live step', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Replacement chain',
        request: 'A, then D; B and then C replace A.',
        todos: [
          step('A', []),
          { ...step('D', [0]), ...work, start: true },
          step('B', []),
          step('C', []),
        ],
      });
      const [a, d, b, c] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Replaced.', replacedBy: b.id });
      await invoke('neo.todo.remove', { todoId: b.id, reason: 'Replaced.', replacedBy: c.id });
      const answer = card(store, d)!;
      expect(answer.text).toContain('It will wait for "C"');
      store.answerQuestion(answer, [d.id], 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({ state: 'todo', dependsOn: [c.id] });
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('approval never waits on a replacement that waits for the dependent', async () => {
    const { db, store, invoke, step, runner, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Replacement cycle',
        request: 'A, then D; B replaces A.',
        todos: [
          step('A', []),
          { ...step('D', [0]), ...work, start: true },
          { ...step('B', []), ...work },
        ],
      });
      const [a, d, b] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Replaced.', replacedBy: b.id });
      expect(await invoke('neo.todo.edit', { todoId: b.id, after: [d.id] })).toMatchObject({
        ok: true,
      });
      store.answerQuestion(card(store, d)!, [d.id], 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({ state: 'doing', dependsOn: [] });
    } finally {
      db.close();
    }
  });

  test('approving a cancelled prerequisite keeps waiting on the other prerequisites', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Two prerequisites',
        request: 'Finish A and B before D.',
        todos: [
          step('A', []),
          { ...step('B', []), ...work, start: true },
          { ...step('D', [0, 1]), ...work, start: true },
        ],
      });
      const [a, b, d] = opened.todos;
      await runner.advance();
      expect(store.getTodo(b.id)?.state).toBe('doing');
      const before = sent.length;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      const card = store
        .listQuestions(d.askId)
        .find((q) => q.state === 'open' && q.startTodos?.includes(d.id))!;
      expect(card.text).toContain('"B"');
      expect(card.text).not.toContain('independently');
      store.answerQuestion(card, [d.id], 'button', Date.now());
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({ state: 'todo', dependsOn: [b.id] });
      expect(sent).toHaveLength(before);
      await complete(runner, store.getTodo(b.id)!);
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)?.state).toBe('doing');
      expect(sent).toHaveLength(before + 1);
    } finally {
      db.close();
    }
  });

  test.each([
    'after-finished',
    'after-empty',
    'after-drop-cancelled',
    'plan-repeat',
    'plan-repeat-start',
    'bind',
    'card-withdrawn',
    'card-replaced',
  ] as const)('only the human can clear a cancelled prerequisite: %s', async (mode) => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const plan = { title: 'Human gate', request: 'Finish A, B and X before D.' };
      const steps = (extra: object) => [
        step('A', []),
        step('B', []),
        step('X', []),
        { ...step('D', [0, 1]), ...work, start: true, ...extra },
      ];
      const opened = await invoke('neo.ask.open', { ...plan, todos: steps({}) });
      const [a, b, x, d] = opened.todos;
      store.updateTodo(x, { state: 'done' }, Date.now());
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      const card = () =>
        store
          .listQuestions(d.askId)
          .filter((q) => q.state === 'open' && q.startTodos?.includes(d.id));
      expect(card()).toHaveLength(1);
      const before = sent.length;
      if (mode === 'after-finished')
        expect(await invoke('neo.todo.edit', { todoId: d.id, after: [x.id] })).toMatchObject({
          ok: false,
          reason: expect.stringContaining('cancelled_dependency'),
        });
      if (mode === 'after-empty')
        expect(await invoke('neo.todo.edit', { todoId: d.id, after: [] })).toMatchObject({
          ok: false,
          reason: expect.stringContaining('cancelled_dependency'),
        });
      if (mode === 'after-drop-cancelled')
        expect(await invoke('neo.todo.edit', { todoId: d.id, after: [b.id] })).toMatchObject({
          ok: false,
          reason: expect.stringContaining('cancelled_dependency'),
        });
      if (mode === 'plan-repeat')
        await invoke('neo.ask.open', {
          ...plan,
          todos: [...steps({}).slice(0, 3), { ...step('D', [2]), ...work, start: true }],
        });
      if (mode === 'plan-repeat-start') await invoke('neo.ask.open', { ...plan, todos: steps({}) });
      if (mode === 'bind')
        expect(
          await invoke('neo.todo.bind', {
            todoId: d.id,
            ref: { adapter: 'hyperneo', id: 'other-worker' },
          })
        ).toMatchObject({ ok: false, reason: expect.stringContaining('cancelled_dependency') });
      if (mode === 'card-withdrawn')
        store.retireQuestion(card()[0], 'Neo withdrew the card.', null, Date.now());
      if (mode === 'card-replaced')
        store.replaceQuestion(
          card()[0],
          crypto.randomUUID(),
          {
            text: 'A different question.',
            kind: 'reply',
            options: null,
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
          },
          Date.now()
        );
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'question',
        dependsOn: [a.id, b.id],
      });
      expect(sent).toHaveLength(before);
      expect(card()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('moving a step to another repository keeps its cancelled prerequisite', async () => {
    const { db, store, invoke, step, sent, runner, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Moved step',
        request: 'Finish A before D.',
        todos: [step('A', []), { ...step('D'), ...work }],
      });
      const [a, d] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      neoMoveTodo(store, store.getTodo(d.id)!, 'synthetic/elsewhere');
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'question',
        dependsOn: [a.id],
      });
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
