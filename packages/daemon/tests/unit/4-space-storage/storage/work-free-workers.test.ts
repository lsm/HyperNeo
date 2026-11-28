import { beforeEach, describe, expect, test } from 'bun:test';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  markWorkUnusable,
  readFreeWorkers,
  readReusableWorkers,
  readStartedWork,
  recordStartedWork,
  recordWorkerStarted,
} from '../../../../src/storage/repositories/work-started-sessions-worker.ts';

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
    recordWorkerStarted(db, { adapter: 'claude-desktop', id });
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
    recordWorkerStarted(db, { adapter: 'claude-desktop', id: 'w-new' });
    recordWorkerStarted(db, { adapter: 'claude-desktop', id: 'w-bad' });
    recordWorkerStarted(db, { adapter: 'hyperneo', id: 'w-other' });
    markWorkUnusable(db, { adapter: 'claude-desktop', id: 'w-bad' });

    expect([...readFreeWorkers(db, 'claude-desktop')].sort()).toEqual(['w-done', 'w-new']);
  });

  test('does not trust a legacy claim without a worker marker', () => {
    db.prepare(`INSERT INTO work_started_sessions (adapter, id, started_at, claimed_by, kind)
      VALUES ('claude-desktop', 'legacy-claim', 1, 'todo', NULL),
             ('claude-desktop', 'legacy-worker', 1, NULL, 'worker')`).run();
    const visible = readStartedWork(db).map((worker) => worker.id);
    expect(visible).toContain('legacy-worker');
    expect(visible).toContain('legacy-claim');
    expect(
      readStartedWork(db, null, undefined, { adapter: 'claude-desktop', id: 'legacy-claim' })
    ).toEqual([]);
    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual(['legacy-worker']);
    expect(sessions.fenceWorkerRelease({ adapter: 'claude-desktop', id: 'legacy-claim' }, 3)).toBe(
      'not_started_by_us'
    );
  });

  test('an unusable mark expires after an hour', () => {
    recordWorkerStarted(db, { adapter: 'claude-desktop', id: 'w-old' });
    recordStartedWork(
      db,
      { adapter: 'claude-desktop', id: 'w-old' },
      Date.now() - 61 * 60_000,
      true
    );

    expect([...readFreeWorkers(db, 'claude-desktop')]).toEqual(['w-old']);
  });

  test('a worker bound through a todo can be marked unusable', () => {
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

    test('a started todo without a worker can wait for a busy worker', () => {
      liveTodo('next');
      store.updateTodo(store.getTodo('next')!, { state: 'doing', startedAt: 4 }, 4);
      expect(sessions.queueOn('next', ref, 'Follow-up.')).toBe('none');
      expect(store.getTodo('next')?.state).toBe('doing');
      expect(sessions.queueOn('next', ref, 'Next step.', { requeueDoing: true })).toBe(
        'instruction'
      );
      expect(sessions.get('next')).toMatchObject({ verb: 'send', ref });
      expect(store.getTodo('next')?.state).toBe('todo');
    });

    test('a todo waiting for a busy worker keeps its requested provider, model and effort', () => {
      store.addTodo(
        'triple',
        'ask',
        { title: 'triple', doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
        3
      );
      sessions.create('triple', {
        verb: 'start',
        adapter: 'claude-desktop',
        provider: 'anthropic',
        model: 'claude-test',
        effort: 'high',
      });
      expect(sessions.queueOn('triple', ref, 'Next step.')).toBe('instruction');
      expect(sessions.get('triple')).toEqual({
        verb: 'send',
        ref,
        preparationParameters: {},
        provider: 'anthropic',
        model: 'claude-test',
        effort: 'high',
      });
    });

    test('a bound doing todo cannot be requeued onto a different worker', () => {
      bind('bound', 'w-other', 'doing');
      expect(sessions.queueOn('bound', ref, 'Next step.', { requeueDoing: true })).toBe('none');
      expect(store.getTodo('bound')?.state).toBe('doing');
      expect(sessions.readRef('bound')).toMatchObject(other);
    });

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

    test('a todo can claim one worker per role and rolls back a refused round', () => {
      bind('finished', 'w-done', 'done');
      bind('finished-other', 'w-other', 'done');
      bind('finished-third', 'w-third', 'done');
      liveTodo('next');
      const third = { adapter: 'claude-desktop', id: 'w-third' };
      expect(sessions.claimWorker(ref, 'next', 'do', 'writer', 'high')).toBe(true);
      expect(sessions.claimWorker(other, 'next', 'review', 'reviewer', 'medium')).toBe(true);
      expect(sessions.claimWorker(third, 'next', 'review')).toBe(false);
      expect(
        db
          .prepare(
            'SELECT role, id, model, effort FROM neo_todo_roles WHERE todo_id = ? ORDER BY rowid'
          )
          .all('next')
      ).toEqual([
        { role: 'do', id: 'w-done', model: 'writer', effort: 'high' },
        { role: 'review', id: 'w-other', model: 'reviewer', effort: 'medium' },
      ]);
      sessions.unclaimWorker('next', other, 'review');
      expect(sessions.claimWorker(third, 'next', 'review')).toBe(true);
      expect(
        db
          .prepare('SELECT role, id FROM neo_todo_roles WHERE todo_id = ? ORDER BY rowid')
          .all('next')
      ).toEqual([
        { role: 'do', id: 'w-done' },
        { role: 'review', id: 'w-third' },
      ]);
    });

    test('one todo cannot reserve more than four idle workers with distinct roles', () => {
      liveTodo('next');
      const refs = Array.from({ length: 5 }, (_, i) => ({
        adapter: 'claude-desktop',
        id: `cap-${i}`,
      }));
      for (const [i, candidate] of refs.entries()) {
        bind(`finished-cap-${i}`, candidate.id, 'done');
      }
      for (const [i, role] of ['do', 'review', 'verify', 'check'].entries()) {
        expect(sessions.claimWorker(refs[i], 'next', role)).toBe(true);
      }
      expect(sessions.claimWorker(refs[4], 'next', 'custom')).toBe(false);
      sessions.unclaimWorker('next', refs[3], 'check');
      expect(sessions.claimWorker(refs[4], 'next', 'custom')).toBe(true);
    });

    test('one worker cannot hold two claims for one todo and a refused role cannot release it', () => {
      bind('finished', 'w-done', 'done');
      liveTodo('next');
      expect(sessions.claimWorker(ref, 'next', 'do')).toBe(true);
      expect(sessions.claimWorker(ref, 'next', 'review')).toBe(false);
      sessions.unclaimWorker('next', ref, 'review');
      expect(sessions.fenceRelease(ref, Date.now())).toBe(false);
      expect(db.prepare('SELECT role FROM neo_todo_roles WHERE todo_id = ?').all('next')).toEqual([
        { role: 'do' },
      ]);
    });

    test('a worker a failed or queued todo still holds cannot be claimed', () => {
      bind('failed-owner', 'w-done', 'done');
      store.updateTodo(
        store.getTodo('failed-owner')!,
        { state: 'blocked', blockedBy: 'failure' },
        3
      );
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

    test('reads ownership once for multiple finished workers', () => {
      bind('finished-a', 'worker-a', 'done');
      bind('finished-b', 'worker-b', 'done');
      store.addTodo(
        'finished-foreign',
        'ask',
        { title: 'Foreign', doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
        1
      );
      sessions.create('finished-foreign', { verb: 'start', adapter: 'claude-desktop' });
      sessions.recordRef('finished-foreign', { adapter: 'claude-desktop', id: 'foreign' });
      const now = Date.now();
      for (const id of ['finished-a', 'finished-b', 'finished-foreign'])
        store.updateTodo(store.getTodo(id)!, { state: 'done', finishedAt: now }, now);
      expect([...readFreeWorkers(db, 'claude-desktop')].sort()).toEqual(['worker-a', 'worker-b']);
      const prepare = db.prepare;
      let ownershipQueries = 0;
      db.prepare = ((sql: string) => {
        if (sql.includes('work_started_sessions')) ownershipQueries++;
        return prepare.call(db, sql);
      }) as typeof db.prepare;
      try {
        const rows = sessions.finishedWorkers(now - 1);
        expect(rows.map((row) => [row.todoId, row.owned]).sort()).toEqual([
          ['finished-a', true],
          ['finished-b', true],
          ['finished-foreign', false],
        ]);
        expect(ownershipQueries).toBe(1);
      } finally {
        db.prepare = prepare;
      }
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

    test('reads same-ask recency from the todos a worker was bound to', () => {
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

describe('retired session strategy migration', () => {
  test('deletes only retired coding preferences and preserves copied settings', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES ('coding', 'global', '', 'sessionStrategy', '"per_pr"', 'human', 1),
      ('coding', 'repo', 'example/repo', 'sessionStrategy', '"per_task"', 'human', 1),
      ('coding', 'project', 'orphan', 'sessionStrategy', '"long_lived"', 'human', 1),
      ('coding', 'global', '', 'watchedRepos', '[]', 'human', 1),
      ('core', 'project', 'project', 'sessionReuse', '"per_todo"', 'human', 1),
      ('other', 'global', '', 'sessionStrategy', '"other"', 'human', 1);
      DELETE FROM migration_markers WHERE key = 'migration_528'`);
    runMigrations(db, () => {});
    const rows = db.prepare('SELECT pack, key FROM neo_pack_preferences ORDER BY pack, key').all();
    expect(rows).toEqual([
      { pack: 'coding', key: 'watchedRepos' },
      { pack: 'core', key: 'sessionReuse' },
      { pack: 'other', key: 'sessionStrategy' },
    ]);
    db.close();
  });
});

describe('session reuse preference migration', () => {
  test('a global coding preference does not become a global core preference', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES ('coding', 'global', '', 'sessionStrategy', '"per_pr"', 'human', 1);
      DELETE FROM migration_markers WHERE key = 'migration_525'`);
    runMigrations(db, () => {});
    expect(
      db
        .prepare(
          "SELECT value_json FROM neo_pack_preferences WHERE pack = 'core' AND scope_kind = 'global' AND key = 'sessionReuse'"
        )
        .get()
    ).toBeNull();
    expect(
      db
        .prepare(
          "SELECT value_json AS value FROM neo_pack_preferences WHERE pack = 'coding' AND scope_kind = 'global' AND key = 'sessionStrategy'"
        )
        .get()
    ).toEqual({ value: '"per_pr"' });
    db.close();
  });

  test.each([
    ['example/project', 'repository:github.com/example/project', 'per_pr', 'per_todo'],
    ['github.com/example/project', 'repository:github.com/example/project', 'per_pr', 'per_todo'],
    ['github.com/example/project', 'repo:example/project\u0000host', 'per_task', 'per_todo'],
    [
      'github.com/example/project',
      'repository:github.com/example/project',
      'long_lived',
      'long_lived',
    ],
  ])('copies %s using %s and preserves the original', (repo, alias, strategy, expected) => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec(`INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at)
      VALUES ('project', 'Project', '', '', 1, 1, 1)`);
    db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
      alias,
      'project'
    );
    db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES ('coding', 'repo', ?, 'sessionStrategy', ?, 'human', 1)`).run(
      repo,
      JSON.stringify(strategy)
    );
    db.exec("DELETE FROM migration_markers WHERE key = 'migration_525'");
    runMigrations(db, () => {});
    expect(
      db
        .prepare(`SELECT value_json AS value FROM neo_pack_preferences
      WHERE pack = 'core' AND scope_kind = 'project' AND scope_key = 'project'
      AND key = 'sessionReuse'`)
        .get()
    ).toEqual({ value: JSON.stringify(expected) });
    expect(
      db
        .prepare(`SELECT value_json AS value FROM neo_pack_preferences
      WHERE pack = 'coding' AND scope_kind = 'repo' AND scope_key = ?
      AND key = 'sessionStrategy'`)
        .get(repo)
    ).toEqual({ value: JSON.stringify(strategy) });
    db.close();
  });
});
