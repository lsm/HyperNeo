import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import { planNeoRemovedPrerequisiteAnswer } from '../../../../src/lib/neo/todo-removal.ts';
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
  const told: { todo: string; note: string; key?: string }[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => packs,
    tell: async (_ask, todo, note, key) => {
      told.push({ todo: todo.id, note, key });
    },
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
  const step = (title: string, after: (string | number)[] = []) => ({
    check: pendingTodoCheck,
    title,
    doneWhen: 'Result verified',
    after,
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
  return { db, store, sessions, invoke, step, runner, sent, told, target, work, seedLegacy };
}

const complete = (runner: ReturnType<typeof createNeoTodoRunner>, todo: NeoTodo) =>
  runner.recompute(todo, {}, Date.now(), { state: 'done', evidence: 'Completed.' });

const card = (store: NeoAskTodoRepository, todo: NeoTodo) =>
  store
    .listQuestions(store.getTodo(todo.id)!.askId)
    .find((q) => q.state === 'open' && q.startTodos?.includes(todo.id));

const asked = (store: NeoAskTodoRepository, todo: NeoTodo) =>
  store
    .listQuestions(store.getTodo(todo.id)!.askId)
    .find(
      (q) => q.state === 'open' && q.cause === 'removed_prerequisite' && q.todos.includes(todo.id)
    );

const decide = (
  store: NeoAskTodoRepository,
  todo: NeoTodo,
  answer: 'Continue' | 'Remove these'
) => {
  const card = asked(store, todo)!;
  const now = Date.now();
  const effects = planNeoRemovedPrerequisiteAnswer(
    card,
    store.listFamilyTodos(card.askId),
    [answer],
    now
  );
  return store.answerQuestion(card, [answer], 'button', now, undefined, undefined, effects);
};

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
        expect(card(store, b)).toBeUndefined();
        if (mode === 'replacement') {
          expect(asked(store, b)).toBeUndefined();
          expect(store.getTodo(b.id)).toMatchObject({ state: 'todo', dependsOn: [replacement.id] });
          await complete(runner, replacement);
        } else decide(store, b, 'Continue');
        await runner.refresh(() => {});
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
    'approved',
    'middle',
    'replacement',
    'cycle-replacement',
    'legacy-close',
    'decline',
    'held',
    'failed',
    'failed-after-cancel',
  ])('a cancelled prerequisite waits for one decision: %s', async (mode) => {
    const { db, store, invoke, step, runner, sent, told, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Cancelled prerequisite',
        request: 'Complete A, B, then C.',
        todos: [
          { ...step('A', []), ...work, start: mode.startsWith('approved') },
          { ...step('B', [0]), ...work, start: true },
          { ...step('C', [1]), ...work, start: true },
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
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      expect(sent).toHaveLength(before);
      expect(card(store, dependent)).toBeUndefined();
      const notes = told.filter((item) => item.todo === dependent.id);
      if (mode === 'legacy-close') {
        expect(store.getTodo(dependent.id)?.state).toBe('todo');
        expect(notes).toHaveLength(1);
        expect(notes[0].note).toContain(cancelled.title);
        expect(await invoke('neo.todo.proceed', { todoId: dependent.id })).toMatchObject({
          ok: true,
        });
      } else if (mode === 'replacement') {
        expect(notes).toHaveLength(0);
        expect(asked(store, dependent)).toBeUndefined();
        expect(store.getTodo(dependent.id)).toMatchObject({
          state: 'todo',
          dependsOn: [replacement.id],
        });
        await complete(runner, store.getTodo(replacement.id)!);
      } else {
        expect(notes.filter(({ note }) => note.includes('was cancelled'))).toEqual([]);
        expect(asked(store, dependent)).toMatchObject({
          kind: 'choice',
          options: ['Continue', 'Remove these'],
          todos: [dependent.id, cancelled.id],
        });
        expect(store.getTodo(dependent.id)).toMatchObject({
          state: 'blocked',
          blockedBy: 'question',
          dependsOn: [cancelled.id],
        });
        decide(store, dependent, mode === 'decline' ? 'Remove these' : 'Continue');
      }
      await runner.refresh(() => {});
      if (mode === 'decline') {
        expect(store.getTodo(dependent.id)?.state).toBe('removed');
        expect(store.getTodo(c.id)?.state).toBe('removed');
        expect(sent).toHaveLength(before);
        return;
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

  test('the card retires once nothing it asks about is left to decide', async () => {
    const { db, store, invoke, step, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Dead card',
        request: 'A, then B.',
        todos: [step('A', []), { ...step('B', [0]), ...work, start: true }],
      });
      const [a, b] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      const open = asked(store, b)!;
      expect(open).toBeDefined();
      await invoke('neo.todo.remove', { todoId: b.id, reason: 'Not needed any more.' });
      expect(store.getQuestion(open.id)).toMatchObject({
        state: 'retired',
        retiredReason: 'nothing left to decide',
      });
    } finally {
      db.close();
    }
  });

  test('an open legacy card still answers, and Neo is not told about it', async () => {
    const { db, store, invoke, step, runner, told, work, seedLegacy } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Legacy card',
        request: 'A, then D.',
        todos: [step('A', []), { ...step('D', [0]), ...work, start: true }],
      });
      const [a, d] = opened.todos;
      store.updateTodo(a, { state: 'removed' }, Date.now());
      seedLegacy(store.getTodo(d.id)!);
      await runner.refresh(() => {});
      expect(told.filter((item) => item.todo === d.id)).toHaveLength(0);
      const approval = store.getTodo(d.id)!.approvedAt;
      const question = card(store, d)!;
      store.answerQuestion(question, [d.id], 'button', Date.now());
      expect(store.getTodo(d.id)).toMatchObject({
        approvalQuestionId: question.id,
        approvedAt: approval,
      });
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)?.state).toBe('doing');
    } finally {
      db.close();
    }
  });

  test('Neo cannot approve a step the human has not approved', async () => {
    const { db, store, invoke, step, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Unapproved',
        request: 'A, then D.',
        todos: [step('A', []), { ...step('D', [0]), ...work }],
      });
      const [a, d] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      expect(await invoke('neo.todo.proceed', { todoId: d.id })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not_approved'),
      });
      expect(store.getTodo(d.id)?.approvedAt).toBeNull();
      expect(card(store, d)).toBeDefined();
    } finally {
      db.close();
    }
  });

  test('proceed is refused with no cancelled prerequisite', async () => {
    const { db, invoke, step, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Nothing cancelled',
        request: 'A, then D.',
        todos: [step('A', []), { ...step('D', [0]), ...work, start: true }],
      });
      expect(await invoke('neo.todo.proceed', { todoId: opened.todos[1].id })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('no_cancelled_prerequisite'),
      });
    } finally {
      db.close();
    }
  });

  test('a removed step cannot make an edit look like a cycle', async () => {
    const { db, invoke, step } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'No false cycle',
        request: 'T, R, then X.',
        todos: [step('T', []), step('R', [0]), step('X', [1])],
      });
      const [t, r, x] = opened.todos;
      await invoke('neo.todo.remove', { todoId: r.id, reason: 'Cancelled by the human.' });
      expect(await invoke('neo.todo.edit', { todoId: t.id, after: [x.id] })).toMatchObject({
        ok: true,
      });
    } finally {
      db.close();
    }
  });

  test.each([
    ['work', 'yes'],
    ['work', 'no'],
    ['check-only', 'yes'],
    ['check-only', 'no'],
  ] as const)('a check-blocked %s step still waits for the card: %s', async (kind, answer) => {
    const { db, store, invoke, step, runner, sent, told, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Check blocked',
        request: 'A, then D.',
        todos: [
          step('A', []),
          { ...step('D', [0]), ...(kind === 'work' ? work : {}), start: kind === 'work' },
        ],
      });
      const [a, d] = opened.todos;
      store.updateTodo(store.getTodo(d.id)!, { approvedAt: 1 }, 1);
      store.updateTodo(
        store.getTodo(d.id)!,
        { state: 'blocked', blockedBy: 'check', blockedReason: 'Check is not met.' },
        1
      );
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      await runner.refresh(() => {});
      expect(card(store, d)).toBeUndefined();
      expect(told.map((item) => item.todo)).not.toContain(d.id);
      expect(sent).toHaveLength(0);
      decide(store, d, answer === 'yes' ? 'Continue' : 'Remove these');
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      expect(card(store, d)).toBeUndefined();
      const after = store.getTodo(d.id)!;
      if (answer === 'no') expect(after.state).toBe('removed');
      else expect(after).toMatchObject({ state: 'blocked', blockedBy: 'check', dependsOn: [] });
    } finally {
      db.close();
    }
  });

  test('the edge follows a replaced replacement to the live step', async () => {
    const { db, store, invoke, step, runner, sent, told, work } = setup();
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
      await runner.refresh(() => {});
      expect(told.filter((item) => item.todo === d.id)).toEqual([]);
      expect(asked(store, d)).toBeUndefined();
      expect(store.getTodo(d.id)).toMatchObject({ state: 'todo', dependsOn: [c.id] });
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('a replacement that waits for the dependent does not take the edge', async () => {
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
      expect(await invoke('neo.todo.edit', { todoId: b.id, after: [d.id] })).toMatchObject({
        ok: true,
      });
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Replaced.', replacedBy: b.id });
      expect(store.getTodo(d.id)?.dependsOn).toEqual([a.id]);
      decide(store, d, 'Continue');
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({ state: 'doing', dependsOn: [] });
    } finally {
      db.close();
    }
  });

  test('Continue keeps waiting on the other prerequisites', async () => {
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
      decide(store, d, 'Continue');
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

  test('two removals before an answer leave one card, and Continue clears both', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Two removals',
        request: 'Finish A and B before D.',
        todos: [step('A', []), step('B', []), { ...step('D', [0, 1]), ...work, start: true }],
      });
      const [a, b, d] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      await invoke('neo.todo.remove', { todoId: b.id, reason: 'Cancelled by the human.' });
      const open = store
        .listQuestions(d.askId)
        .filter((q) => q.state === 'open' && q.cause === 'removed_prerequisite');
      expect(open).toHaveLength(1);
      expect(open[0].text).toBe(
        '"A", "B" were removed. Continue "D" without them, or remove this step too?'
      );
      decide(store, d, 'Continue');
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({ state: 'doing', dependsOn: [] });
      expect(sent).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('a dependent in a sibling ask sees the card, filed on the root ask', async () => {
    const { db, store, invoke, step } = setup();
    try {
      const root = (await invoke('neo.ask.open', {
        title: 'Root',
        request: 'Plan the work.',
      })) as unknown as {
        ask: { id: string; sessionId: string };
      };
      const child = (id: string) =>
        store.openAsk({
          id,
          parentId: root.ask.id,
          projectId: null,
          sessionId: root.ask.sessionId,
          originMessageId: null,
          title: id,
          request: 'Filed work',
          createdAt: Date.now(),
        });
      child('first');
      const second = child('second');
      const a = (await invoke('neo.todo.add', { askId: 'first', ...step('A', []) })).todo;
      const f = (await invoke('neo.todo.add', { askId: 'second', ...step('F', [a.id]) })).todo;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      const filed = store.gateQuestions(second).find((q) => q.cause === 'removed_prerequisite');
      expect(filed).toMatchObject({ askId: root.ask.id, state: 'open', todos: [f.id, a.id] });
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
  ] as const)('only the decision clears a cancelled prerequisite: %s', async (mode) => {
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
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'question',
        dependsOn: [a.id, b.id],
      });
      expect(sent).toHaveLength(before);
      expect(card(store, d)).toBeUndefined();
      expect(asked(store, d)).toBeDefined();
    } finally {
      db.close();
    }
  });

  test('work in another repository keeps its cancelled prerequisite', async () => {
    const { db, store, invoke, step, sent, runner, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Moved step',
        request: 'Finish A before D.',
        todos: [
          step('A', []),
          { ...step('D', [0]), ...work, named: { repository: 'synthetic/elsewhere' }, start: true },
        ],
      });
      const [a, d] = opened.todos;
      await invoke('neo.todo.remove', { todoId: a.id, reason: 'Cancelled by the human.' });
      await runner.refresh(() => {});
      expect(store.getTodo(d.id)).toMatchObject({ state: 'blocked', dependsOn: [a.id] });
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('unfinished prerequisites of a started step', () => {
  const started = async ({ invoke, runner, store, step, work }: ReturnType<typeof setup>) => {
    const opened = await invoke('neo.ask.open', {
      title: 'Reopened prerequisite',
      request: 'Finish A before J.',
      todos: [
        { ...step('A', []), ...work, start: true },
        { ...step('J', [0]), ...work, start: true },
      ],
    });
    const [a, j] = opened.todos;
    await runner.advance();
    await complete(runner, store.getTodo(a.id)!);
    await runner.refresh(() => {});
    expect(store.getTodo(j.id)?.state).toBe('doing');
    return { a, j };
  };

  test('continue and retry refuse while a prerequisite is reopened, then run', async () => {
    const context = setup();
    const { db, store, invoke, sent } = context;
    try {
      const { a, j } = await started(context);
      store.updateTodo(store.getTodo(a.id)!, { state: 'doing', finishedAt: null }, Date.now());
      const before = sent.length;
      const continued = await invoke('neo.todo.continue', { todoId: j.id, message: 'Next.' });
      expect(continued).toMatchObject({ ok: false, reason: expect.stringMatching(/^not_ready:/) });
      store.updateTodo(store.getTodo(j.id)!, { state: 'failed', reason: 'Lost.' }, Date.now());
      const retried = await invoke('neo.todo.retry', { todoId: j.id });
      expect(retried).toMatchObject({ ok: false, reason: expect.stringMatching(/^not_ready:/) });
      expect(store.getTodo(j.id)?.state).toBe('failed');
      expect(sent).toHaveLength(before);
      store.updateTodo(store.getTodo(a.id)!, { state: 'done' }, Date.now());
      expect((await invoke('neo.todo.retry', { todoId: j.id })).ok).toBe(true);
      expect(store.getTodo(j.id)?.state).toBe('doing');
      expect(sent).toHaveLength(before + 1);
    } finally {
      db.close();
    }
  });

  test('a cancelled prerequisite never strands a started step', async () => {
    const context = setup();
    const { db, store, invoke, sent } = context;
    try {
      const { a, j } = await started(context);
      store.updateTodo(store.getTodo(a.id)!, { state: 'removed' }, Date.now());
      const before = sent.length;
      expect((await invoke('neo.todo.continue', { todoId: j.id, message: 'Next.' })).ok).toBe(true);
      expect(sent).toHaveLength(before + 1);
    } finally {
      db.close();
    }
  });

  test('bind refuses while a prerequisite runs, then binds', async () => {
    const { db, store, invoke, runner, step, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Bind waits',
        request: 'Finish X before Y.',
        todos: [{ ...step('X', []), ...work, start: true }, step('Y', [0])],
      });
      const [x, y] = opened.todos;
      await runner.advance();
      const refused = await invoke('neo.todo.bind', { todoId: y.id, ref: work.target.ref });
      expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/^not_ready:/) });
      expect(store.getTodo(y.id)).toMatchObject({ state: 'todo', startedAt: null });
      await complete(runner, store.getTodo(x.id)!);
      expect((await invoke('neo.todo.bind', { todoId: y.id, ref: work.target.ref })).ok).toBe(true);
      expect(store.getTodo(y.id)?.state).toBe('doing');
    } finally {
      db.close();
    }
  });
});
