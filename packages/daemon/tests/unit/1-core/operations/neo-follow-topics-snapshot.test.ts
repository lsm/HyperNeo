import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import { createTestDb, createTestSession } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let watched: string[];
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('root'));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    createDaemonInternalEventBus()
  );
  watched = [];
  service.readPrs = async () => [];
  service.watchExternalTopic = async (topic) => {
    watched.push(topic);
  };
  service.todos.openAsk({
    id: 'ask',
    sessionId: 'root',
    projectId: null,
    originMessageId: 'human',
    title: 'Synthetic',
    request: 'Synthetic',
    createdAt: 1,
  });
});
afterEach(() => {
  service.dispose();
  db.close();
});
function seed(count: number, state: 'doing' | 'removed' = 'doing') {
  for (let i = 0; i < count; i++) {
    const id = `todo-${i}`;
    const todo = service.todos.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Reported', instruction: null, check: null, named: null },
      1
    );
    service.todos.updateTodo(todo, { state }, 2);
    service.todoPrs.claim(
      id,
      [{ url: `https://github.com/synthetic/feed/pull/${i + 1}`, claim: 'named' }],
      2
    );
  }
}

test.each([{ packs: ['coding'] }, { packs: ['life-admin'] }, { packs: [] }])(
  'a 180-todo refresh stays responsive with packs: %j',
  async ({ packs }) => {
    const enabled = packs.includes('coding');
    seed(180);
    db.updateGlobalSettings({ neo: { packs } });
    const read = db.getGlobalSettings.bind(db);
    const probe = spyOn(db, 'getGlobalSettings').mockImplementation(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
      return read();
    });
    let last = performance.now(),
      maxLag = 0;
    const timer = setInterval(() => {
      const at = performance.now();
      maxLag = Math.max(maxLag, at - last - 5);
      last = at;
    }, 5);
    try {
      await new Promise((done) => setTimeout(done, 15));
      await service.refreshDriverWork();
      await new Promise((done) => setTimeout(done, 15));
      expect(service.cardEvents.listActive()).toHaveLength(enabled ? 180 : 0);
      expect(watched).toHaveLength(enabled ? 180 : 0);
      expect(maxLag).toBeLessThan(1000);
    } finally {
      clearInterval(timer);
      probe.mockRestore();
    }
  }
);

test('the next refresh observes pack settings changes in both directions', async () => {
  seed(2);
  await service.refreshDriverWork();
  const initial = service.cardEvents.listActive();
  expect(initial).toHaveLength(2);
  db.updateGlobalSettings({ neo: { packs: [] } });
  await service.refreshDriverWork();
  expect(service.cardEvents.listActive()).toEqual([]);
  db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  await service.refreshDriverWork();
  expect(service.cardEvents.listActive()).toEqual(initial);
  expect(watched).toHaveLength(4);
});

test('direct topic following observes settings on each call and preserves deduplication', () => {
  seed(2);
  db.updateGlobalSettings({ neo: { packs: [] } });
  service.followCardTopics('todo-0');
  expect(watched).toEqual([]);
  db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  service.followCardTopics('todo-0');
  service.followCardTopics('todo-0');
  service.followCardTopics('todo-1');
  expect(service.cardEvents.listActive()).toHaveLength(2);
  expect(watched).toHaveLength(2);
});

test('a refresh with no followed todos does not need pack settings', async () => {
  seed(2, 'removed');
  const probe = spyOn(db, 'getGlobalSettings').mockImplementation(() => {
    throw new Error('synthetic settings unavailable');
  });
  try {
    await service.refreshDriverWork();
    expect(service.cardEvents.listActive()).toEqual([]);
    expect(watched).toEqual([]);
  } finally {
    probe.mockRestore();
  }
});
