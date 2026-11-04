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

describe('todo dependencies', () => {
  test.each([false, true])(
    'editing a dependent to independent asks before dispatch; explicit=%s',
    async (explicit) => {
      const { db, store, invoke, step, runner, sent, work } = setup();
      try {
        const opened = await invoke('neo.ask.open', {
          title: 'Edit ordering',
          request: 'Complete this chain.',
          todos: [
            { ...step('First'), ...work, start: true },
            { ...step('Second', explicit ? [0] : undefined), ...work },
          ],
        });
        const [first, second] = opened.todos;
        expect((await invoke('neo.todo.edit', { todoId: second.id, after: [] })).ok).toBe(true);
        await runner.refresh(() => {});
        expect(store.getTodo(second.id)).toMatchObject({ state: 'blocked', blockedBy: 'question' });
        const card = store.listQuestions(second.askId).find((q) => q.state === 'open');
        expect(card?.startTodos).toEqual([second.id]);
        expect(sent).toHaveLength(1);
        await invoke('neo.todo.edit', { todoId: second.id, after: [] });
        expect(store.listQuestions(second.askId).filter((q) => q.state === 'open')).toHaveLength(1);
        store.answerQuestion(card!, [second.id], 'button', Date.now());
        await invoke('neo.todo.edit', { todoId: second.id, after: [] });
        await complete(runner, store.getTodo(first.id)!);
        expect(store.getTodo(second.id)?.state).toBe('doing');
        await runner.refresh(() => {});
        expect(sent).toHaveLength(2);
      } finally {
        db.close();
      }
    }
  );

  test.each(['parent', 'sibling', 'linked-parent', 'child'] as const)(
    'a split dependent respects the scope of a %s question',
    async (scope) => {
      const { db, store, invoke, step, runner, sent, work, seedLegacy } = setup();
      try {
        const opened = await invoke('neo.ask.open', {
          title: 'Parent decision scope',
          request: 'Complete both repositories after any applicable decision.',
          todos: [
            step('Root evidence', []),
            {
              ...step('First repo', []),
              ...work,
              named: { repository: 'synthetic/first' },
              start: true,
            },
            { ...step('Second repo', [1]), ...work, named: { repository: 'synthetic/second' } },
          ],
        });
        expect(opened.ok).toBe(true);
        const [root, first, second] = opened.todos;
        const question = store.askQuestion(
          'scope-question',
          scope === 'child' ? second.askId : scope === 'sibling' ? first.askId : root.askId,
          {
            text: 'Review before continuing?',
            kind: 'reply',
            options: null,
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
            ...(scope === 'linked-parent' ? { todoId: root.id } : {}),
          },
          Date.now()
        );
        seedLegacy(second);
        db.prepare("UPDATE neo_todos SET state = 'done', finished_at = ? WHERE id = ?").run(
          Date.now(),
          first.id
        );
        await runner.refresh(() => {});
        if (scope === 'parent' || scope === 'child') {
          expect(store.getTodo(second.id)?.state).not.toBe('doing');
          expect(sent).toHaveLength(1);
          store.answerQuestion(question, 'Continue.', 'chat', Date.now());
          await runner.refresh(() => {});
        }
        expect(store.getTodo(second.id)?.state).toBe('doing');
        await runner.refresh(() => {});
        expect(sent).toHaveLength(2);
      } finally {
        db.close();
      }
    }
  );

  test.each(['explicit', 'implicit', 'approved', 'middle', 'replacement', 'close', 'decline'])(
    'cancelled prerequisites need one human decision: %s',
    async (mode) => {
      const { db, store, invoke, step, runner, sent, work } = setup();
      try {
        const opened = await invoke('neo.ask.open', {
          title: 'Cancelled prerequisite',
          request: 'Complete A, B, then C.',
          todos: [
            { ...step('A', []), ...work, start: mode === 'approved' },
            { ...step('B', mode === 'implicit' ? undefined : [0]), ...work },
            { ...step('C', mode === 'implicit' ? undefined : [1]), ...work },
            { ...step('Replacement', []), ...work },
          ],
        });
        const [a, b, c, replacement] = opened.todos;
        if (mode === 'approved') await complete(runner, a);
        const cancelled = ['approved', 'middle'].includes(mode) ? b : a;
        const dependent = ['approved', 'middle'].includes(mode) ? c : b;
        const before = sent.length;
        expect(
          await invoke(mode === 'close' ? 'neo.todo.close' : 'neo.todo.remove', {
            todoId: cancelled.id,
            reason: 'Cancelled by the human.',
            ...(mode === 'replacement' ? { replacedBy: replacement.id } : {}),
          })
        ).toMatchObject({ ok: true });
        await runner.refresh(() => {});
        await runner.refresh(() => {});
        expect(sent).toHaveLength(before);
        expect(store.getTodo(dependent.id)?.state).not.toBe('doing');
        const cards = store
          .listQuestions(dependent.askId)
          .filter((q) => q.state === 'open' && q.startTodos?.includes(dependent.id));
        if (mode === 'replacement') {
          expect(cards).toHaveLength(0);
          await complete(runner, replacement);
        } else {
          expect(cards).toHaveLength(1);
          expect(cards[0].text).toContain(cancelled.title);
          expect(cards[0].text).toContain('cancelled');
          store.answerQuestion(
            cards[0],
            mode === 'decline' ? [] : [dependent.id],
            'button',
            Date.now()
          );
          await runner.refresh(() => {});
          expect(store.getTodo(dependent.id)).toMatchObject(
            mode === 'decline' ? { state: 'removed' } : { dependsOn: [], state: 'doing' }
          );
          if (mode === 'decline') {
            expect(sent).toHaveLength(before);
            expect(
              store
                .listQuestions(c.askId)
                .filter((q) => q.state === 'open' && q.startTodos?.includes(c.id))
            ).toHaveLength(1);
            return;
          }
        }
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
    }
  );

  const chainModes = [
    'approved',
    'legacy',
    'unstarted',
    'split',
    'split-legacy',
    'extend-legacy',
    'completed-legacy',
  ];
  test.each(chainModes)(
    'authorized dependency chain advances without extra Start cards; root=%s',
    async (mode) => {
      const { db, store, sessions, invoke, step, runner, sent, target, work, seedLegacy } = setup();
      try {
        const repo = (name: string) =>
          mode.startsWith('split') ? { named: { repository: `synthetic/${name}` } } : {};
        const opened = await invoke('neo.ask.open', {
          title: 'Approved chain',
          request: 'Complete all three steps.',
          todos: [
            { ...step('PR1'), ...work, ...repo('first'), start: mode !== 'unstarted' },
            { ...step('PR2', [0]), ...work, ...repo('second') },
            { ...step('PR3', [1]), ...work, ...repo('second') },
          ],
        });
        expect(opened.ok).toBe(true);
        const [first, second, third] = opened.todos;
        expect(first.askId !== second.askId).toBe(mode.startsWith('split'));
        if (mode.startsWith('split')) expect(store.listQuestions(second.askId)).toHaveLength(0);
        if (mode === 'completed-legacy')
          db.prepare(
            "UPDATE neo_todos SET state = CASE WHEN id = ? THEN 'done' ELSE state END, check_json = NULL"
          ).run(first.id);
        if (mode.includes('legacy')) seedLegacy(second);
        else expect(store.listQuestions(first.askId)).toHaveLength(mode === 'unstarted' ? 1 : 0);
        if (mode === 'extend-legacy')
          await invoke('neo.todo.add', { askId: first.askId, ...step('Independent', []), ...work });
        if (mode !== 'completed-legacy') await complete(runner, store.getTodo(first.id)!);
        await (mode === 'completed-legacy' ? runner.refresh(() => {}) : runner.advance());
        expect(store.getTodo(second.id)?.state).toBe('doing');
        expect(store.getTodo(third.id)?.state).toBe('todo');
        expect(sessions.readRef(second.id)).toEqual(target.ref);
        expect(
          store
            .listQuestions(first.askId)
            .filter((q) => q.state !== 'retired')
            .map((q) => q.state)
        ).toEqual(mode === 'extend-legacy' ? ['open'] : []);
        await complete(runner, store.getTodo(second.id)!);
        await runner.refresh(() => {});
        expect(store.getTodo(third.id)?.state).toBe('doing');
        expect(sessions.readRef(third.id)).toEqual(target.ref);
        expect(sent).toHaveLength(mode === 'unstarted' ? 2 : 3);
        await runner.refresh(() => {});
        expect(sent).toHaveLength(mode === 'unstarted' ? 2 : 3);
      } finally {
        db.close();
      }
    }
  );

  test('an independent unapproved todo still asks and an explicit hold still stops a dependency', async () => {
    const { db, store, invoke, step, runner, sent, work } = setup();
    try {
      const opened = await invoke('neo.ask.open', {
        title: 'Unapproved',
        request: 'Consider work.',
        todos: [{ ...step('Independent', []), ...work, start: false }],
      });
      expect(store.listQuestions(opened.todos[0].askId)).toEqual([
        expect.objectContaining({ kind: 'start', state: 'open', startTodos: [opened.todos[0].id] }),
      ]);
      const added = await invoke('neo.todo.add', {
        askId: opened.todos[0].askId,
        ...step('Held dependency', [opened.todos[0].id]),
        ...work,
      });
      expect(added.ok).toBe(true);
      await invoke('neo.todo.hold', { todoId: added.todo.id, reason: 'Human said wait.' });
      await complete(runner, opened.todos[0]);
      await runner.refresh(() => {});
      expect(store.getTodo(added.todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'held' });
      expect(sent).toHaveLength(0);
    } finally {
      db.close();
    }
  });

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

  test('the queue keeps a step waiting on a failed step in a settled card', () => {
    const { db, store, sessions } = setup();
    try {
      const ask = (id: string, parentId: string | null) =>
        store.openAsk({
          id,
          projectId: null,
          goalId: null,
          sessionId: caller.sessionId!,
          originMessageId: `${id}-origin`,
          title: id,
          request: id,
          createdAt: 1,
          parentId,
          repo: parentId ? 'synthetic/child' : null,
        });
      const draft = (title: string, dependsOn?: string[]) => ({
        title,
        doneWhen: 'Result verified',
        check: null,
        instruction: `Do ${title}.`,
        named: null,
        ...(dependsOn ? { dependsOn } : {}),
      });
      ask('parent', null);
      ask('child', 'parent');
      const first = store.addTodo('first', 'parent', draft('A'), 2);
      store.updateTodo(first, { state: 'done', evidence: 'Done.', startedAt: 3, finishedAt: 4 }, 4);
      const failed = store.addTodo('child-step', 'child', draft('X'), 2, 'synthetic/child');
      store.updateTodo(failed, { state: 'failed', reason: 'Worker failed.' }, 5);
      store.settleAsk(store.getAsk('child')!, 'done', 'Done.', 6);
      const waiting = store.addTodo('waiting', 'parent', draft('B', [failed.id]), 7);
      sessions.create(waiting.id, { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } });
      expect(sessions.queueFacts().candidates.map((item) => item.id)).not.toContain(waiting.id);
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
