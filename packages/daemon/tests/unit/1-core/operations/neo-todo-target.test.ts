import { describe, expect, test } from 'bun:test';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';

const full = '10000000-0000-4000-8000-000000000001';

function fixture() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Synthetic ask',
    request: 'Track work',
    createdAt: 1,
  });
  let starts = 0;
  const registry = createOperationRegistry(
    createNeoTodoOperations(
      todos,
      sessions,
      {
        resolveTarget: async (ref: WorkRef) =>
          ref.id === full || ref.id === full.slice(0, 8)
            ? { value: { ...ref, id: full } }
            : { reason: { ok: false as const, reason: 'target_not_found: unknown work' } },
        start: async () => {
          starts++;
          return { ok: false as const, reason: 'Unexpected dispatch' };
        },
        recompute: async (todo, patch) => todos.updateTodo(todo, patch, Date.now()),
        proceed: async () => ({ ok: false as const, reason: 'Unexpected dispatch' }),
        retry: async () => ({ ok: false as const, reason: 'Unexpected dispatch' }),
        stop: async () => null,
      },
      () => createTodoCheckPacks(db),
      () => null
    )
  );
  const handler = createOperationMcpHandler(registry, () => ({ sessionId: 'neo', role: 'neo' }));
  const add = async (target: unknown, start = false) => {
    const reply = await handler({
      name: 'neo.todo.add',
      input: {
        askId: 'ask',
        title: 'Synthetic todo',
        check: pendingTodoCheck,
        instruction: 'Perform synthetic work',
        target,
        start,
      },
    });
    expect(reply.isError ?? false).toBe(false);
    return JSON.parse(reply.content[0].text);
  };
  return { db, todos, sessions, add, starts: () => starts };
}

describe('todo target identity at the MCP add door', () => {
  test.each(['send', 'bind'])('stores the resolved full id for a %s target', async (verb) => {
    const f = fixture();
    try {
      const ref = { adapter: 'codex-desktop', daemon: 'synthetic-peer', id: full.slice(0, 8) };
      const result = await f.add({ verb, ref });
      expect(result.ok).toBe(true);
      const target =
        verb === 'bind' ? f.sessions.readRef(result.todo.id) : f.sessions.get(result.todo.id)?.ref;
      expect(target).toEqual({ ...ref, id: full });
      expect(f.starts()).toBe(0);
    } finally {
      f.db.close();
    }
  });
  test.each([false, true])(
    'rejects an unknown target before recording or dispatching (start=%s)',
    async (start) => {
      const f = fixture();
      try {
        const result = await f.add(
          { verb: 'send', ref: { adapter: 'codex-desktop', id: 'missing' } },
          start
        );
        expect(result).toEqual({ ok: false, reason: 'target_not_found: unknown work' });
        expect(f.todos.listTodos('ask')).toEqual([]);
        expect(f.starts()).toBe(0);
      } finally {
        f.db.close();
      }
    }
  );
});
