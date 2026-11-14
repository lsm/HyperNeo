import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoOperations } from '../../helpers/neo-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  findNeoSessionNotice,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
} from '../../../../src/lib/neo/session-track.ts';
import { neoSessionKey, type NeoSessionNotice } from '../../../../src/lib/neo/session-watch.ts';
import type { PlaceGroup, WorkRef, WorkStatus } from '../../../../src/lib/drivers/types.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const ref = { adapter: 'codex-desktop', id: 't1' };
const key = neoSessionKey(ref);
const notice = (overrides: Partial<NeoSessionNotice> = {}): NeoSessionNotice => ({
  key,
  ref,
  title: 'Quiet-model research',
  kind: 'failed',
  at: 1,
  ...overrides,
});

describe('requireNeoTrackRoot', () => {
  test('refuses cleanly before Neo has a root session', () => {
    expect(requireNeoTrackRoot('neo:root')).toEqual({ value: 'neo:root' });
    expect(requireNeoTrackRoot(undefined)).toMatchObject({ reason: { ok: false } });
  });
});

describe('findNeoSessionNotice', () => {
  test('finds the latest notice for the key and refuses a key with no notice', () => {
    const later = notice({ at: 2, kind: 'needs_you' });
    expect(findNeoSessionNotice([notice(), later], key)).toEqual({ value: later });
    expect(findNeoSessionNotice([notice()], 'codex-desktop::other')).toMatchObject({
      reason: { ok: false },
    });
  });
});

describe('requireNeoTrackableSession', () => {
  test('refuses a session a Neo card already follows', () => {
    expect(requireNeoTrackableSession(notice(), [])).toEqual({ value: notice() });
    expect(requireNeoTrackableSession(notice(), [ref])).toEqual({
      reason: { ok: false, reason: 'A Neo card already follows this session.' },
    });
  });
});

describe('neo.session.track', () => {
  const RUN_MS = 3 * 60_000;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let listed: PlaceGroup['work'];
  let status: { status: WorkStatus; lastActivityAt: number };
  const sent = mock(() => ({ ok: true, value: { delivered: true } }));
  const stopped = mock(() => ({ ok: true, value: { stopped: true } }));

  const work = (overrides: Partial<PlaceGroup['work'][number]> = {}) => ({
    ref,
    title: 'Quiet-model research',
    place: { machine: 'laptop', folder: '/repo', name: 'repo' },
    status: 'running' as WorkStatus,
    lastActivityAt: 0,
    link: 'codex://threads/t1',
    ...overrides,
  });

  beforeEach(async () => {
    db = await createTestDb();
    await db.createSession(createTestSession('neo:root'));
    listed = [];
    status = { status: 'running', lastActivityAt: 0 };
    sent.mockClear();
    stopped.mockClear();
    const operation = (name: string, execute: () => unknown) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => execute(),
      });
    const registry = createOperationRegistry([
      operation('work.find', () => ({
        places: [
          {
            place: { machine: 'laptop', folder: '/repo', name: 'repo' },
            lastActivityAt: 0,
            openCount: listed.length,
            archivedCount: 0,
            adapters: ['codex-desktop'],
            work: listed,
          },
        ],
        unreachable: [],
      })),
      operation('work.status', () => ({ ok: true, value: status })),
      operation('work.send', sent),
      operation('work.stop', stopped),
    ]);
    service = createNeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test.each(['unavailable', 'throws'] as const)(
    'can retry a session relay after its source %s',
    async (failure) => {
      service.sessionWatcher.sessionNotices = [
        notice({
          kind: 'needs_you',
          question: { id: 'question-1', at: 1, text: 'Continue?', actions: ['Yes', 'Wait'] },
        }),
      ];
      const source = spyOn(service, 'readQuestionSource');
      if (failure === 'unavailable') source.mockResolvedValue(null);
      else source.mockRejectedValue(new Error('Source lookup failed'));
      const registry = createOperationRegistry(createNeoOperations(service));
      const relay = () =>
        invokeOperation(
          registry,
          'neo.question.relay',
          { session: key, title: 'Continue?', options: ['Yes', 'Wait'] },
          { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
        );
      const failed = await relay();
      expect(failed).toMatchObject(
        failure === 'unavailable'
          ? {
              kind: 'completed',
              value: { ok: false, reason: expect.stringContaining('source_session_unavailable') },
            }
          : { kind: 'failed', code: 'execution_failed' }
      );
      expect(service.todos.listOpenAsks()).toEqual([]);
      expect(await service.followedCardRefs(Date.now())).toEqual([]);
      expect(stopped).not.toHaveBeenCalled();
      source.mockResolvedValue({
        ...ref,
        name: 'Worker',
        label: 'Codex · Worker',
        provider: 'Codex',
        link: 'codex://threads/t1',
      });
      const retried = await relay();
      expect(retried).toMatchObject({ kind: 'completed', value: { ok: true } });
      expect(service.todos.listOpenAsks()).toHaveLength(1);
      const [ask] = service.todos.listOpenAsks();
      expect(service.todos.listQuestions(ask.id)).toMatchObject([
        { state: 'open', text: 'Continue?', sourceSession: ref },
      ]);
      source.mockRestore();
    }
  );

  test('concurrent Track taps create only one card for the worker', async () => {
    Object.assign(service, { deliver: async () => {} });
    service.sessionWatcher.sessionNotices = [notice()];
    const registry = createOperationRegistry(createNeoOperations(service));
    await Promise.all(
      [1, 2].map(() =>
        invokeOperation(
          registry,
          'neo.session.track',
          { key },
          { source: 'rpc', principal: 'local' }
        )
      )
    );
    expect(service.todos.listOpenAsks()).toHaveLength(1);
  });

  test('a done page keeps its worker and link from the same snapshot during rebinding', async () => {
    const ask = service.todos.openAsk({
      id: 'page-ask',
      projectId: null,
      sessionId: 'neo:root',
      originMessageId: null,
      title: 'Snapshot worker',
      request: '',
      createdAt: 1,
    });
    const todo = service.todos.addTodo(
      'page-todo',
      ask.id,
      { title: 'Done step', doneWhen: 'Observed', check: null, instruction: null, named: null },
      1
    );
    service.todos.updateTodo(todo, { state: 'done' }, 2);
    service.todoSessions.bind(todo.id, ref, 1);
    service.todoSessions.recordRef(todo.id, ref, 1, 'codex://threads/t1');
    Object.assign(service, {
      readWorker: async (worker: WorkRef) => ({ ...worker, name: worker.id, label: worker.id }),
    });
    const read = service.todos.read.bind(service.todos);
    const delayed = spyOn(service.todos, 'read').mockImplementation((async (method, ...args) => {
      if (method === 'todoLinks') {
        service.todoSessions.bind(todo.id, { adapter: 'codex-desktop', id: 't2' }, 3);
        service.todoSessions.recordRef(
          todo.id,
          { adapter: 'codex-desktop', id: 't2' },
          3,
          'codex://threads/t2'
        );
      }
      return read(method, ...args);
    }) as typeof service.todos.read);
    try {
      const result = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.ask.doneTodos',
        { askId: ask.id },
        { source: 'rpc', principal: 'local' }
      );
      expect(result).toMatchObject({
        kind: 'completed',
        value: { ok: true, todos: [{ worker: { id: 't1' }, link: 'codex://threads/t1' }] },
      });
    } finally {
      delayed.mockRestore();
    }
  });

  test('a human Track tap immediately queues a Neo kickoff', async () => {
    await service.trackSession('neo:root', notice(), Date.now());
    expect(
      db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': 'neo:root' })
        .map((job) => job.payload.deliveryMode)
    ).toEqual(['immediate']);
  });

  test('a tap opens an ask whose todo follows the session and stays doing when it stops', async () => {
    Object.assign(service, { deliver: async () => {} });
    const tapped = Date.now();
    await service.trackSession('neo:root', notice({ link: 'codex://threads/t1' }), tapped);
    const [ask] = service.todos.listOpenAsks();
    expect(ask).toMatchObject({ sessionId: 'neo:root', title: 'Quiet-model research' });
    const [todo] = service.todos.listTodos(ask.id);
    expect(todo).toMatchObject({ state: 'doing', instruction: null, startedAt: tapped });
    expect(service.todoSessions.readRef(todo.id)).toEqual(ref);
    expect(await service.followedCardRefs(tapped)).toEqual([ref]);
    status = { status: 'done', lastActivityAt: tapped - 1 };
    await service.todoRunner.refresh(() => {});
    expect(service.todos.getTodo(todo.id)?.state).toBe('doing');
    status = { status: 'done', lastActivityAt: tapped + 10_000 };
    await service.todoRunner.refresh(() => {});
    expect(service.todos.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });

  test('every tap tells Neo its own ask, and closing the todo never stops the human session', async () => {
    const told: string[] = [];
    Object.assign(service, {
      deliver: async (_root: string, messageId: string) => {
        told.push(messageId);
      },
    });
    await service.trackSession('neo:root', notice(), 1_000);
    const [first] = service.todos.listOpenAsks();
    const [todo] = service.todos.listTodos(first.id);
    expect(await service.todoRunner.stop(todo)).toBeNull();
    expect(stopped).not.toHaveBeenCalled();
    service.todos.settleAsk(first, 'dropped', 'Not needed', 2_000);
    await service.trackSession('neo:root', notice(), 3_000);
    expect(told).toHaveLength(2);
    expect(new Set(told).size).toBe(2);
  });
});
