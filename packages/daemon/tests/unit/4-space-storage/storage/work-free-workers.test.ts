import { beforeEach, describe, expect, test } from 'bun:test';
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
  const bind = (todoId: string, id: string, state: 'done' | 'doing') => {
    store.addTodo(
      todoId,
      'ask',
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
});
