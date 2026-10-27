import { describe, expect, test } from 'bun:test';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { resolveNeoTodoTarget } from '../../../../src/lib/neo/todo-target.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';

const full = '10000000-0000-4000-8000-000000000001';

function fixture(
  options: {
    refs?: WorkRef[];
    more?: boolean;
    beforeLookup?: (todos: NeoAskTodoRepository) => void;
    onStart?: (todos: NeoAskTodoRepository, id: string) => void;
  } = {}
) {
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
        resolveTarget: (ref: WorkRef) =>
          resolveNeoTodoTarget(ref, async (name) => {
            options.beforeLookup?.(todos);
            const refs = options.refs ?? [{ ...ref, id: full }];
            const exact = refs.find(
              (candidate) =>
                candidate.id === ref.id &&
                candidate.adapter === ref.adapter &&
                candidate.daemon === ref.daemon
            );
            const place = { machine: 'synthetic', name: 'Synthetic place' };
            return {
              kind: 'completed',
              value:
                name === 'work.status'
                  ? exact
                    ? { ok: true, value: { ref: exact } }
                    : { ok: false, reason: 'not_found' }
                  : {
                      places: [
                        {
                          place,
                          lastActivityAt: 1,
                          openCount: refs.length,
                          archivedCount: 0,
                          adapters: [ref.adapter],
                          work: refs.map((ref) => ({
                            ref,
                            title: 'Synthetic worker',
                            place,
                            status: 'running',
                            lastActivityAt: 1,
                          })),
                        },
                      ],
                      unreachable: [],
                      more: options.more ?? false,
                    },
            };
          }),
        start: async (id) => {
          starts++;
          options.onStart?.(todos, id);
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
  const bind = async (todoId: string, ref: WorkRef) => {
    const reply = await handler({ name: 'neo.todo.bind', input: { todoId, ref } });
    expect(reply.isError ?? false).toBe(false);
    return JSON.parse(reply.content[0].text);
  };
  return { db, todos, sessions, add, bind, starts: () => starts };
}

describe('todo target identity at the MCP add door', () => {
  test('dispatch sees the committed todo and target outside the writer transaction', async () => {
    let observed = false;
    const f = fixture({
      onStart: (todos, id) => {
        expect(todos.getTodo(id)).toMatchObject({
          state: 'todo',
          instruction: 'Perform synthetic work',
        });
        expect(todos.listQuestions('ask')).toEqual([]);
        expect(f.sessions.get(id)).toEqual({ verb: 'start', adapter: 'hyperneo' });
        f.db.exec('BEGIN IMMEDIATE');
        f.db.exec('ROLLBACK');
        observed = true;
      },
    });
    try {
      expect(await f.add({ verb: 'start', adapter: 'hyperneo' }, true)).toMatchObject({
        ok: false,
        reason: 'Unexpected dispatch',
      });
      expect(observed).toBe(true);
      expect(f.starts()).toBe(1);
      expect(f.todos.listTodos('ask')).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  test('direct binding stores the resolved reference rather than the supplied prefix', async () => {
    const f = fixture();
    try {
      const original = { adapter: 'hyperneo', id: full };
      const added = await f.add({ verb: 'send', ref: original });
      const ref = { adapter: 'codex-desktop', daemon: 'synthetic-peer', id: full.slice(0, 8) };
      const result = await f.bind(added.todo.id, ref);
      expect(result.ok).toBe(true);
      expect(f.sessions.readRef(added.todo.id)).toEqual({ ...ref, id: full });
      expect(f.starts()).toBe(0);
    } finally {
      f.db.close();
    }
  });
  test('direct binding rejects unknown work and leaves the prior target intact', async () => {
    const f = fixture();
    try {
      const original = { adapter: 'hyperneo', id: full };
      const added = await f.add({ verb: 'send', ref: original });
      const before = f.todos.getTodo(added.todo.id);
      const target = f.sessions.get(added.todo.id);
      const result = await f.bind(added.todo.id, { adapter: 'codex-desktop', id: 'missing' });
      expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^target_not_found:/) });
      expect(f.todos.getTodo(added.todo.id)).toEqual(before);
      expect(f.sessions.get(added.todo.id)).toEqual(target);
      expect(f.sessions.readRef(added.todo.id)).toBeNull();
    } finally {
      f.db.close();
    }
  });
  test('does not add a todo if the ask settles during target lookup', async () => {
    const f = fixture({
      beforeLookup: (todos) => {
        const ask = todos.getAsk('ask')!;
        if (ask.status === 'open')
          todos.settleAsk(ask, 'done', 'Settled during lookup', Date.now());
      },
    });
    try {
      const result = await f.add({ verb: 'send', ref: { adapter: 'hyperneo', id: full } });
      expect(result.ok).toBe(true);
      expect(result.records[0]).toMatch(/^ask_settled:/);
      expect(f.todos.listTodos('ask')).toEqual([]);
    } finally {
      f.db.close();
    }
  });
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
        expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^target_not_found:/) });
        expect(f.todos.listTodos('ask')).toEqual([]);
        expect(f.starts()).toBe(0);
      } finally {
        f.db.close();
      }
    }
  );
  test.each([
    {
      refs: [
        { adapter: 'codex-desktop', id: full },
        { adapter: 'codex-desktop', id: full.replace(/1$/, '2') },
      ],
    },
    { more: true },
    { refs: [{ adapter: 'hyperneo', id: full }] },
    { refs: [{ adapter: 'codex-desktop', daemon: 'another-peer', id: full }] },
  ])('rejects ambiguous, incomplete or differently owned matches: %j', async (options) => {
    const f = fixture(options);
    try {
      const result = await f.add({
        verb: 'send',
        ref: { adapter: 'codex-desktop', id: full.slice(0, 8) },
      });
      expect(result.ok).toBe(false);
      expect(f.todos.listTodos('ask')).toEqual([]);
      expect(f.starts()).toBe(0);
    } finally {
      f.db.close();
    }
  });
  test('keeps a verified exact id even when discovery would be incomplete', async () => {
    const f = fixture({ more: true });
    try {
      const ref = { adapter: 'hyperneo', id: full };
      const result = await f.add({ verb: 'send', ref });
      expect(result.ok).toBe(true);
      expect(f.sessions.get(result.todo.id)?.ref).toEqual(ref);
    } finally {
      f.db.close();
    }
  });
});
