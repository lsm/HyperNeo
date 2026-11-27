import { describe, expect, test } from 'bun:test';
import type { Result, WorkAdapter, WorkDelivery } from '../../../../src/lib/drivers/types';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { readDriverOutcome } from '../../../../src/lib/neo/driver-work';
import { planTurnTodo } from '../../../../src/lib/neo/turn-todo';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import { WorkDeliveryInputRepository } from '../../../../src/storage/repositories/work-delivery-input-repository';
import {
  readReusableWorkers,
  readSameAskWorkers,
  recordWorkerStarted,
} from '../../../../src/storage/repositories/work-started-sessions-worker';
import {
  readTurnTodoFacts,
  retargetDeliveryInput,
} from '../../../../src/storage/repositories/work-turn-todo-worker';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const place = { machine: 'imac', folder: '/focus/repo', name: 'repo' };
const idle = { adapter: 'claude-desktop', id: 'w-idle' };

function setup(send: () => Promise<Result<WorkDelivery>>, markUnusable?: () => Promise<void>) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const inputs = new WorkDeliveryInputRepository(db);
  store.openAsk({
    id: 'mine',
    projectId: null,
    sessionId: 'neo-a',
    originMessageId: null,
    title: 'mine',
    request: 'mine',
    createdAt: 1,
  });
  const todo = (id: string) =>
    store.addTodo(
      id,
      'mine',
      { title: id, doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
      1
    );
  todo('first');
  sessions.create('first', { verb: 'start', adapter: 'claude-desktop', place });
  sessions.recordRef('first', idle);
  recordWorkerStarted(db, idle, {
    startedBy: 'neo-a',
    todoId: 'first',
    machine: 'imac',
    harness: 'claude-desktop',
  });
  store.updateTodo(store.getTodo('first')!, { state: 'done', startedAt: 1 }, 2);
  todo('second');
  sessions.create('second', { verb: 'start', adapter: 'claude-desktop', place });
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
        work: [{ ref: idle, title: 'w-idle', place, status: 'done' as const, lastActivityAt: 1 }],
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
    send,
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      freeWorkers: (id, todoId, sessionId) => readReusableWorkers(db, id, todoId, sessionId),
      reusePolicy: async (adapterId, todoId) => ({
        mode: 'long_lived',
        sameAsk: todoId
          ? readSameAskWorkers(db, 'mine', todoId, adapterId).map(({ id }) => id)
          : [],
      }),
      claimWorker: async (ref, todoId) => sessions.claimWorker(ref, todoId ?? null),
      unclaimWorker: async (todoId, ref) => sessions.unclaimWorker(todoId, ref),
      markUnusable: markUnusable ?? (async () => {}),
      acceptedTodo: (todoId) => !!store.getTodo(todoId),
      isOpenTodo: (todoId) =>
        ['todo', 'doing', 'blocked'].includes(store.getTodo(todoId)?.state ?? ''),
      workInputs: {
        accept: (todoId, from, target, message) =>
          inputs.accept(todoId, from, target as never, message, Date.now()),
        recordOutcome: (id, target, outcome) =>
          inputs.recordOutcome(
            id,
            readDriverOutcome(target as never, { kind: 'completed', value: outcome }) as never,
            Date.now()
          ),
        recordFailure: (id, error) =>
          inputs.recordOutcome(id, { failure: String(error) }, Date.now()),
        retarget: (id, ref) => retargetDeliveryInput(db, id, ref),
      },
    })
  );
  const start = () =>
    invokeOperation(
      registry,
      'work.start',
      { adapter: 'claude-desktop', place, title: 'repo', message: 'Fix it.', todoId: 'second' },
      { source: 'mcp', sessionId: 'neo-a', role: 'neo' }
    );
  const todoOf = (id: string, inputsSeen: string[] = []) =>
    planTurnTodo({ id, inputs: inputsSeen }, readTurnTodoFacts(db, idle))?.todo ?? null;
  const row = () => inputs.list('second')[0];
  return { start, todoOf, row };
}

describe('work.start reuse names the worker it may have reached', () => {
  test('an uncertain reused send and its late turn take the credit from the first todo', async () => {
    const h = setup(async () => ({
      ok: false,
      reason: 'not_delivered',
      detail: 'Delivery is uncertain.',
    }));
    expect(h.todoOf('before')).toBe('first');
    await h.start();
    expect(h.row().target).toMatchObject({ ref: idle });
    expect(h.todoOf('late')).toBeNull();
  });

  test('a send interrupted before its acknowledgement also takes the credit', async () => {
    const h = setup(async () => {
      throw new Error('transport lost');
    });
    expect(await h.start()).toMatchObject({ kind: 'failed' });
    expect(h.row().target).toMatchObject({ ref: idle });
    expect(h.todoOf('late')).toBeNull();
  });

  test.each([
    ['notSent', { ok: false, reason: 'not_delivered', detail: 'refused', notSent: true }],
    ['not_open', { ok: false, reason: 'not_open', detail: 'closed' }],
    ['not_found', { ok: false, reason: 'not_found', detail: 'gone' }],
  ] as const)('a %s rejection then a fresh start leaves no stale ref', async (_, rejection) => {
    const h = setup(async () => rejection as Result<WorkDelivery>);
    await h.start();
    expect(h.row().target).not.toHaveProperty('ref');
    expect(h.todoOf('t1')).toBe('first');
  });

  test('a not_open rejection whose bookkeeping throws leaves no stale ref', async () => {
    const h = setup(
      async () => ({ ok: false, reason: 'not_open', detail: 'closed' }),
      async () => {
        throw new Error('storage unavailable');
      }
    );
    expect(await h.start()).toMatchObject({ kind: 'failed' });
    expect(h.row().target).not.toHaveProperty('ref');
    expect(h.todoOf('t1')).toBe('first');
  });

  test('a successful reuse keeps its send key on the outcome', async () => {
    const h = setup(async () => ({
      ok: true,
      value: { delivered: true, steeredIntoTurnId: 'reused-turn' },
    }));
    expect(await h.start()).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(h.todoOf('reused-turn')).toBe('second');
  });
});
