import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
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
        row('neo:b', 'processing', { projectId: 'p1', title: 'neo-ios' }),
        row('neo:a', 'queued'),
        row('neo:c', 'idle'),
        row('neo:d', 'interrupted'),
        row('neo:e', 'waiting_for_input'),
        row('neo:f', 'rate_limit_cooldown', { projectId: 'p2', title: 'money' }),
        row('neo:g', null),
      ])
    ).toEqual([
      { sessionId: 'neo:a', projectId: null, title: 'Neo', status: 'queued' },
      { sessionId: 'neo:b', projectId: 'p1', title: 'neo-ios', status: 'processing' },
      { sessionId: 'neo:f', projectId: 'p2', title: 'money', status: 'rate_limit_cooldown' },
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
  const worker = 'worker-1';
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let service: NeoService;
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
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event } as unknown as MessageHub,
      events
    );
    for (const id of [main, holder, worker]) db.createSession(createTestSession(id));
    service.repo.saveProject({ id: 'p1', title: 'neo-ios', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: main, kind: 'neo', projectId: null });
    service.repo.reserveBinding({ sessionId: holder, kind: 'project', projectId: 'p1' });
    service.repo.reserveBinding({ sessionId: worker, kind: 'worker', projectId: null });
  });
  afterEach(() => service.dispose());

  test('the snapshot list holds main and holders that are working, never workers', async () => {
    await state(main, { status: 'processing', messageId: 'm1', phase: 'thinking' });
    await state(holder, { status: 'queued', messageId: 'n1' });
    await state(worker, { status: 'processing', messageId: 'w1', phase: 'thinking' });
    expect(readNeoWorking(db.getDatabase())).toEqual([
      { sessionId: main, projectId: null, title: 'Neo', status: 'processing' },
      { sessionId: holder, projectId: 'p1', title: 'neo-ios', status: 'queued' },
    ]);
  });

  test('neo.working is sent only when the set changes, an archived holder included', async () => {
    await state(holder, { status: 'processing', messageId: 'n1', phase: 'initializing' });
    await state(holder, { status: 'processing', messageId: 'n1', phase: 'thinking' });
    await state(holder, { status: 'processing', messageId: 'n1', phase: 'streaming' });
    await state(worker, { status: 'processing', messageId: 'w1', phase: 'thinking' });
    await state(main, { status: 'queued', messageId: 'm1' });
    await state(main, { status: 'idle' });
    db.getDatabase().prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(holder);
    await events.publish('session.updated', { sessionId: holder, session: { status: 'archived' } });
    expect(sent()).toEqual([
      { working: [{ sessionId: holder, projectId: 'p1', title: 'neo-ios', status: 'processing' }] },
      {
        working: [
          { sessionId: main, projectId: null, title: 'Neo', status: 'queued' },
          { sessionId: holder, projectId: 'p1', title: 'neo-ios', status: 'processing' },
        ],
      },
      { working: [{ sessionId: holder, projectId: 'p1', title: 'neo-ios', status: 'processing' }] },
      { working: [] },
    ]);
    expect(readNeoWorking(db.getDatabase())).toEqual([]);
  });
});
