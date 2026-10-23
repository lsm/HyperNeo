import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import { createTestDb, createTestSession } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('root'));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    createDaemonInternalEventBus()
  );
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
    service.cardEvents.subscribe(id, `synthetic/${i}/a`, 3);
    service.cardEvents.subscribe(id, `synthetic/${i}/b`, 3);
  }
}

test.each([true, false])(
  'a 180-todo sweep stays responsive with pack delivery enabled: %s',
  async (enabled) => {
    seed(180);
    if (!enabled) db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
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
      const ended = service.endUnfollowedCardTopics(4);
      await new Promise((done) => setTimeout(done, 15));
      expect(ended).toHaveLength(enabled ? 0 : 360);
      expect(service.cardEvents.listActive()).toHaveLength(enabled ? 360 : 0);
      expect(maxLag).toBeLessThan(250);
    } finally {
      clearInterval(timer);
      probe.mockRestore();
    }
  }
);

test('pack setting changes take effect on the next sweep, in both directions', () => {
  seed(1);
  expect(service.endUnfollowedCardTopics(4)).toEqual([]);
  db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  expect(service.endUnfollowedCardTopics(5)).toHaveLength(2);
  expect(service.cardEvents.listActive()).toEqual([]);
  db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  service.cardEvents.subscribe('todo-0', 'synthetic/0/a', 6);
  expect(service.endUnfollowedCardTopics(7)).toEqual([]);
  expect(service.cardEvents.listActive()).toEqual([{ workId: 'todo-0', topic: 'synthetic/0/a' }]);
});

test.each([0, 2])('does not need pack settings when %s topics have no followed todo', (count) => {
  seed(count, 'removed');
  const probe = spyOn(db, 'getGlobalSettings').mockImplementation(() => {
    throw new Error('synthetic settings unavailable');
  });
  try {
    expect(service.endUnfollowedCardTopics(4)).toHaveLength(count * 2);
    expect(service.cardEvents.listActive()).toEqual([]);
  } finally {
    probe.mockRestore();
  }
});
