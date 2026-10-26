import { describe, expect, test } from 'bun:test';
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
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
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
  const registry = createOperationRegistry([
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
    expect(reply.isError).not.toBe(true);
    return JSON.parse(reply.content[0].text);
  };
  return { db, store, sessions, ask, todo, runner, calls, call, audits };
}

describe('todo and ask bookkeeping records through MCP', () => {
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
