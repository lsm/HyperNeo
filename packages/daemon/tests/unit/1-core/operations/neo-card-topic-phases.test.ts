import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { EventLoopActivity } from '../../../../src/lib/event-loop-activity';
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
  for (const id of ['keep', 'remove']) {
    const todo = service.todos.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Reported', instruction: null, check: null, named: null },
      1
    );
    service.todos.updateTodo(todo, { state: id === 'keep' ? 'doing' : 'removed' }, 2);
    service.cardEvents.subscribe(id, `synthetic/${id}`, 3);
  }
});
afterEach(() => {
  service.dispose();
  db.close();
});

test.each(['list', 'followed', 'pack', 'end'])(
  'diagnostics identify a slow %s segment without changing subscription decisions',
  (segment) => {
    const slow = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
    const original =
      segment === 'list'
        ? service.cardEvents.listActive.bind(service.cardEvents)
        : segment === 'followed'
          ? service.todos.getTodos.bind(service.todos)
          : segment === 'pack'
            ? db.getGlobalSettings.bind(db)
            : service.cardEvents.end.bind(service.cardEvents);
    const probe =
      segment === 'list'
        ? spyOn(service.cardEvents, 'listActive')
        : segment === 'followed'
          ? spyOn(service.todos, 'getTodos')
          : segment === 'pack'
            ? spyOn(db, 'getGlobalSettings')
            : spyOn(service.cardEvents, 'end');
    probe.mockImplementation((...args: never[]) => {
      slow();
      return Reflect.apply(original, undefined, args);
    });
    const activity = new EventLoopActivity();
    const stop = activity.activate();
    try {
      expect(service.endUnfollowedCardTopics(10)).toEqual([
        { workId: 'remove', topic: 'synthetic/remove' },
      ]);
      const entries = activity.drain().entries;
      const expected =
        segment === 'list'
          ? 'neo:card_topics:list_active'
          : segment === 'followed'
            ? 'neo:card_topics:followed_snapshot'
            : segment === 'pack'
              ? 'neo:packs:eligibility_read'
              : 'neo:card_topics:end:remove';
      expect(
        entries.find((e) => e.name === expected && e.kind === 'end')?.durationMs
      ).toBeGreaterThanOrEqual(12);
      if (segment === 'pack')
        expect(
          entries.some(
            (e) => e.name === 'neo:card_topics:card_events_delivered:keep' && e.kind === 'end'
          )
        ).toBe(true);
      expect(entries.some((e) => e.name === 'neo:card_topics:card_events_delivered:remove')).toBe(
        false
      );
      expect(service.cardEvents.listActive()).toEqual([
        { workId: 'keep', topic: 'synthetic/keep' },
      ]);
    } finally {
      stop();
      probe.mockRestore();
    }
  }
);
