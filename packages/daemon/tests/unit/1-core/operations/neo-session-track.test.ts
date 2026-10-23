import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  findNeoSessionNotice,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
  requireNeoTrackedAdoption,
  reserveNeoAdoption,
} from '../../../../src/lib/neo/session-track.ts';
import { neoSessionKey, type NeoSessionNotice } from '../../../../src/lib/neo/session-watch.ts';
import type { PlaceGroup, WorkStatus } from '../../../../src/lib/drivers/types.ts';
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

describe('reserveNeoAdoption', () => {
  test('lets one adoption of a session run at a time', () => {
    const adopting = new Set<string>();
    const adopt = { verb: 'adopt' as const, ref };
    expect(reserveNeoAdoption(adopting, { verb: 'send', ref })).toEqual({ value: null });
    expect(reserveNeoAdoption(adopting, adopt)).toEqual({ value: key });
    expect(reserveNeoAdoption(adopting, adopt)).toMatchObject({ reason: { ok: false } });
  });
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

describe('requireNeoTrackedAdoption', () => {
  test('follows a named session from any Neo turn without a Track timer', () => {
    expect(requireNeoTrackedAdoption({ verb: 'adopt', ref }, [], 'ok')).toEqual({ value: 'ok' });
    expect(requireNeoTrackedAdoption({ verb: 'send', ref }, [ref], 'ok')).toEqual({ value: 'ok' });
  });
  test('keeps the duplicate-follow guard', () => {
    expect(requireNeoTrackedAdoption({ verb: 'adopt', ref }, [ref], 'ok')).toEqual({
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
    db.createSession(createTestSession('neo:root'));
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

  test('a tap opens an ask whose todo follows the session and stays doing when it stops', async () => {
    Object.assign(service, { deliver: async () => {} });
    const tapped = Date.now();
    await service.trackSession('neo:root', notice({ link: 'codex://threads/t1' }), tapped);
    const [ask] = service.todos.listOpenAsks();
    expect(ask).toMatchObject({ sessionId: 'neo:root', title: 'Quiet-model research' });
    const [todo] = service.todos.listTodos(ask.id);
    expect(todo).toMatchObject({ state: 'doing', instruction: null, startedAt: tapped });
    expect(service.todoSessions.readRef(todo.id)).toEqual(ref);
    expect(service.followedCardRefs(tapped)).toEqual([ref]);
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
