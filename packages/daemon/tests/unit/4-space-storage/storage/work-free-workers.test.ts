import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { runMigration468 } from '../../../../src/storage/schema/m468-worker-matter.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  markWorkUnusable,
  readFreeWorkers,
  readStartedWork,
  recordStartedWork,
} from '../../../../src/storage/work-started-sessions.ts';

describe('worker reuse eligibility', () => {
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
    sessions.recordRef(todoId, { adapter: 'claude-desktop', id }, 2);
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

  const track = (id: string, todoId: string, at: number, reusable = true) =>
    Reflect.apply(recordStartedWork, undefined, [
      db,
      { adapter: 'claude-desktop', id },
      at,
      false,
      { todoId, sessionId: 'neo', reusable },
    ]);
  const owned = (todoId: string, sessionId = 'neo') =>
    Reflect.apply(readStartedWork, undefined, [db, 'claude-desktop', todoId, sessionId]).map(
      (ref: { id: string }) => ref.id
    );

  test('a new worker belongs to the ask before any todo ref is attached', () => {
    store.addTodo(
      'unbound',
      'ask',
      { title: 'Next step', doneWhen: 'Observed', check: null, instruction: null, named: null },
      2
    );
    track('new-owner', 'unbound', 3);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
    expect(owned('unbound')).toEqual(['new-owner']);
    store.settleAsk(store.getAsk('ask')!, 'done', 'Settled', 4);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual(['new-owner']);
    expect(owned('unbound')).toEqual([]);
  });
  test('ownership survives a todo being rebound to another worker', () => {
    bind('rebound', 'first-owner', 'done');
    track('first-owner', 'rebound', 3);
    sessions.recordRef('rebound', { adapter: 'claude-desktop', id: 'replacement-owner' });
    track('replacement-owner', 'rebound', 4);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
    expect(owned('rebound')).toEqual(['replacement-owner', 'first-owner']);
  });
  test('upgrade preserves every known open-ask binding after todo refs are replaced', () => {
    bind('legacy-first', 'legacy-shared', 'done');
    store.openAsk({
      id: 'legacy-second-ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Second',
      request: 'Work',
      createdAt: 4,
    });
    bind('legacy-second', 'legacy-shared', 'done', 'legacy-second-ask');
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'legacy-shared' }, 5);
    const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
      name: string;
    }[];
    for (const column of columns.filter((column) => column.name.startsWith('ask_')))
      db.exec(`ALTER TABLE work_started_sessions DROP COLUMN ${column.name}`);
    runMigration468(db);
    sessions.recordRef('legacy-first', { adapter: 'claude-desktop', id: 'first-replacement' }, 6);
    sessions.recordRef('legacy-second', { adapter: 'claude-desktop', id: 'second-replacement' }, 6);
    expect([...readFreeWorkers(db, 'claude-desktop')]).not.toContain('legacy-shared');
    store.settleAsk(store.getAsk('ask')!, 'done', 'First settled', 7);
    expect([...readFreeWorkers(db, 'claude-desktop')]).not.toContain('legacy-shared');
    store.settleAsk(store.getAsk('legacy-second-ask')!, 'done', 'Second settled', 8);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toContain('legacy-shared');
  });

  test('same-ask candidates are most recently used first and require the owning Neo', () => {
    bind('step', 'a-old-owner', 'done');
    track('a-old-owner', 'step', 10);
    track('z-latest-owner', 'step', 20);
    expect(owned('step')).toEqual(['z-latest-owner', 'a-old-owner']);
    expect(owned('step', 'another-neo')).toEqual([]);
    expect(owned('unknown-todo')).toEqual([]);
    markWorkUnusable(db, { adapter: 'claude-desktop', id: 'z-latest-owner' });
    expect(owned('step')).toEqual(['a-old-owner']);
  });
  test('prepared review and QA actors never become reusable authors', () => {
    bind('prepared', 'prepared-reviewer', 'done');
    track('prepared-reviewer', 'prepared', 3, false);
    store.settleAsk(store.getAsk('ask')!, 'done', 'Review finished', 4);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
  });
  test('a legacy coding assignment keeps its independent actor out of the author pool', () => {
    bind('author-step', 'original-author', 'done');
    recordStartedWork(db, { adapter: 'claude-desktop', id: 'legacy-reviewer' });
    db.prepare(
      "INSERT INTO pack_facts(todo_id,pack,key,value_json)VALUES(?,'coding','assignment:synthetic:review',?)"
    ).run(
      'author-step',
      JSON.stringify({ ref: { adapter: 'claude-desktop', id: 'legacy-reviewer' } })
    );
    store.settleAsk(store.getAsk('ask')!, 'done', 'Completed', 4);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual(['original-author']);
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
