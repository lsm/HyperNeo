import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  markWorkUnusable,
  readFreeWorkers,
  recordStartedWork,
} from '../../../../src/storage/work-started-sessions.ts';

describe('readFreeWorkers', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  const bind = (
    todoId: string,
    id: string,
    state: 'done' | 'doing' | 'closed_unverified' | 'failed' | 'removed',
    askId = 'ask'
  ) => {
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
    store.updateTodo(store.getTodo(todoId)!, { state }, 2);
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

  afterEach(() => db.close());

  test('only releases usable workers whose matter has settled', () => {
    bind('finished', 'w-done', 'done');
    bind('working', 'w-busy', 'doing');
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'w-new' });
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'w-bad' });
    recordStartedWork(db, { adapter: 'hyperneo', id: 'w-other' });
    markWorkUnusable(db, { adapter: 'claude-desktop', id: 'w-bad' });

    expect([...readFreeWorkers(db, 'claude-desktop')].sort()).toEqual(['w-new']);
  });

  test.each(['done', 'closed_unverified', 'failed', 'removed'] as const)(
    'an open ask retains its worker after a todo becomes %s',
    (state) => {
      bind('terminal', 'matter-worker', state);
      expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
      store.settleAsk(store.getAsk('ask')!, 'done', 'Matter settled', 3);
      expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual(['matter-worker']);
    }
  );

  test('an old settled binding never releases a worker still owned by another open ask', () => {
    bind('earlier', 'shared-worker', 'done');
    store.settleAsk(store.getAsk('ask')!, 'done', 'Earlier matter settled', 3);
    store.openAsk({
      id: 'still-open',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Later matter',
      request: 'Not settled',
      createdAt: 4,
    });
    store.addTodo(
      'later',
      'still-open',
      {
        title: 'Completed step',
        doneWhen: 'Observed',
        check: null,
        instruction: 'Go',
        named: null,
      },
      4
    );
    sessions.create('later', {
      verb: 'start',
      adapter: 'claude-desktop',
      place: { machine: 'synthetic', name: 'Fixture', folder: '/synthetic' },
    });
    sessions.recordRef('later', { adapter: 'claude-desktop', id: 'shared-worker' });
    store.updateTodo(store.getTodo('later')!, { state: 'done' }, 5);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
  });

  test('different-matter reuse lists the longest-settled ask first', () => {
    bind('old-step', 'z-longest-idle', 'done');
    store.settleAsk(store.getAsk('ask')!, 'done', 'Old matter settled', 10);
    store.openAsk({
      id: 'newer',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Newer matter',
      request: 'Work',
      createdAt: 11,
    });
    bind('newer-step', 'a-recently-idle', 'done', 'newer');
    store.settleAsk(store.getAsk('newer')!, 'done', 'Later matter settled', 20);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([
      'z-longest-idle',
      'a-recently-idle',
    ]);
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
});
