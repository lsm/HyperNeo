import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  readReusableWorkers,
  readSameAskWorkers,
  recordWorkerStarted,
} from '../../../../src/storage/repositories/work-started-sessions-worker';

const place = { machine: 'imac', folder: '/focus/repo', name: 'repo' };

function setup(gate?: Promise<void>) {
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
    recordWorkerStarted(db, { adapter: 'claude-desktop', id: worker });
    store.updateTodo(store.getTodo(todoId)!, { state, startedAt: 1 }, 2);
  };
  bind('finished', 'mine', 'w-idle', 'done');
  bind('foreign', 'theirs', 'w-foreign', 'doing');
  bind('finished-2', 'mine', 'w-idle-2', 'done');
  store.addTodo(
    'owned',
    'mine',
    { title: 'owned', doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
    3
  );
  sessions.create('owned', { verb: 'start', adapter: 'claude-desktop', place });
  const sent: string[] = [];
  const firstSent = Promise.withResolvers<void>();
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
        work: ['w-idle', 'w-idle-2'].map((id) => ({
          ref: { adapter: 'claude-desktop', id },
          title: id,
          place,
          status: 'done' as const,
          lastActivityAt: 1,
        })),
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
    compact: async () => ({ ok: true, value: { compacted: true } }),
    send: async (ref) => {
      sent.push(ref.id);
      firstSent.resolve();
      if (sent.length === 1) await gate;
      return { ok: true, value: { delivered: true, receipt: { executionId: 'e', inputId: 'i' } } };
    },
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      freeWorkers: (id, todoId, sessionId) => readReusableWorkers(db, id, todoId, sessionId),
      reusePolicy: async (adapter, todoId) => ({
        mode: 'long_lived',
        sameAsk: todoId ? readSameAskWorkers(db, 'mine', todoId, adapter).map(({ id }) => id) : [],
      }),
      claimWorker: async (ref, todoId) => sessions.claimWorker(ref, todoId ?? null),
      unclaimWorker: async (todoId, ref) => sessions.unclaimWorker(todoId, ref),
      acceptedTodo: (todoId) => !!store.getTodo(todoId),
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
  return { db, sessions, sent, registry, firstSent: firstSent.promise };
}

function start(registry: ReturnType<typeof setup>['registry'], todoId: string) {
  return invokeOperation(
    registry,
    'work.start',
    { adapter: 'claude-desktop', place, title: 'repo', message: 'Fix it.', todoId },
    { source: 'mcp', sessionId: 'neo-a', role: 'neo' }
  );
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
      expect((outcome as { value: { ok: boolean } }).value.ok).toBe(false);
      expect(h.sessions.readRef('foreign')).toMatchObject({ id: 'w-foreign' });
    } finally {
      h.db.close();
    }
  });

  test('a second start for the same todo cannot take another worker while the first send waits', async () => {
    let open = () => {};
    const h = setup(new Promise<void>((done) => (open = done)));
    try {
      const first = start(h.registry, 'owned');
      await h.firstSent;
      const second = await start(h.registry, 'owned');
      expect((second as { value: { value: { ref: { id: string } } } }).value.value.ref.id).toBe(
        'fresh'
      );
      expect(
        h.sessions.fenceRelease({ adapter: 'claude-desktop', id: h.sent[0] }, Date.now())
      ).toBe(false);
      open();
      await first;
    } finally {
      open();
      h.db.close();
    }
  });
});
