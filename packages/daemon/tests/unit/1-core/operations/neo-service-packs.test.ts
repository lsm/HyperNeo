import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>, service: NeoService;
const url = 'https://github.com/synthetic/plan/pull/8';
beforeEach(async () => {
  db = await createTestDb();
  service = new NeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
});
afterEach(() => {
  service.dispose();
  db.close();
});

test('installed builtins keep identity and settings select without rebuilding them', () => {
  const installed = service.installedPacks();
  expect(installed.map((pack) => pack.id)).toEqual(['coding', 'life-admin']);
  expect(service.packs()).toEqual([installed[0]]);
  db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  expect(service.packs()).toEqual([installed[1]]);
  expect(service.installedPacks()[0]).toBe(installed[0]);
  expect(service.installedPacks()[1]).toBe(installed[1]);
});

test('an installed legacy todo check observes reader replacements and retains its claims', async () => {
  service.todos.openAsk({
    id: 'ask',
    title: 'Legacy',
    request: 'Ship',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    {
      title: 'Stage',
      doneWhen: 'Merged',
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
      instruction: null,
      named: null,
    },
    1
  );
  const pack = service.pack('coding')!;
  service.readPrs = mock(async () => [{ url, state: 'OPEN', checks: 'pending', review: 'none' }]);
  expect(await pack.todos!.check(todo)).toEqual({ done: false, evidence: null });
  service.readPrs = mock(async () => [
    { url, state: 'MERGED', checks: 'passing', review: 'approved' },
  ]);
  expect(await pack.todos!.check(todo)).toEqual({ done: true, evidence: '#8 merged' });
  expect(service.readPrs).toHaveBeenCalledWith([url]);
  expect(service.todoPrs.urls(todo.id)).toEqual([url]);
  expect(service.todos.getTodo(todo.id)?.state).toBe('todo');
});

test('an installed issue judgement observes the current reader without writing todo state', async () => {
  service.todos.openAsk({
    id: 'ask',
    title: 'Issue',
    request: 'Ship',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    {
      title: 'Stage',
      doneWhen: 'Completed',
      check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'synthetic/plan#1' } },
      instruction: null,
      named: null,
    },
    1
  );
  const pack = service.pack('coding')!;
  service.readRefStates = mock(async () => []);
  expect(pack.judge!(todo, await pack.readFacts!(todo))).toEqual({ state: 'no_opinion' });
  service.readRefStates = mock(async () => [
    {
      kind: 'issue',
      url: 'https://github.com/synthetic/plan/issues/1',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      done: true,
      closedBy: null,
      closingPrs: [],
      at: 2,
    },
  ]);
  expect(pack.judge!(todo, await pack.readFacts!(todo))).toMatchObject({ state: 'done' });
  expect(service.todos.getTodo(todo.id)?.state).toBe('todo');
});
