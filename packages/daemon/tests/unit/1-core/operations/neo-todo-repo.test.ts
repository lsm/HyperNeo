import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { codingTodoRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { neoTodoRepo } from '../../../../src/lib/neo/todo-repo.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const draft = {
  title: 'Fix it',
  doneWhen: 'Merged',
  check: null,
  instruction: null,
  named: null,
  start: false,
};
const coding = {
  id: 'coding',
  todos: { repository: codingTodoRepository },
} as unknown as NeoPack;
const place = {
  machine: 'laptop',
  name: 'ops',
  folder: '/focus/ops',
  remotes: ['git@github.com:lsm/Ops.git'],
};

describe('codingTodoRepository', () => {
  test('reads the repo of a named pull request, then of a named repository', () => {
    expect(
      codingTodoRepository({
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/lsm/HyperNeo/pull/7650'] },
        },
        named: null,
      })
    ).toBe('github.com/lsm/hyperneo');
    expect(
      codingTodoRepository({ check: null, named: { repository: 'lsm/open-agent-protocol' } })
    ).toBe('github.com/lsm/open-agent-protocol');
    expect(codingTodoRepository({ check: null, named: { engine: 'codex' } })).toBeNull();
  });
});

describe('neoTodoRepo', () => {
  test('prefers the pack, then the start place’s git remote, then the ask’s repo', () => {
    const pr = {
      ...draft,
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/lsm/HyperNeo/pull/1'] },
      },
    };
    const started = {
      ...draft,
      instruction: 'Go',
      target: { verb: 'start' as const, adapter: 'hyperneo', place },
    };
    expect(neoTodoRepo(pr, [coding], { repo: 'github.com/lsm/ops' })).toBe(
      'github.com/lsm/hyperneo'
    );
    expect(neoTodoRepo(started, [coding], { repo: null })).toBe('github.com/lsm/ops');
    expect(neoTodoRepo(draft, [coding], { repo: 'github.com/lsm/makai' })).toBe(
      'github.com/lsm/makai'
    );
    expect(neoTodoRepo(draft, [coding], { repo: null })).toBeNull();
  });
});

describe('neo.todo.add repo', () => {
  test('stores the derived repo on the todo, and on an ask that had none', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Attach PRs',
      request: 'Attach PRs',
      createdAt: 1,
    });
    const add = createNeoTodoOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        start: async () => ({ ok: false as const, reason: 'no' }),
        proceed: async () => ({ ok: false as const, reason: 'no' }),
        retry: async () => ({ ok: false as const, reason: 'no' }),
        stop: async () => null,
      },
      () => [coding]
    ).find((op) => op.name === 'neo.todo.add')!;
    const call = async (input: unknown) =>
      (await add.execute(add.inputSchema.parse(input), {
        source: 'mcp',
        sessionId: 'neo',
        role: 'neo',
      })) as { ok: true; todo: NeoTodo };
    const first = await call({
      askId: 'ask',
      ...draft,
      named: { repository: 'lsm/HyperNeo' },
    });
    expect(first.todo.repo).toBe('github.com/lsm/hyperneo');
    expect(store.getAsk('ask')?.repo).toBe('github.com/lsm/hyperneo');
    const second = await call({ askId: 'ask', ...draft, title: 'Deploy' });
    expect(second.todo.repo).toBe('github.com/lsm/hyperneo');
    db.close();
  });
});

describe('neo.ask.open repo', () => {
  test('returns the ask with the repo its first todo gave it', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const open = createNeoAskRecordOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        start: async () => ({ ok: false as const, reason: 'no' }),
        proceed: async () => ({ ok: false as const, reason: 'no' }),
        retry: async () => ({ ok: false as const, reason: 'no' }),
        stop: async () => null,
      },
      () => null,
      () => true,
      () => [],
      () => [coding]
    ).find((op) => op.name === 'neo.ask.open')!;
    const receipt = (await open.execute(
      open.inputSchema.parse({
        title: 'Fix login',
        request: 'Fix login',
        todos: [{ ...draft, named: { repository: 'lsm/HyperNeo' } }],
      }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    )) as { ok: true; ask: { repo: string | null } };
    expect(receipt.ask.repo).toBe('github.com/lsm/hyperneo');
    db.close();
  });
});

describe('repo child cards', () => {
  const pr = (repo: string, n: number) => ({
    ...draft,
    title: `PR ${repo} ${n}`,
    check: {
      pack: 'coding',
      kind: 'pr_merged',
      params: { urls: [`https://github.com/lsm/${repo}/pull/${n}`] },
    },
  });
  const controls = {
    start: async () => ({ ok: false as const, reason: 'no' }),
    proceed: async () => ({ ok: false as const, reason: 'no' }),
    retry: async () => ({ ok: false as const, reason: 'no' }),
    stop: async () => null,
  };
  function setup() {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const op = (
      ops: { name: string; inputSchema: { parse(v: unknown): unknown }; execute: Function }[],
      name: string
    ) => {
      const found = ops.find((item) => item.name === name)!;
      return async (input: unknown) =>
        found.execute(found.inputSchema.parse(input), {
          source: 'mcp',
          sessionId: 'neo',
          role: 'neo',
        });
    };
    const open = op(
      createNeoAskRecordOperations(
        store,
        sessions,
        controls,
        () => null,
        () => true,
        () => [],
        () => [coding]
      ),
      'neo.ask.open'
    );
    const add = op(
      createNeoTodoOperations(store, sessions, controls, () => [coding]),
      'neo.todo.add'
    );
    return { db, store, open, add };
  }

  test('a cross-repo request files each repo into a linked child card and settles itself', async () => {
    const { db, store, open } = setup();
    const request = {
      title: 'Attach open PRs',
      request: 'Attach the open PRs',
      todos: [pr('HyperNeo', 1), pr('open-agent-protocol', 2), pr('HyperNeo', 3)],
    };
    const receipt = (await open(request)) as {
      ask: { id: string; status: string; outcome: string };
    };
    const children = store.listChildAsks(receipt.ask.id);
    expect(children.map((child) => [child.title, child.repo, child.parentId])).toEqual([
      ['Attach open PRs · hyperneo', 'github.com/lsm/hyperneo', receipt.ask.id],
      [
        'Attach open PRs · open-agent-protocol',
        'github.com/lsm/open-agent-protocol',
        receipt.ask.id,
      ],
    ]);
    expect(children.map((child) => store.listTodos(child.id).length)).toEqual([2, 1]);
    expect(store.listTodos(receipt.ask.id)).toEqual([]);
    expect(receipt.ask).toMatchObject({
      status: 'done',
      outcome: 'Filed 3 todos across hyperneo, open-agent-protocol cards.',
    });
    await open(request);
    expect(
      store.listChildAsks(receipt.ask.id).map((child) => store.listTodos(child.id).length)
    ).toEqual([2, 1]);
    expect(
      await open({ ...request, todos: [...request.todos, { ...draft, title: 'Write notes' }] })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('ask_settled') });
    expect(store.listTodos(receipt.ask.id)).toEqual([]);
    expect(
      await open({ ...request, todos: [...request.todos, pr('HyperNeo', 5), pr('ops', 4)] })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('nothing was added') });
    expect(store.listChildAsks(receipt.ask.id)).toHaveLength(2);
    expect(
      store.listChildAsks(receipt.ask.id).map((child) => store.listTodos(child.id).length)
    ).toEqual([2, 1]);
    db.prepare("UPDATE neo_asks SET status = 'dropped' WHERE id = ?").run(receipt.ask.id);
    const reopened = (await open(request)) as { ask: { id: string } };
    expect(reopened.ask.id).not.toBe(receipt.ask.id);
    db.close();
  });

  test('a stray todo goes to a child card, and a card refuses another repo’s todo', async () => {
    const { db, store, open, add } = setup();
    const receipt = (await open({
      title: 'Fix login',
      request: 'Fix login',
      todos: [pr('HyperNeo', 1)],
    })) as {
      ask: { id: string; repo: string };
    };
    expect(receipt.ask.repo).toBe('github.com/lsm/hyperneo');
    const stray = (await add({ askId: receipt.ask.id, ...pr('ops', 9) })) as {
      todo: { askId: string; repo: string };
    };
    const child = store.getAsk(stray.todo.askId)!;
    expect(child).toMatchObject({
      title: 'Fix login · ops',
      parentId: receipt.ask.id,
      repo: 'github.com/lsm/ops',
    });
    expect(store.getAsk(receipt.ask.id)?.status).toBe('open');
    expect(() => store.addTodo('x', receipt.ask.id, draft, 1, 'github.com/lsm/ops')).toThrow(
      'todo_repo_mismatch'
    );
    db.close();
  });

  test('a retry that adds other repos keeps the card’s own repo on the card', async () => {
    const { db, store, open } = setup();
    const first = (await open({ title: 'T', request: 'T', todos: [pr('HyperNeo', 1)] })) as {
      ask: { id: string };
    };
    await open({
      title: 'T',
      request: 'T',
      todos: [pr('HyperNeo', 1), pr('HyperNeo', 2), pr('ops', 3)],
    });
    expect(store.listTodos(first.ask.id).map((todo) => todo.title)).toEqual([
      'PR HyperNeo 1',
      'PR HyperNeo 2',
    ]);
    expect(store.listChildAsks(first.ask.id).map((child) => child.repo)).toEqual([
      'github.com/lsm/ops',
    ]);
    expect(store.getAsk(first.ask.id)?.status).toBe('open');
    db.close();
  });

  test('a retry keeps a same-titled todo of another repo', async () => {
    const { db, store, open } = setup();
    const tests = (repo: string) => ({ ...pr(repo, 1), title: 'Write tests' });
    const first = (await open({
      title: 'T',
      request: 'T',
      todos: [tests('HyperNeo'), pr('ops', 2)],
    })) as {
      ask: { id: string };
    };
    await open({
      title: 'T',
      request: 'T',
      todos: [tests('HyperNeo'), pr('ops', 2), tests('ops')],
    });
    expect(
      store
        .listChildAsks(first.ask.id)
        .map((child) => store.listTodos(child.id).map((todo) => todo.title))
    ).toEqual([['Write tests'], ['PR ops 2', 'Write tests']]);
    db.close();
  });

  test('a retry that gives a repo-less todo a repo files it, not absorbs it', async () => {
    const { db, store, open } = setup();
    const notes = { ...draft, title: 'Notes' };
    const first = (await open({ title: 'N', request: 'N', todos: [notes] })) as {
      ask: { id: string };
    };
    await open({ title: 'N', request: 'N', todos: [notes, { ...pr('ops', 7), title: 'Notes' }] });
    expect(store.listTodos(first.ask.id).map((todo) => [todo.title, todo.repo])).toEqual([
      ['Notes', null],
      ['Notes', 'github.com/lsm/ops'],
    ]);
    db.close();
  });
});
