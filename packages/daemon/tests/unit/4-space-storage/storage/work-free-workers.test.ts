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

  describe('release fence', () => {
    const ref = { adapter: 'claude-desktop', id: 'w-done' };
    const other = { adapter: 'claude-desktop', id: 'w-other' };
    const liveTodo = (todoId: string, withRow = true) => {
      store.addTodo(
        todoId,
        'ask',
        { title: todoId, doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
        3
      );
      if (withRow) sessions.create(todoId, { verb: 'start', adapter: 'claude-desktop' });
    };

    test('a released worker is never offered again, also once its unusable mark expired', () => {
      bind('finished', 'w-done', 'done');
      recordStartedWork(db, ref, Date.now() - 61 * 60_000, true);
      expect(sessions.fenceRelease(ref, Date.now())).toBe(true);
      expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual([]);
    });

    test('a claim reserves the worker without touching the todo binding', () => {
      bind('finished', 'w-done', 'done');
      liveTodo('next');
      expect(sessions.claimWorker(ref, 'next')).toBe(true);
      expect(sessions.readRef('next')).toBeNull();
      expect(sessions.fenceRelease(ref, Date.now())).toBe(false);
    });

    test('a start that loses to the release claims nothing', () => {
      bind('finished', 'w-done', 'done');
      liveTodo('next');
      expect(sessions.fenceRelease(ref, Date.now())).toBe(true);
      expect(sessions.claimWorker(ref, 'next')).toBe(false);
    });

    test('a live todo with no binding row still reserves the worker', () => {
      bind('finished', 'w-done', 'done');
      liveTodo('targetless', false);
      expect(sessions.claimWorker(ref, 'targetless')).toBe(true);
      expect(sessions.fenceRelease(ref, Date.now())).toBe(false);
    });

    test('a todo holds one claim at a time, so a second worker cannot replace the first', () => {
      bind('finished', 'w-done', 'done');
      bind('finished-other', 'w-other', 'done');
      liveTodo('next');
      expect(sessions.claimWorker(ref, 'next')).toBe(true);
      expect(sessions.claimWorker(other, 'next')).toBe(false);
      expect(sessions.fenceRelease(ref, Date.now())).toBe(false);
      expect(sessions.fenceRelease(other, Date.now())).toBe(true);
    });

    test('a worker a failed or queued todo still holds cannot be claimed', () => {
      bind('failed-owner', 'w-done', 'done');
      store.updateTodo(store.getTodo('failed-owner')!, { state: 'failed' }, 3);
      liveTodo('next');
      expect(sessions.claimWorker(ref, 'next')).toBe(false);
      liveTodo('queued');
      sessions.queueOn('queued', other, 'Next step.');
      expect(sessions.claimWorker(other, 'next')).toBe(false);
    });

    test('a restart between claim and send leaves the todo recoverable and the worker reserved', () => {
      bind('finished', 'w-done', 'done');
      liveTodo('next');
      store.updateTodo(store.getTodo('next')!, { state: 'doing', startedAt: 4 }, 4);
      expect(sessions.claimWorker(ref, 'next')).toBe(true);
      const restarted = new NeoTodoSessionRepository(db);
      expect(restarted.unrecordedStarts()).toContain('next');
      expect(restarted.fenceRelease(ref, Date.now())).toBe(false);
    });

    test('rolling back a refused rebind keeps the old binding and its receipt', () => {
      bind('finished', 'w-done', 'done');
      bind('bound', 'w-other', 'doing');
      const sent = { inputBefore: 0, opening: 'Go', receipt: { executionId: 'e', inputId: 'i' } };
      sessions.recordSent('bound', sent);
      expect(sessions.claimWorker(ref, 'bound')).toBe(true);
      sessions.unclaimWorker('bound', ref);
      expect(sessions.readRef('bound')).toMatchObject(other);
      expect(sessions.readSent('bound')).toMatchObject({ receipt: sent.receipt });
      expect(sessions.fenceRelease(ref, Date.now())).toBe(true);
    });

    test('a start without a todo cannot claim a worker a todo was bound to', () => {
      bind('finished', 'w-done', 'done');
      expect(sessions.claimWorker(ref, null)).toBe(false);
      recordStartedWork(db, { adapter: 'claude-desktop', id: 'w-new' });
      expect(sessions.claimWorker({ adapter: 'claude-desktop', id: 'w-new' }, null)).toBe(true);
    });

    test('a claim for a todo that is not live reserves nothing', () => {
      bind('finished', 'w-done', 'done');
      bind('closed', 'w-other', 'done');
      expect(sessions.claimWorker(ref, 'closed')).toBe(false);
      expect(sessions.claimWorker(ref, 'missing')).toBe(false);
      expect(sessions.fenceRelease(ref, Date.now())).toBe(true);
    });

    test('a todo removed today releases its worker even if it finished eight days ago', () => {
      bind('old', 'w-done', 'done');
      const eightDays = Date.now() - 8 * 24 * 60 * 60_000;
      store.updateTodo(store.getTodo('old')!, { finishedAt: eightDays }, eightDays);
      db.prepare("UPDATE neo_todos SET state = 'removed', updated_at = ? WHERE id = 'old'").run(
        Date.now()
      );
      expect(
        sessions.finishedWorkers(Date.now() - 7 * 24 * 60 * 60_000).map((row) => row.todoId)
      ).toEqual(['old']);
    });
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
