import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  codingSessionAssignmentReads,
  codingSessionAssignmentWrites,
} from '../../../../src/lib/neo/packs/coding/session-assignments-worker.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runDbOpOn } from '../../helpers/run-db-op.ts';

const ref = (id: string) => ({ adapter: 'claude-desktop', id });
const url = 'https://github.com/synthetic/repo/pull/7';
const pr = (state: NeoWorkPr['state']): NeoWorkPr => ({
  url,
  state,
  checks: 'passing',
  review: 'none',
});

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
    request: 'Build the feature',
    createdAt: 1,
  });
  const prs = new CodingTodoPrRepository(db);
  createCodingTodoPack(prs, async () => []).schema(db);
  const todo = () =>
    todos.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Slice', doneWhen: 'Merged', check: null, instruction: 'Do it', named: null },
      1
    ).id;
  const started = (todoId: string, session: string) =>
    db
      .prepare(
        `INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)
         ON CONFLICT(todo_id) DO UPDATE SET ref = excluded.ref`
      )
      .run(todoId, JSON.stringify({ verb: 'start' }), JSON.stringify(ref(session)));
  const sent = (todoId: string, session: string) =>
    db
      .prepare('INSERT INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)')
      .run(todoId, JSON.stringify({ verb: 'send', ref: ref(session) }));
  const run = runDbOpOn(db);
  const assignments = {
    reserveFeature: (input: {
      repo: string;
      featureKey: string;
      todoId: string;
      now: number;
      replace?: { todoId: string; ref: { adapter: string; id: string; daemon?: string } };
    }) =>
      run(codingSessionAssignmentWrites, { method: 'reserveFeature', args: [input] }) as Promise<{
        todoId: string;
        ref: { adapter: string; id: string } | null;
      }>,
    owner: (input: {
      strategy: 'long_lived' | 'per_task' | 'per_pr';
      repo: string;
      featureKey: string;
      todoId: string;
      prUrl?: string;
    }) => run(codingSessionAssignmentReads, { method: 'owner', args: [input] }),
    actorRefs: () => run(codingSessionAssignmentReads, { method: 'actorRefs', args: [] }),
  };
  return { db, prs, todo, started, sent, assignments };
}

describe('durable session assignments', () => {
  test('two todos of one feature share the first reservation, through retries and the start', async () => {
    const { assignments, todo, started } = setup();
    const [first, second] = [todo(), todo()];
    const feature = { repo: 'Synthetic/Repo', featureKey: 'ask', now: 1 };
    expect(await assignments.reserveFeature({ ...feature, todoId: first })).toEqual({
      todoId: first,
      ref: null,
    });
    expect(await assignments.reserveFeature({ ...feature, todoId: second })).toEqual({
      todoId: first,
      ref: null,
    });
    expect(await assignments.reserveFeature({ ...feature, todoId: first, now: 2 })).toEqual({
      todoId: first,
      ref: null,
    });
    started(first, 'backend');
    const lookup = { strategy: 'long_lived', repo: 'synthetic/repo', featureKey: 'ask' } as const;
    expect(await assignments.owner({ ...lookup, todoId: second })).toEqual({
      todoId: first,
      ref: ref('backend'),
    });
    expect(
      await assignments.owner({ ...lookup, repo: 'synthetic/other', todoId: second })
    ).toBeNull();
  });

  test('concurrent dispatches of one feature agree on a single owner', async () => {
    const { assignments, todo } = setup();
    const todos = [todo(), todo(), todo()];
    const owners = await Promise.all(
      todos.map((todoId) =>
        assignments.reserveFeature({ repo: 'synthetic/repo', featureKey: 'f', todoId, now: 1 })
      )
    );
    expect(new Set(owners.map((owner) => owner.todoId)).size).toBe(1);
    expect(todos).toContain(owners[0].todoId);
  });

  test('a feature bound to an idle session reads that session before the send reports', async () => {
    const { assignments, todo, sent } = setup();
    const first = todo();
    await assignments.reserveFeature({
      repo: 'synthetic/repo',
      featureKey: 'ask',
      todoId: first,
      now: 1,
    });
    sent(first, 'frontend');
    expect(
      await assignments.owner({
        strategy: 'long_lived',
        repo: 'synthetic/repo',
        featureKey: 'ask',
        todoId: todo(),
      })
    ).toEqual({ todoId: first, ref: ref('frontend') });
  });

  test('per-task work owns only its own session; a feature reservation does not move it', async () => {
    const { assignments, todo, started } = setup();
    const [first, second] = [todo(), todo()];
    await assignments.reserveFeature({
      repo: 'synthetic/repo',
      featureKey: 'ask',
      todoId: first,
      now: 1,
    });
    started(first, 'dev-1');
    const lookup = { strategy: 'per_task', repo: 'synthetic/repo', featureKey: 'ask' } as const;
    expect(await assignments.owner({ ...lookup, todoId: second })).toBeNull();
    started(second, 'dev-2');
    expect(await assignments.owner({ ...lookup, todoId: second })).toEqual({
      todoId: second,
      ref: ref('dev-2'),
    });
  });

  test('per-PR review work returns to the session that holds the PR; new PRs get their own slot', async () => {
    const { assignments, prs, todo, started } = setup();
    const [author, fixer, other] = [todo(), todo(), todo()];
    started(author, 'pr-7');
    prs.record(author, [pr('OPEN')], 1);
    const lookup = { strategy: 'per_pr', repo: 'synthetic/repo', featureKey: 'ask' } as const;
    expect(await assignments.owner({ ...lookup, todoId: fixer, prUrl: `${url}/` })).toEqual({
      todoId: author,
      ref: ref('pr-7'),
    });
    expect(await assignments.owner({ ...lookup, todoId: other })).toBeNull();
    started(other, 'pr-8');
    expect(await assignments.owner({ ...lookup, todoId: other })).toEqual({
      todoId: other,
      ref: ref('pr-8'),
    });
  });

  test('a link that is not a PR never resolves to the owner of another non-PR link', async () => {
    const { assignments, prs, todo, started } = setup();
    const [author, fixer] = [todo(), todo()];
    started(author, 'docs');
    prs.record(author, [{ ...pr('OPEN'), url: 'https://example.test/notes/a' }], 1);
    expect(
      await assignments.owner({
        strategy: 'per_pr',
        repo: 'synthetic/repo',
        featureKey: 'ask',
        todoId: fixer,
        prUrl: 'https://example.test/notes/b',
      })
    ).toBeNull();
  });

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
    expect(await assignments.actorRefs()).toEqual([ref('reviewer'), ref('verifier')]);
  });

  test('a takeover replaces only the exact session it saw, daemon included', async () => {
    const { db, assignments, todo, started } = setup();
    const [first, second, third] = [todo(), todo(), todo()];
    const feature = { repo: 'synthetic/repo', featureKey: 'ask', now: 1 };
    await assignments.reserveFeature({ ...feature, todoId: first });
    started(first, 'backend');
    const seen = { todoId: first, ref: ref('backend') };
    db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
      JSON.stringify({ ...ref('backend'), daemon: 'other' }),
      first
    );
    expect(
      (await assignments.reserveFeature({ ...feature, todoId: second, replace: seen })).todoId
    ).toBe(first);
    started(first, 'backend');
    expect(
      (await assignments.reserveFeature({ ...feature, todoId: third, replace: seen })).todoId
    ).toBe(third);
  });
});
