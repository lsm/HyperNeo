import { beforeEach, describe, expect, test } from 'bun:test';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  markWorkUnusable,
  readFreeWorkers,
  readReusableWorkers,
  recordStartedWork,
} from '../../../../src/storage/work-started-sessions.ts';

describe('readFreeWorkers', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  const bind = (todoId: string, id: string, state: 'done' | 'doing', askId = 'ask', at = 1) => {
    store.addTodo(
      todoId,
      askId,
      { title: todoId, doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
      1
    );
    sessions.create(todoId, {
      verb: 'start',
      adapter: 'claude-desktop',
      place: { machine: 'synthetic', name: 'Fixture', folder: '/synthetic' },
    });
    sessions.recordRef(todoId, { adapter: 'claude-desktop', id });
    store.updateTodo(store.getTodo(todoId)!, { state, startedAt: at }, 2);
  };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Work',
      request: 'Work',
      createdAt: 1,
    });
  });

  test('lists recorded workers of the adapter that hold no open todo and are usable', () => {
    bind('finished', 'w-done', 'done');
    bind('working', 'w-busy', 'doing');
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'w-new' });
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'w-bad' });
    recordStartedWork(db, { adapter: 'hyperneo', id: 'w-other' });
    markWorkUnusable(db, { adapter: 'claude-desktop', id: 'w-bad' });

    expect([...readFreeWorkers(db, 'claude-desktop')].sort()).toEqual(['w-done', 'w-new']);
  });

  test('an unusable mark expires after an hour', () => {
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'w-old' });
    recordStartedWork(
      db,
      { adapter: 'claude-desktop', id: 'w-old' },
      Date.now() - 61 * 60_000,
      true
    );

    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual(['w-old']);
  });

  test('a worker bound only through a todo can be marked unusable', () => {
    bind('finished', 'w-done', 'done');
    markWorkUnusable(db, { adapter: 'claude-desktop', id: 'w-done' });

    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
  });

  describe('readReusableWorkers', () => {
    test('legacy engine birth cannot make a later todo look older than its creation', () => {
      bind('legacy-prior', 'legacy', 'done', 'ask', 20);
      store.addTodo(
        'legacy-new',
        'ask',
        { title: 'Later', doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
        50
      );
      sessions.create('legacy-new', { verb: 'start', adapter: 'claude-desktop' });
      sessions.recordRef('legacy-new', { adapter: 'claude-desktop', id: 'legacy' }, 1);
      store.updateTodo(store.getTodo('legacy-new')!, { state: 'done' }, 60);
      expect(
        readReusableWorkers(db, 'claude-desktop', 'legacy-new', 'neo').get('legacy')?.sameAskAt
      ).toBe(50);
    });

    test('reads same-ask recency from legacy bindings without a started-work row', () => {
      bind('first', 'worker', 'done', 'ask', 10);
      bind('latest', 'worker', 'done', 'ask', 30);
      expect(readReusableWorkers(db, 'claude-desktop', 'latest', 'neo').get('worker')).toEqual({
        sameAskAt: 30,
        settledAt: null,
      });
      expect(
        readReusableWorkers(db, 'claude-desktop', 'latest', 'another-neo').get('worker')?.sameAskAt
      ).toBeNull();
      expect(
        readReusableWorkers(db, 'claude-desktop', 'missing', 'neo').get('worker')?.sameAskAt
      ).toBeNull();
    });

    test('borrowing uses the latest associated ask, not any old settled ask', () => {
      store.openAsk({
        id: 'older',
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Older',
        request: 'Older',
        createdAt: 1,
      });
      bind('old-work', 'shared', 'done', 'older', 10);
      store.settleAsk(store.getAsk('older')!, 'done', 'Observed', 100);
      bind('new-work', 'shared', 'done', 'ask', 20);
      expect(readReusableWorkers(db, 'claude-desktop').get('shared')?.settledAt).toBeNull();
      store.settleAsk(store.getAsk('ask')!, 'done', 'Observed', 300);
      expect(readReusableWorkers(db, 'claude-desktop').get('shared')?.settledAt).toBe(300);
    });
  });
});
