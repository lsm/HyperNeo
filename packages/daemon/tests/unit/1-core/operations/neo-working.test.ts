import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  neoWorkingKey,
  projectNeoWorking,
  readNeoWorking,
} from '../../../../src/lib/neo/working.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const row = (sessionId: string, status: string | null, extra = {}) => ({
  sessionId,
  projectId: null,
  title: null,
  status,
  ...extra,
});

describe('projectNeoWorking', () => {
  test('keeps queued, processing and retrying sessions, titled, in a stable order', () => {
    expect(
      projectNeoWorking([
        row('neo:b', 'processing', { projectId: 'p1', title: 'neo-ios', name: 'Current worker' }),
        row('neo:a', 'queued'),
        row('neo:c', 'idle'),
        row('neo:d', 'interrupted'),
        row('neo:e', 'waiting_for_input'),
        row('neo:f', 'rate_limit_cooldown', { projectId: 'p2', title: 'money' }),
        row('neo:g', null),
      ])
    ).toEqual([
      {
        sessionId: 'neo:a',
        projectId: null,
        title: 'Neo',
        status: 'queued',
        worker: { id: 'neo:a', adapter: 'hyperneo', name: null, label: 'HyperNeo · neo:a' },
      },
      {
        sessionId: 'neo:b',
        projectId: 'p1',
        title: 'neo-ios',
        status: 'processing',
        worker: {
          id: 'neo:b',
          adapter: 'hyperneo',
          name: 'Current worker',
          label: 'HyperNeo · Current worker',
        },
      },
      {
        sessionId: 'neo:f',
        projectId: 'p2',
        title: 'money',
        status: 'rate_limit_cooldown',
        worker: { id: 'neo:f', adapter: 'hyperneo', name: null, label: 'HyperNeo · neo:f' },
      },
    ]);
  });
});

describe('neoWorkingKey', () => {
  test('changes when a session joins, leaves, changes status or is renamed', () => {
    const one = projectNeoWorking([row('neo:a', 'processing')]);
    expect(neoWorkingKey(one)).toBe(neoWorkingKey(projectNeoWorking([row('neo:a', 'processing')])));
    expect(neoWorkingKey(one)).not.toBe(neoWorkingKey(projectNeoWorking([row('neo:a', 'queued')])));
    expect(neoWorkingKey(one)).not.toBe(neoWorkingKey([]));
    expect(neoWorkingKey(one)).not.toBe(
      neoWorkingKey(projectNeoWorking([row('neo:a', 'processing', { title: 'Renamed' })]))
    );
  });
});

describe('Neo working sessions', () => {
  const main = 'neo:10000000-0000-4000-8000-000000000001';
  const holder = 'neo:holder';
  const mainWorker = {
    id: main,
    adapter: 'hyperneo',
    name: 'Synthetic main',
    label: 'HyperNeo · Synthetic main',
  };
  const worker = 'worker-1';
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let service: ReturnType<typeof createNeoService>;
  const event = vi.fn();
  const state = (sessionId: string, processingState: Record<string, unknown>) => {
    db.getDatabase()
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(JSON.stringify(processingState), sessionId);
    return events.publish('session.updated', {
      sessionId,
      source: 'processing-state',
      processingState: processingState as never,
    });
  };
  const sent = () =>
    event.mock.calls.filter(([name]) => name === 'neo.working').map(([, data]) => data);

  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    event.mockClear();
    service = createNeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event } as unknown as MessageHub,
      events
    );
    for (const id of [main, holder, worker])
      await db.createSession({
        ...createTestSession(id),
        title: id === main ? 'Synthetic main' : 'Synthetic worker',
      });
    service.repo.saveProject({ id: 'p1', title: 'neo-ios', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: main, kind: 'neo', projectId: null });
    service.repo.reserveBinding({ sessionId: worker, kind: 'worker', projectId: null });
  });
  afterEach(() => service.dispose());

  test('the snapshot list holds main when it is working, never workers', async () => {
    await state(main, { status: 'processing', messageId: 'm1', phase: 'thinking' });
    await state(worker, { status: 'processing', messageId: 'w1', phase: 'thinking' });
    expect(readNeoWorking(db.getDatabase())).toEqual([
      { sessionId: main, projectId: null, title: 'Neo', status: 'processing', worker: mainWorker },
    ]);
  });

  test('a renamed working session is reread without changing its identity or project title', async () => {
    await state(main, { status: 'processing', messageId: 'm1', phase: 'thinking' });
    db.getDatabase()
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run('Renamed main', main);
    await state(main, { status: 'processing', messageId: 'm1', phase: 'thinking' });
    expect(readNeoWorking(db.getDatabase())[0]).toEqual({
      sessionId: main,
      projectId: null,
      title: 'Neo',
      status: 'processing',
      worker: {
        id: main,
        adapter: 'hyperneo',
        name: 'Renamed main',
        label: 'HyperNeo · Renamed main',
      },
    });
    expect(sent()).toHaveLength(2);
    expect(sent()[1].working[0].worker.label).toBe('HyperNeo · Renamed main');
  });

  test('neo.working is sent only when the set changes', async () => {
    await state(main, { status: 'processing', messageId: 'm1', phase: 'initializing' });
    await state(main, { status: 'processing', messageId: 'm1', phase: 'thinking' });
    await state(worker, { status: 'processing', messageId: 'w1', phase: 'thinking' });
    await state(main, { status: 'queued', messageId: 'm2' });
    await state(main, { status: 'idle' });
    expect(sent()).toEqual([
      {
        working: [
          {
            sessionId: main,
            projectId: null,
            title: 'Neo',
            status: 'processing',
            worker: mainWorker,
          },
        ],
      },
      {
        working: [
          { sessionId: main, projectId: null, title: 'Neo', status: 'queued', worker: mainWorker },
        ],
      },
      { working: [] },
    ]);
    expect(readNeoWorking(db.getDatabase())).toEqual([]);
  });
});
