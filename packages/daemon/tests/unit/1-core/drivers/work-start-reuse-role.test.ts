import { describe, expect, test } from 'bun:test';
import {
  createWorkVerbOperations,
  StartWorkInputSchema,
} from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  readReusableWorkers,
  readTodoRoles,
  readWorkerPreparations,
  recordWorkerStarted,
} from '../../../../src/storage/repositories/work-started-sessions-worker';

const place = { machine: 'imac', folder: '/focus/repo', name: 'repo' };

function setup(
  idle: string[] = [],
  shares: Record<string, { shareWith?: string[] }> = {},
  perAsk = false
) {
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
  const busy = new Set<string>();
  let fresh = 0;
  const adapter: WorkAdapter = {
    id: 'claude-desktop',
    supportsStartPreparation: true,
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
          status: busy.has(id) ? ('running' as const) : ('done' as const),
          lastActivityAt: 1,
        })),
      },
    ],
    status: async (ref) => ({
      ok: true,
      value: {
        ref,
        title: ref.id,
        place,
        status: busy.has(ref.id) ? 'running' : 'done',
        lastActivityAt: 1,
      },
    }),
    start: async (request) => ({
      ok: true,
      value: {
        ref: {
          adapter: 'claude-desktop',
          id: `${request.preparation ? 'prepared' : Object.keys(shares).length ? 'shared' : 'fresh'}-${++fresh}`,
        },
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
      recordStarted: (ref, _directory, facts) => recordWorkerStarted(db, ref, facts),
      freeWorkers: (id, todoId, sessionId) => readReusableWorkers(db, id, todoId, sessionId),
      ...(perAsk
        ? {
            reusePolicy: async () => ({ mode: 'per_ask' as const, sameAsk: [...idle] }),
            todoWorker: { on: () => false, wait: async () => 'message' as const },
          }
        : {}),
      roleContext: async (todoId, adapter) => ({
        roles: readTodoRoles(db, todoId),
        preparations: readWorkerPreparations(db, adapter),
        shares,
        perRoundFields: ['head'],
      }),
      claimWorker: async (ref, todoId, role, model, effort, shareWith) =>
        sessions.claimWorker(ref, todoId ?? null, role, model, effort, shareWith),
      unclaimWorker: async (todoId, ref, role) => sessions.unclaimWorker(todoId, ref, role),
      acceptedTodo: (todoId) => !!store.getTodo(todoId),
      isOpenTodo: (todoId) =>
        ['todo', 'doing', 'blocked'].includes(store.getTodo(todoId)?.state ?? ''),
    })
  );
  const start = async (
    todoId: string,
    preparation?: { pack: string; parameters: Record<string, unknown> },
    role?: 'review' | 'check'
  ) => {
    const outcome = await invokeOperation(
      registry,
      'work.start',
      {
        adapter: 'claude-desktop',
        place,
        title: 'repo',
        message: 'Build it.',
        todoId,
        ...(role ? { role } : {}),
        ...(preparation ? { preparation } : {}),
      },
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    );
    expect(outcome.kind).toBe('completed');
    const result = (outcome as { value: { ok: boolean; value: { ref: { id: string } } } }).value;
    expect(result.ok).toBe(true);
    return result.value.ref.id;
  };
  const finish = (id: string) => store.updateTodo(store.getTodo(id)!, { state: 'done' }, 3);
  return { sessions, todo, finish, idle, sent, start, db, busy };
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

  test('reuses a prepared reviewer for a new head but not a different stable preparation', async () => {
    const h = setup();
    const preparation = (head: string, branch: string) => ({
      pack: 'coding',
      parameters: { head, branch },
    });
    h.todo('review', 'todo');
    const reviewer = await h.start('review', preparation('head-1', 'main'), 'review');
    h.idle.push(reviewer);
    expect(readWorkerPreparations(h.db, 'claude-desktop')).toEqual([
      { id: reviewer, preparation: JSON.stringify(preparation('head-1', 'main')) },
    ]);
    expect(await h.start('review', preparation('head-2', 'main'), 'review')).toBe(reviewer);
    expect(await h.start('review', preparation('head-3', 'other'), 'review')).not.toBe(reviewer);
  });

  test('roles explicitly allowed to share can use the same claimed worker', async () => {
    const h = setup([], { check: { shareWith: ['do'] } });
    h.todo('shared', 'todo');
    const worker = await h.start('shared');
    h.idle.push(worker);
    const ref = { adapter: 'claude-desktop', id: worker };
    h.sessions.bind('shared', ref, 1);
    expect(h.sessions.claimWorker(ref, 'shared', 'do')).toBe(true);
    expect(await h.start('shared', undefined, 'check')).toBe(worker);
    h.sessions.unclaimWorker('shared', ref, 'check');
    h.todo('other', 'todo');
    expect(h.sessions.claimWorker(ref, 'other', 'do')).toBe(false);
  });

  test('does not wait for a busy worker with a different stable preparation', async () => {
    const h = setup([], {}, true);
    h.todo('first-prepared', 'todo');
    const worker = await h.start('first-prepared', {
      pack: 'coding',
      parameters: { branch: 'one' },
    });
    h.finish('first-prepared');
    h.idle.push(worker);
    h.busy.add(worker);
    h.todo('second-prepared', 'todo');
    expect(
      await h.start('second-prepared', { pack: 'coding', parameters: { branch: 'two' } })
    ).not.toBe(worker);
  });
});

test('work.start accepts the supported roles and rejects unbounded role names', () => {
  const input = { adapter: 'claude-desktop', title: 'Work', message: 'Go' };
  for (const role of ['do', 'review', 'verify', 'check'])
    expect(StartWorkInputSchema.safeParse({ ...input, role }).success).toBe(true);
  expect(StartWorkInputSchema.safeParse({ ...input, role: 'custom' }).success).toBe(false);
});
