import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoOperations } from '../../helpers/neo-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { neoSessionKey } from '../../../../src/lib/neo/session-watch.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
const ref = { adapter: 'codex-desktop', id: 'synthetic-track-worker' };
const key = neoSessionKey(ref);
const told: { root: string; id: string; text: string }[] = [];
const announcements: string[] = [];
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession('neo:root'));
  service = createNeoService(
    db,
    { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
    {
      event: mock((name: string) => {
        if (name === 'neo.changed') announcements.push(name);
      }),
    } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  service.sessionWatcher.sessionNotices = [
    { key, ref, title: '完整的人类工作 🦊', kind: 'failed', at: 1 },
  ];
  told.length = 0;
  announcements.length = 0;
  Object.assign(service, {
    deliver: async (root: string, id: string, text: string) => {
      told.push({ root, id, text });
    },
  });
});
afterEach(async () => {
  service.dispose();
  await db.gateway.close();
  db.close();
});
const tap = () =>
  invokeOperation(
    createOperationRegistry(createNeoOperations(service)),
    'neo.session.track',
    { key },
    { source: 'rpc', principal: 'local' }
  );
test('a failed Track transaction leaves no Work card or kickoff', async () => {
  db.getDatabase().exec(
    "CREATE TRIGGER refuse_track BEFORE UPDATE OF follow_anchor ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic Track rollback'); END"
  );
  expect(await tap()).toMatchObject({
    kind: 'failed',
    message: expect.stringContaining('synthetic Track rollback'),
  });
  expect(service.todos.listOpenAsks()).toEqual([]);
  expect(service.todos.followedRefs()).toEqual([]);
  expect(told).toEqual([]);
  expect(announcements).toEqual([]);
});
test('overlapping Track requests admit one complete card and one kickoff', async () => {
  const results = await Promise.all([tap(), tap()]);
  expect(results).toEqual(
    expect.arrayContaining([
      { kind: 'completed', value: { ok: true } },
      {
        kind: 'completed',
        value: { ok: false, reason: 'A Neo card already follows this session.' },
      },
    ])
  );
  const [ask] = service.todos.listOpenAsks();
  const [todo] = service.todos.listTodos(ask.id);
  expect(todo.state).toBe('doing');
  expect(service.todoSessions.readRef(todo.id)).toEqual(ref);
  expect(told).toHaveLength(1);
  expect(told[0].root).toBe(ask.sessionId);
  expect(told[0].text).toContain(ask.id);
  expect(told[0].text).toContain(todo.id);
  expect(announcements).toEqual(['neo.changed']);
});
test('a failed kickoff leaves one committed card and a repeated tap is refused', async () => {
  let announcedBeforeKickoff = false;
  Object.assign(service, {
    deliver: async () => {
      announcedBeforeKickoff = announcements.length === 1;
      throw new Error('synthetic delivery failure');
    },
  });
  expect(await tap()).toMatchObject({
    kind: 'failed',
    message: expect.stringContaining('synthetic delivery failure'),
  });
  expect(service.todos.listOpenAsks()).toHaveLength(1);
  expect(announcedBeforeKickoff).toBe(true);
  expect(announcements).toEqual(['neo.changed']);
  expect(await tap()).toEqual({
    kind: 'completed',
    value: { ok: false, reason: 'A Neo card already follows this session.' },
  });
  expect(service.todos.listOpenAsks()).toHaveLength(1);
  expect(announcements).toEqual(['neo.changed']);
});
test('missing root keeps its refusal precedence over missing notice', async () => {
  db.getDatabase().exec('DELETE FROM neo_session_bindings');
  service.sessionWatcher.sessionNotices = [];
  expect(await tap()).toEqual({
    kind: 'completed',
    value: { ok: false, reason: 'Neo has not started yet; open Neo once, then tap Track.' },
  });
  expect(told).toEqual([]);
});

test('a Neo MCP caller cannot Track on the human behalf', async () => {
  expect(
    await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.session.track',
      { key },
      { source: 'mcp', sessionId: 'neo:root' }
    )
  ).toEqual({ kind: 'completed', value: { ok: false, reason: 'This action needs the user.' } });
  expect(service.todos.listOpenAsks()).toEqual([]);
  expect(told).toEqual([]);
});
const relay = () =>
  invokeOperation(
    createOperationRegistry(createNeoOperations(service)),
    'neo.question.relay',
    { session: key, title: 'Ship it?', options: ['Yes', 'Not now'] },
    { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
  );
const asked = () => {
  service.sessionWatcher.sessionNotices = [
    {
      key,
      ref,
      title: 'Asking worker',
      kind: 'needs_you',
      at: 1,
      question: { id: 'wrap', at: 1, text: 'Ship it?', actions: ['Yes', 'Not now'] },
    },
  ];
};
test('a session relay whose card fails leaves the session free to relay again', async () => {
  asked();
  Object.assign(service, {
    storeWorkerQuestion: async () => ({ ok: false, reason: 'source_session_unavailable: gone' }),
  });

  expect(await relay()).toMatchObject({
    kind: 'completed',
    value: { ok: false, reason: 'source_session_unavailable: gone' },
  });

  expect(service.todos.listOpenAsks()).toEqual([]);
  expect(service.todos.followedRefs()).toEqual([]);
});
test('a session relay whose card write throws leaves no followed ask', async () => {
  asked();
  Object.assign(service, {
    storeWorkerQuestion: async () => {
      throw new Error('synthetic card failure');
    },
  });

  expect(await relay()).toMatchObject({ kind: 'failed' });

  expect(service.todos.listOpenAsks()).toEqual([]);
  expect(service.todos.followedRefs()).toEqual([]);
});
