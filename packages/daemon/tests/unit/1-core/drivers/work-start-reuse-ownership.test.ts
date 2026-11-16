import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readReusableWorkers } from '../../../../src/storage/work-started-sessions';

const place = { machine: 'imac', folder: '/focus/repo', name: 'repo' };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  for (const [ask, session] of [
    ['mine', 'neo-a'],
    ['theirs', 'neo-b'],
  ])
    store.openAsk({
      id: ask,
      projectId: null,
      sessionId: session,
      originMessageId: null,
      title: ask,
      request: ask,
      createdAt: 1,
    });
  const bind = (todoId: string, askId: string, worker: string, state: 'done' | 'doing') => {
    store.addTodo(
      todoId,
      askId,
      { title: todoId, doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
      1
    );
    sessions.create(todoId, { verb: 'start', adapter: 'claude-desktop', place });
    sessions.recordRef(todoId, { adapter: 'claude-desktop', id: worker });
    store.updateTodo(store.getTodo(todoId)!, { state, startedAt: 1 }, 2);
  };
  bind('finished', 'mine', 'w-idle', 'done');
  bind('foreign', 'theirs', 'w-foreign', 'doing');
  const sent: string[] = [];
  const adapter: WorkAdapter = {
    id: 'claude-desktop',
    capabilities: ['find', 'start', 'send'],
    find: () => [
      {
        place,
        lastActivityAt: 1,
        openCount: 1,
        archivedCount: 0,
        adapters: ['claude-desktop'],
        work: [
          {
            ref: { adapter: 'claude-desktop', id: 'w-idle' },
            title: 'w-idle',
            place,
            status: 'done',
            lastActivityAt: 1,
          },
        ],
      },
    ],
    start: async (request) => ({
      ok: true,
      value: {
        ref: { adapter: 'claude-desktop', id: 'fresh' },
        title: request.title,
        place,
        status: 'running',
        lastActivityAt: 2,
      },
    }),
    send: async (ref) => {
      sent.push(ref.id);
      return { ok: true, value: { delivered: true, receipt: { executionId: 'e', inputId: 'i' } } };
    },
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      freeWorkers: (id, todoId, sessionId) => readReusableWorkers(db, id, todoId, sessionId),
      claimWorker: async (ref, todoId) => sessions.claimWorker(ref, todoId ?? null),
      unclaimWorker: async (todoId, ref, previous) => sessions.unclaimWorker(todoId, ref, previous),
      isOpenTodo: (todoId, sessionId) => {
        const todo = store.getTodo(todoId);
        const ask = todo ? store.getAsk(todo.askId) : null;
        return (
          !!todo &&
          ['todo', 'doing', 'blocked'].includes(todo.state) &&
          ask?.status === 'open' &&
          ask.sessionId === sessionId
        );
      },
    })
  );
  return { db, sessions, sent, registry };
}

describe('work.start reuse binds only a todo the caller owns', () => {
  test("a Neo start naming another session's todo leaves that todo's worker binding alone", async () => {
    const h = setup();
    try {
      const outcome = await invokeOperation(
        h.registry,
        'work.start',
        {
          adapter: 'claude-desktop',
          place,
          title: 'repo',
          message: 'Fix it.',
          todoId: 'foreign',
        },
        { source: 'mcp', sessionId: 'neo-a', role: 'neo' }
      );
      expect(outcome.kind).toBe('completed');
      expect((outcome as { value: { ok: boolean } }).value.ok).toBe(true);
      expect(h.sessions.readRef('foreign')).toMatchObject({ id: 'w-foreign' });
    } finally {
      h.db.close();
    }
  });
});
