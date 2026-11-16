import { describe, expect, test } from 'bun:test';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { ChangeRecorder } from '../../../../src/storage/db-gateway/db-op.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { workCleanupReads } from '../../../../src/storage/repositories/work-cleanup-worker.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ref = { adapter: 'hyperneo', id: 'worker' };
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Cleanup',
    request: 'Cleanup',
    createdAt: 1,
  });
  const bind = (id: string, target: NeoDriverTarget, done = true, recorded = true) => {
    const todo = todos.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Done', instruction: null, named: null, check: null },
      1
    );
    sessions.create(id, target);
    if (recorded)
      db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
        JSON.stringify(ref),
        id
      );
    if (done) todos.updateTodo(todo, { state: 'done', finishedAt: 2 }, 2);
  };
  const owners = (refs?: (typeof ref)[]) =>
    workCleanupReads.run(
      db,
      {
        method: 'owners',
        args: refs ? [refs] : [],
      },
      new ChangeRecorder()
    );
  return { db, bind, owners };
}

describe('workCleanupReads', () => {
  test('named and non-start bindings do not grant folder ownership', () => {
    const { db, bind, owners } = setup();
    try {
      bind('named', { verb: 'start', adapter: 'hyperneo', name: 'human' });
      bind('sent', { verb: 'send', ref });
      expect(owners()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a live non-start binding keeps an owned worker, including an unrecorded target ref', () => {
    const { db, bind, owners } = setup();
    try {
      bind('owned', { verb: 'start', adapter: 'hyperneo' });
      bind('live', { verb: 'send', ref }, false, false);
      expect(owners()).toMatchObject([{ todoId: 'owned', owner: { boundToLiveTodo: true } }]);
    } finally {
      db.close();
    }
  });

  test('a focused owner refresh excludes unrelated workers and deduplicates the session row', () => {
    const { db, bind, owners } = setup();
    try {
      bind('owned', { verb: 'start', adapter: 'hyperneo' });
      db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path)
        VALUES ('worker','Worker','/work','now','now','archived','{}','{}','/work/tree')`).run();
      expect(owners([ref])).toHaveLength(1);
      expect(owners([{ adapter: 'hyperneo', id: 'unrelated' }])).toEqual([]);
      expect(owners([])).toEqual([]);
    } finally {
      db.close();
    }
  });
});
