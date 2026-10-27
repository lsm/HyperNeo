import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';

function setup() {
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
  const registry = createOperationRegistry([
    ...createNeoTodoOperations(
      store,
      sessions,
      { ...runner, resolveTarget: existingTodoTarget },
      () => createTodoCheckPacks(db),
      () => null
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      { ...runner, stop: async () => null },
      () => null,
      () => true,
      () => [],
      undefined,
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
    expect(reply.isError).not.toBe(true);
    return JSON.parse(reply.content[0].text);
  };
  return { db, store, sessions, ask, todo, runner, calls, call, audits };
}

describe('todo and ask bookkeeping records through MCP', () => {
  test.each(['neo.todo.retry', 'neo.todo.continue'])(
    '%s on unstarted work records without dispatch or start-card approval',
    async (name) => {
      const h = setup();
      try {
        h.store.joinStartQuestion(h.todo, 2);
        const before = h.store.getTodo(h.todo.id),
          questions = h.store.listQuestions(h.ask.id);
        expect(await h.call(name, { todoId: h.todo.id, message: 'Continue' })).toMatchObject({
          ok: true,
          records: [expect.stringMatching(/^(not_started|not_retryable):/)],
        });
        expect(h.store.getTodo(h.todo.id)).toEqual(before);
        expect(h.store.listQuestions(h.ask.id)).toEqual(questions);
        expect(h.calls).toEqual([]);
        expect(h.audits).toMatchObject([{ accepted: true }]);
      } finally {
        h.db.close();
      }
    }
  );
  test.each([
    'neo.todo.add',
    'neo.todo.edit',
    'neo.todo.continue',
    'neo.todo.retry',
    'neo.todo.close',
    'neo.todo.remove',
    'neo.todo.bind',
  ])('%s on a settled ask records without mutation', async (name) => {
    const h = setup();
    try {
      h.store.settleAsk(h.ask, 'dropped', 'Human dropped it', 2);
      const before = h.store.listTodos(h.ask.id);
      expect(
        await h.call(name, {
          check: pendingTodoCheck,
          askId: h.ask.id,
          todoId: h.todo.id,
          title: 'Extra',
          doneWhen: 'Checked',
          message: 'Continue',
          reason: 'Recorded',
          ref: { adapter: 'hyperneo', id: 'worker' },
        })
      ).toMatchObject({ ok: true, records: [expect.stringContaining('ask_settled:')] });
      expect(h.store.listTodos(h.ask.id)).toEqual(before);
      expect(h.store.getAsk(h.ask.id)?.status).toBe('dropped');
      expect(h.calls).toEqual([]);
    } finally {
      h.db.close();
    }
  });
  test.each(['unknown', 'todo'])(
    'invalid replacement %s is recorded while removal succeeds',
    async (replacedBy) => {
      const h = setup();
      try {
        expect(
          await h.call('neo.todo.remove', { todoId: h.todo.id, replacedBy, reason: 'Superseded' })
        ).toMatchObject({
          ok: true,
          records: [expect.stringContaining('replacement_missing:')],
          todo: { state: 'removed', replacedBy: null, reason: 'Superseded' },
        });
        expect(h.store.getTodo(h.todo.id)).toMatchObject({ state: 'removed', replacedBy: null });
      } finally {
        h.db.close();
      }
    }
  );
});
