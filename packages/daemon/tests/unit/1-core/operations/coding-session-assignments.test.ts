import { describe, expect, test } from 'bun:test';
import { codingSessionAssignmentReads } from '../../../../src/lib/neo/packs/coding/session-assignments-worker.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runDbOpOn } from '../../helpers/run-db-op.ts';

const ref = (id: string) => ({ adapter: 'claude-desktop', id });
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Feature',
    request: 'Build',
    createdAt: 1,
  });
  createCodingTodoPack(new CodingTodoPrRepository(db), async () => []).schema(db);
  const todo = () =>
    todos.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Slice', doneWhen: 'Merged', check: null, instruction: 'Do it', named: null },
      1
    ).id;
  const run = runDbOpOn(db);
  const assignments = {
    actorRefs: (input?: { adapter?: string }) =>
      run(codingSessionAssignmentReads, { method: 'actorRefs', args: [input] }),
  };
  return { db, todo, assignments };
}

describe('coding actor exclusions', () => {
  test('review and qa actor refs are listed for worker exclusion', async () => {
    const { db, assignments, todo } = setup();
    const author = todo();
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)`
    ).run(
      author,
      'assignment:github.com/synthetic/repo/pull/7:head:review',
      JSON.stringify({
        url: 'github.com/synthetic/repo/pull/7',
        head: 'head',
        acceptanceContract: 'contract',
        newDispatch: true,
        write: ref('author'),
        actor: { kind: 'agent', id: 'reviewer', model: 'm', harness: 'claude-desktop' },
        ref: ref('reviewer'),
      })
    );
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)`
    ).run(
      author,
      'assignment:github.com/synthetic/repo/pull/7:head:qa',
      JSON.stringify({
        url: 'github.com/synthetic/repo/pull/7',
        head: 'head',
        acceptanceContract: 'contract',
        newDispatch: true,
        write: ref('author'),
        actor: { kind: 'agent', id: 'verifier', model: 'm', harness: 'claude-desktop' },
        ref: ref('verifier'),
      })
    );
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)`
    ).run(
      author,
      'assignment:github.com/synthetic/repo/pull/7:head3:review',
      JSON.stringify({
        url: 'github.com/synthetic/repo/pull/7',
        head: 'head3',
        acceptanceContract: 'contract',
        newDispatch: true,
        write: ref('author'),
        actor: { kind: 'agent', id: 'reviewer', model: 'm', harness: 'claude-desktop' },
        ref: ref('reviewer'),
      })
    );
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)`
    ).run(
      author,
      'assignment:github.com/synthetic/repo/pull/7:head2:review',
      JSON.stringify({
        url: 'github.com/synthetic/repo/pull/7',
        head: 'head2',
        acceptanceContract: 'contract',
        newDispatch: true,
        write: ref('author'),
        bot: 'hyperneo-ai-test',
      })
    );
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)`
    ).run(
      author,
      'assignment:github.com/synthetic/repo/pull/7:head4:review',
      JSON.stringify({
        url: 'github.com/synthetic/repo/pull/7',
        head: 'head4',
        acceptanceContract: 'contract',
        newDispatch: true,
        write: ref('author'),
        actor: { kind: 'agent', id: 'other-adapter', model: 'm', harness: 'codex-desktop' },
        ref: { adapter: 'codex-desktop', id: 'other-adapter' },
      })
    );
    expect(await assignments.actorRefs()).toEqual([
      { adapter: 'codex-desktop', id: 'other-adapter' },
      ref('reviewer'),
      ref('verifier'),
    ]);
    expect(await assignments.actorRefs({ adapter: 'claude-desktop' })).toEqual([
      ref('reviewer'),
      ref('verifier'),
    ]);
  });
});
