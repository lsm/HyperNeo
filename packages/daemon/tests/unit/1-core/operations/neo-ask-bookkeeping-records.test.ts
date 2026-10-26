import { describe, expect, test } from 'bun:test';
import { pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
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

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
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
      runner,
      () => [],
      () => null
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      { ...runner, stop: async () => null },
      () => null,
      () => true,
      () => []
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
