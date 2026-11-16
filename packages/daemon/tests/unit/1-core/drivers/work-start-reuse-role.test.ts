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
  recordStartedWork,
} from '../../../../src/storage/work-started-sessions';

const place = { machine: 'imac', folder: '/focus/repo', name: 'repo' };

function setup(idle: string[] = []) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'repo',
    request: 'repo',
    createdAt: 1,
  });
  const todo = (id: string, state: 'todo' | 'done') => {
    store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
      1
    );
    if (state !== 'todo') store.updateTodo(store.getTodo(id)!, { state, startedAt: 1 }, 2);
  };
  const sent: string[] = [];
  let fresh = 0;
  const adapter: WorkAdapter = {
    id: 'claude-desktop',
    capabilities: ['find', 'start', 'send'],
    find: () => [
      {
        place,
        lastActivityAt: 1,
        openCount: idle.length,
        archivedCount: 0,
        adapters: ['claude-desktop'],
        work: idle.map((id) => ({
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
        ref: { adapter: 'claude-desktop', id: `fresh-${++fresh}` },
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
      recordStarted: (ref) => recordStartedWork(db, ref),
      freeWorkers: (id, todoId, sessionId) => readReusableWorkers(db, id, todoId, sessionId),
      claimWorker: async (ref, todoId) => sessions.claimWorker(ref, todoId ?? null),
      unclaimWorker: async (todoId, ref) => sessions.unclaimWorker(todoId, ref),
      isOpenTodo: (todoId) => ['todo', 'doing', 'blocked'].includes(store.getTodo(todoId)?.state ?? ''),
    })
  );
  const start = async (todoId: string) => {
    const outcome = await invokeOperation(
      registry,
      'work.start',
      { adapter: 'claude-desktop', place, title: 'repo', message: 'Build it.', todoId },
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    );
    expect(outcome.kind).toBe('completed');
    const result = (outcome as { value: { ok: boolean; value: { ref: { id: string } } } }).value;
    expect(result.ok).toBe(true);
    return result.value.ref.id;
  };
  const finish = (id: string) => store.updateTodo(store.getTodo(id)!, { state: 'done' }, 3);
  return { sessions, todo, finish, idle, sent, start };
}

describe('work.start reuses only sessions the daemon started', () => {
  test('a free human-started session bound to a review todo gets no build work', async () => {
    const h = setup(['human']);
    h.todo('review', 'done');
    h.sessions.bind('review', { adapter: 'claude-desktop', id: 'human' }, 1);
    h.todo('build', 'todo');

    expect(await h.start('build')).toBe('fresh-1');
    expect(h.sent).toEqual([]);
  });

  test('a free session that work.start started is reused', async () => {
    const h = setup();
    h.todo('first', 'todo');
    const worker = await h.start('first');
    h.finish('first');
    h.idle.push(worker);
    h.todo('build', 'todo');

    expect(await h.start('build')).toBe(worker);
    expect(h.sent).toEqual([worker]);
  });
});
