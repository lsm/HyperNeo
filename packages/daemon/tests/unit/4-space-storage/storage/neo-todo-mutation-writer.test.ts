import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { neoTodoMutations } from '../../../../src/storage/repositories/neo-todo-mutation-writes.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Commit = InstanceType<typeof neoTodoMutations.Repository>['commit'];
const url = (number: number) => `https://github.com/example/repo/pull/${number}`;

describe('Neo todo mutation writer admission', () => {
  let db: Database;
  let gateway: DbGateway;
  let todos: NeoAskTodoRepository;
  let prs: CodingTodoPrRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    gateway = new DbGateway(':memory:', db);
    todos = new NeoAskTodoRepository(db);
    prs = new CodingTodoPrRepository(db);
    todos.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Atomic mutations',
      request: 'Preserve admission',
      createdAt: 1,
    });
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const todo = (id: string, urls: string[] = []) =>
    todos.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls } },
        instruction: 'Complete synthetic work',
        named: null,
      },
      1
    );
  const commit = (input: Parameters<Commit>[0], checked?: Parameters<Commit>[1]) =>
    gateway.call(neoTodoMutations, 'commit', structuredClone(input), structuredClone(checked), 10);
  const question = () =>
    todos.askQuestion(
      'pending',
      'ask',
      {
        text: 'Awaiting human',
        kind: 'reply',
        todoId: 'first',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: null,
      },
      2
    );

  test('a title edit retains the current state and returns the ordered sibling list', async () => {
    const first = todo('first', [url(1)]);
    todo('second');
    todos.updateTodo(first, { state: 'closed_unverified', reason: 'Still unverified' }, 2);
    const result = await commit({ kind: 'edit', todoId: 'first', title: 'Current title' });
    expect(result).toMatchObject({
      ok: true,
      todo: { title: 'Current title', state: 'closed_unverified', reason: 'Still unverified' },
      startNext: 'second',
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.todos.map((row) => row.id)).toEqual(['first', 'second']);
    expect(todos.getTodo('first')?.title).toBe('Current title');
    expect(todos.getTodo('second')?.state).toBe('todo');
  });

  test('serialized duplicate edits retain the current ownership record without blocking', async () => {
    todo('first');
    todo('second');
    const results = await Promise.all(
      ['first', 'second'].map((todoId) => commit({ kind: 'edit', todoId, addUrls: [url(2)] }))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter(
        (result) =>
          result.ok && result.records?.some((record) => record.startsWith('pr_already_tracked:'))
      )
    ).toHaveLength(1);
    expect(
      todos.listTodos('ask').filter((row) => {
        const urls = row.check?.params.urls;
        return Array.isArray(urls) && urls.includes(url(2));
      })
    ).toHaveLength(2);
  });

  test('simultaneous additions to one todo retain every required URL', async () => {
    todo('first', [url(1)]);
    await Promise.all(
      [2, 3].map((number) => commit({ kind: 'edit', todoId: 'first', addUrls: [url(number)] }))
    );
    expect(todos.getTodo('first')?.check?.params.urls).toEqual([url(1), url(2), url(3)]);
  });

  test('recorded ownership committed after a caller snapshot is retained without blocking', async () => {
    todo('first', [url(1)]);
    todo('owner');
    prs.claim('owner', [{ url: url(2), claim: 'branch' }], 2);
    expect(await commit({ kind: 'edit', todoId: 'first', addUrls: [url(2)] })).toMatchObject({
      ok: true,
      records: [expect.stringContaining('todo owner')],
    });
    expect(todos.getTodo('first')?.check?.params.urls).toEqual([url(1), url(2)]);
  });

  test.each(['done', 'closed_unverified', 'failed', 'removed'] as const)(
    'a %s peer does not reserve its PR',
    async (state) => {
      const owner = todo('owner', [url(2)]);
      prs.claim(owner.id, [{ url: url(2), claim: 'branch' }], 2);
      todos.updateTodo(owner, { state }, 3);
      todo('first');
      expect(await commit({ kind: 'edit', todoId: 'first', addUrls: [url(2)] })).toMatchObject({
        ok: true,
      });
    }
  );

  test.each([true, false])(
    'closure rejects a changed check even when the old observation was done=%s',
    async (done) => {
      const first = todo('first', [url(1)]);
      await commit({ kind: 'edit', todoId: first.id, addUrls: [url(2)] });
      expect(
        await commit(
          { kind: 'close', todoId: first.id, reason: 'Old observation' },
          { check: first.check, result: { done, evidence: 'Old PR result' } }
        )
      ).toMatchObject({ ok: false, reason: expect.stringContaining('todo_changed') });
      expect(todos.getTodo(first.id)).toMatchObject({
        state: 'todo',
        check: { params: { urls: [url(1), url(2)] } },
      });
    }
  );

  test('an unmet check closes unverified, and only a matching passed check marks done', async () => {
    const first = todo('first', [url(1)]);
    expect(
      await commit(
        { kind: 'close', todoId: first.id, reason: 'Work reported' },
        { check: first.check, result: { done: false, evidence: null } }
      )
    ).toMatchObject({ ok: true, todo: { state: 'closed_unverified' } });
    expect(
      await commit(
        { kind: 'close', todoId: first.id, reason: 'Verified merged' },
        { check: first.check, result: { done: true, evidence: 'PR merged' } }
      )
    ).toMatchObject({ ok: true, todo: { state: 'done', evidence: 'Verified merged' } });
  });

  test('a human card added while an external check runs still refuses closure', async () => {
    const first = todo('first', [url(1)]);
    question();
    expect(
      await commit(
        { kind: 'close', todoId: first.id, reason: 'Merged' },
        { check: first.check, result: { done: true, evidence: 'PR merged' } }
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('card_unanswered') });
    expect(todos.getQuestion('pending')?.state).toBe('open');
    expect(todos.getTodo(first.id)?.state).toBe('todo');
  });

  test('a settled ask and an already removed todo are refused without changing rows', async () => {
    const first = todo('first', [url(1)]);
    todos.updateTodo(first, { state: 'removed' }, 2);
    expect(await commit({ kind: 'edit', todoId: first.id, title: 'Late edit' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todo_removed'),
    });
    db.prepare("UPDATE neo_asks SET status='done' WHERE id='ask'").run();
    expect(
      await commit({ kind: 'remove', todoId: first.id, reason: 'Late removal' })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('ask_settled') });
    expect(todos.getTodo(first.id)?.title).toBe('first');
    expect(await commit({ kind: 'edit', todoId: 'missing', title: 'Missing' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_found'),
    });
  });

  test('replacement must still be another todo on the same ask at commit time', async () => {
    todo('first');
    for (const replacedBy of ['first', 'missing'])
      expect(
        await commit({ kind: 'remove', todoId: 'first', reason: 'Replaced', replacedBy })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('replacement_missing') });
    todo('second');
    expect(
      await commit({ kind: 'remove', todoId: 'first', reason: 'Replaced', replacedBy: 'second' })
    ).toMatchObject({ ok: true, todo: { state: 'removed', replacedBy: 'second' } });
  });

  test('a refused ask stamp rolls back pruning and the entire todo change', async () => {
    const first = todo('first', [url(1)]);
    todos.updateTodo(first, { state: 'doing', startedAt: 2 }, 2);
    todos.askQuestion(
      'stale-start',
      'ask',
      {
        text: 'Start first?',
        kind: 'start',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: [first.id],
      },
      3
    );
    const before = todos.getTodo(first.id);
    db.exec(
      "CREATE TRIGGER refuse_mutation_stamp BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic mutation refusal'); END"
    );
    await expect(
      commit({ kind: 'edit', todoId: first.id, title: 'Must roll back' })
    ).rejects.toThrow('synthetic mutation refusal');
    expect(todos.getTodo(first.id)).toEqual(before);
    expect(todos.getQuestion('stale-start')?.state).toBe('open');
  });

  test('reported evidence survives DTO cloning, persistence and the command reply in full', async () => {
    todo('first', [url(1)]);
    const report = 'Complete synthetic result 🦊\n'.repeat(20000);
    const result = await commit({
      kind: 'edit',
      todoId: 'first',
      done: 'reported',
      evidence: report,
    });
    expect(structuredClone(result)).toMatchObject({
      ok: true,
      todo: { report, state: 'closed_unverified' },
    });
    expect(todos.getTodo('first')?.report).toBe(report);
  });
});
