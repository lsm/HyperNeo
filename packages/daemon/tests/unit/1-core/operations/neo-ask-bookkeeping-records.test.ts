import { createTodoCheckPacks, existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { describe, expect, test } from 'bun:test';
import { pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import {
  type NeoTodoControls,
  createNeoTodoOperations,
} from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import {
  createNeoWorkerQuestionWriter,
  createNeoQuestionOperations,
} from '../../../../src/lib/neo/question-operations.ts';
import {
  createOperationRegistry,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';

function setup(overrides: Partial<Pick<NeoTodoControls, 'resolveTarget' | 'start'>> = {}) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db),
    sessions = new NeoTodoSessionRepository(db);
  const ask = store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Synthetic',
    request: 'Synthetic',
    createdAt: 1,
  });
  const todo = store.addTodo(
    'todo',
    ask.id,
    {
      title: 'Synthetic task',
      doneWhen: 'Result observed',
      instruction: 'Work',
      check: null,
      named: null,
    },
    1
  );
  const calls: string[] = [];
  const runner = createNeoTodoRunner({
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    packs: () => [],
    invoke: async (_caller, name) => {
      calls.push(name);
      throw new Error('Unexpected worker call');
    },
    tell: async () => {},
    changed: () => {},
  });
  const registry: OperationRegistry = createOperationRegistry([
    ...createDiscoveryOperations(() => registry),
    ...createNeoTodoOperations(
      store,
      sessions,
      { ...runner, resolveTarget: existingTodoTarget },
      () => [],
      () => null
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      { ...runner, resolveTarget: existingTodoTarget, stop: async () => null, ...overrides },
      () => null,
      () => true,
      () => [],
      () => createTodoCheckPacks(db),
      undefined,
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
    ),
    ...createNeoQuestionOperations(
      store,
      async () => {},
      async () => {
        calls.push('start');
        return { ok: true };
      }
    ),
  ]);
  const audits: unknown[] = [];
  const handler = createOperationMcpHandler(
    registry,
    () => ({ sessionId: 'neo', role: 'neo' }),
    (entry) => {
      audits.push(entry);
    }
  );
  const call = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    if (reply.isError) throw new Error(reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  };
  return { db, store, sessions, ask, todo, runner, calls, call, audits };
}

describe('todo and ask bookkeeping records through MCP', () => {
  test.each(['open', 'done'] as const)(
    'reopening a %s ask does not revalidate an already-recorded worker',
    async (state) => {
      let gone = false;
      const h = setup({
        resolveTarget: async (ref) =>
          gone
            ? { reason: { ok: false as const, reason: 'target_not_found: removed worker' } }
            : { value: ref },
      });
      try {
        const input = {
          title: 'Recorded worker',
          request: 'Track existing work',
          todos: [
            {
              title: 'Worker task',
              check: pendingTodoCheck,
              instruction: 'Work',
              target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'synthetic-worker' } },
            },
          ],
        };
        const first = await h.call('neo.ask.open', input);
        expect(first.ok).toBe(true);
        if (state === 'done') {
          h.store.openAsk({
            id: 'recorded-child',
            parentId: first.ask.id,
            repo: 'github.com/synthetic/child',
            projectId: null,
            sessionId: first.ask.sessionId,
            originMessageId: null,
            title: 'Child',
            request: 'Filed work',
            createdAt: 1,
          });
          h.store.settleAsk(first.ask, 'done', 'Finished', 2);
        }
        const before = h.store.listTodos(first.ask.id);
        gone = true;
        const again = await h.call('neo.ask.open', input);
        expect(again).toMatchObject({
          ok: true,
          ask: { id: first.ask.id, status: state },
          todos: [{ id: first.todos[0].id }],
        });
        expect(h.store.listTodos(first.ask.id)).toEqual(before);
        expect(h.calls).toEqual([]);
      } finally {
        h.db.close();
      }
    }
  );

  test('a settled ask returns its bookkeeping receipt before resolving a new homeless target', async () => {
    const h = setup({
      resolveTarget: async () => ({
        reason: { ok: false, reason: 'target_not_found: removed worker' },
      }),
    });
    try {
      h.store.openAsk({
        id: 'settled-child',
        parentId: h.ask.id,
        repo: 'github.com/synthetic/child',
        projectId: null,
        sessionId: h.ask.sessionId,
        originMessageId: null,
        title: 'Child',
        request: 'Filed work',
        createdAt: 1,
      });
      h.store.settleAsk(h.ask, 'done', 'Finished', 2);
      const before = h.store.listTodos(h.ask.id);
      const reply = await h.call('neo.ask.open', {
        title: h.ask.title,
        request: 'Track work',
        todos: [
          {
            title: 'New task',
            check: pendingTodoCheck,
            instruction: 'Work',
            target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'missing' } },
          },
        ],
      });
      expect(reply).toMatchObject({
        ok: true,
        ask: { id: h.ask.id },
        records: [expect.stringContaining('ask_settled:')],
      });
      expect(h.store.listTodos(h.ask.id)).toEqual(before);
      expect(h.calls).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test.each([0, 1])(
    'an unknown target at batch position %s refuses the whole ask before writes or dispatch',
    async (position) => {
      const starts: string[] = [];
      const h = setup({
        resolveTarget: async (ref) =>
          ref.id === 'missing'
            ? { reason: { ok: false as const, reason: 'target_not_found: missing' } }
            : { value: { ...ref, id: '10000000-0000-4000-8000-000000000001' } },
        start: async (id) => {
          starts.push(id);
          return { ok: true as const, todo: h.store.getTodo(id)! };
        },
      });
      try {
        const before = h.store.listAsks(null, 100);
        const todos = ['10000000', 'missing'].map((id, index) => ({
          title: `Batch item ${index}`,
          check: pendingTodoCheck,
          instruction: 'Work',
          target: { verb: 'send', ref: { adapter: 'hyperneo', id } },
          start: true,
        }));
        if (position === 0) todos.reverse();
        const result = await h.call('neo.ask.open', {
          title: 'Invalid target batch',
          request: 'Track batch',
          todos,
        });
        expect(result).toEqual({ ok: false, reason: 'target_not_found: missing' });
        expect(h.store.listAsks(null, 100)).toEqual(before);
        expect(starts).toEqual([]);
        expect(h.calls).toEqual([]);
      } finally {
        h.db.close();
      }
    }
  );

  test('ask.open stores the pre-resolved canonical references for every target', async () => {
    const lookups: string[] = [];
    const h = setup({
      resolveTarget: async (ref) => {
        lookups.push(ref.id);
        return {
          value: {
            ...ref,
            id: `10000000-0000-4000-8000-00000000000${ref.id === 'short-a' ? 1 : 2}`,
          },
        };
      },
    });
    try {
      const result = await h.call('neo.ask.open', {
        title: 'Canonical target batch',
        request: 'Track batch',
        todos: ['short-a', 'short-b'].map((id) => ({
          title: id,
          check: pendingTodoCheck,
          target: { verb: 'bind', ref: { adapter: 'hyperneo', id } },
        })),
      });
      expect(result.ok).toBe(true);
      expect(lookups).toEqual(['short-a', 'short-b']);
      expect(
        result.todos.map((todo: { id: string }) => h.sessions.readRef(todo.id)?.id).sort()
      ).toEqual(['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']);
      expect(h.calls).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('settlement preserves failure diagnostics in the unverified todo receipt', async () => {
    const h = setup();
    try {
      h.store.updateTodo(h.todo, { state: 'failed', reason: 'check_failed: build exited 7' }, 2);
      const result = await h.call('neo.ask.settle', {
        askId: h.ask.id,
        status: 'done',
        outcome: 'Closed without a verified outcome',
      });
      expect(result.todos[0].reason).toContain('Ask closed without verifying: Result observed');
      expect(result.todos[0].reason).toContain('check_failed: build exited 7');
      expect(result).toMatchObject({ ok: true, todos: [{ state: 'closed_unverified' }] });
      expect(h.calls).toEqual([]);
    } finally {
      h.db.close();
    }
  });
  test('the agent-visible question description explains stale todo references', async () => {
    const h = setup();
    try {
      const described = await h.call('operations.describe', { name: 'neo.question.ask' });
      expect(described).toMatchObject({ found: true });
      expect(described.description).toContain(
        'If a supplied todoId is unknown, belongs to another ask, or is done, closed unverified or removed'
      );
      expect(described.description).toContain(
        'return a todo_closed record and open the question on the ask without linking that todo'
      );
    } finally {
      h.db.close();
    }
  });
  test('a settled-ask retry records the different-title remedy without adding work', async () => {
    const h = setup();
    try {
      h.store.openAsk({
        id: 'child',
        parentId: h.ask.id,
        repo: 'github.com/synthetic/child',
        projectId: null,
        sessionId: h.ask.sessionId,
        originMessageId: null,
        title: 'Child card',
        request: 'Filed work',
        createdAt: 1,
      });
      h.store.settleAsk(h.ask, 'done', 'Finished request', 2);
      const before = h.store.listTodos(h.ask.id);
      const result = await h.call('neo.ask.open', {
        title: h.ask.title,
        request: 'Follow-up',
        todos: [{ title: 'New task', check: pendingTodoCheck }],
      });
      expect(result).toMatchObject({
        ok: true,
        ask: { id: h.ask.id, status: 'done' },
        records: [expect.stringContaining('Open a new ask for it with a different title')],
      });
      expect(h.store.listTodos(h.ask.id)).toEqual(before);
      expect(h.calls).toEqual([]);
    } finally {
      h.db.close();
    }
  });
  test('settling unfinished todos records them and preserves their visible unverified status', async () => {
    const h = setup();
    try {
      expect(
        await h.call('neo.ask.settle', {
          askId: h.ask.id,
          status: 'done',
          outcome: 'Closed by Neo',
        })
      ).toMatchObject({
        ok: true,
        records: [expect.stringContaining('todos_unfinished:')],
        todos: [{ state: 'closed_unverified' }],
      });
      expect(h.store.getTodo(h.todo.id)).toMatchObject({
        state: 'closed_unverified',
        reason: expect.stringContaining('Result observed'),
      });
    } finally {
      h.db.close();
    }
  });
  test('settlement closes a needs-human todo unverified without answering its worker card', async () => {
    const h = setup();
    try {
      const ref = { adapter: 'hyperneo', id: 'worker' };
      h.sessions.create(h.todo.id, { verb: 'send', ref });
      h.sessions.recordRef(h.todo.id, ref, 2);
      h.store.updateTodo(h.todo, { state: 'doing', startedAt: 2 }, 2);
      const writer = createNeoWorkerQuestionWriter(
        h.store,
        h.sessions,
        () => 'en',
        async () => ({
          ...ref,
          name: 'Worker',
          label: 'HyperNeo · Worker',
          provider: 'HyperNeo',
          link: null,
        })
      );
      const question = await writer(ref, {
        todoId: h.todo.id,
        kind: 'question',
        title: 'Which target?',
        options: ['First', 'Second'],
        language: 'en',
        report: 'A human decision is required.',
      });
      expect(question).toMatchObject({
        ok: true,
        question: { state: 'open', answer: null, answeredBy: null },
      });
      expect(h.store.getTodo(h.todo.id)).toMatchObject({
        state: 'blocked',
        blockedBy: 'needs-human',
      });
      const result = await h.call('neo.ask.settle', {
        askId: h.ask.id,
        status: 'done',
        outcome: 'Closed without a verified outcome',
      });
      expect(result).toMatchObject({
        ok: true,
        records: [expect.stringContaining('todos_unfinished:')],
        todos: [{ state: 'closed_unverified', blockedBy: null }],
      });
      expect(h.store.getTodo(h.todo.id)).toMatchObject({
        state: 'closed_unverified',
        reason: expect.stringContaining('Result observed'),
      });
      expect(h.store.listQuestions(h.ask.id)).toMatchObject([
        { state: 'retired', answer: null, answeredBy: null },
      ]);
      expect(h.calls).toEqual([]);
    } finally {
      h.db.close();
    }
  });
  test.each(['done', 'closed_unverified', 'removed'] as const)(
    'a question about a %s todo opens at ask level with a record',
    async (state) => {
      const h = setup();
      try {
        h.store.updateTodo(h.todo, { state }, 2);
        const result = await h.call('neo.question.ask', {
          askId: h.ask.id,
          todoId: h.todo.id,
          kind: 'reply',
          text: 'What should happen next?',
        });
        expect(result).toMatchObject({
          ok: true,
          records: [expect.stringContaining('todo_closed:')],
          question: { state: 'open' },
        });
        expect(result.question.todoId ?? null).toBeNull();
        expect(h.calls).toEqual([]);
      } finally {
        h.db.close();
      }
    }
  );
});
