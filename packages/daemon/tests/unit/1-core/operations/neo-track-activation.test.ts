import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
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
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession('neo:root'));
  service = createNeoService(
    db,
    { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  service.sessionWatcher.sessionNotices = [
    { key, ref, title: '完整的人类工作 🦊', kind: 'failed', at: 1 },
  ];
  told.length = 0;
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
});
test('a failed kickoff leaves one committed card and a repeated tap is refused', async () => {
  Object.assign(service, {
    deliver: async () => {
      throw new Error('synthetic delivery failure');
    },
  });
  expect(await tap()).toMatchObject({
    kind: 'failed',
    message: expect.stringContaining('synthetic delivery failure'),
  });
  expect(service.todos.listOpenAsks()).toHaveLength(1);
  expect(await tap()).toEqual({
    kind: 'completed',
    value: { ok: false, reason: 'A Neo card already follows this session.' },
  });
  expect(service.todos.listOpenAsks()).toHaveLength(1);
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
