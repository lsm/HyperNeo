import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import {
  readNeoTodoCompletion,
  requireNeoTodoMayFinish,
} from '../../../../src/lib/neo/todo-completion.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { runMigration396 } from '../../../../src/storage/schema/m396-neo-todo-pr-merged-check.ts';
import { runMigration458 } from '../../../../src/storage/schema/m458-neo-todo-closed-unverified.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo', role: 'neo' };
const url = (n: number) => `https://github.com/lsm/HyperNeo/pull/${n}`;

function setup(stop: () => Promise<string | null> = async () => null, judged = false) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'Two PRs',
    request: 'Land both PRs',
    createdAt: 1,
  });
  const states = new Map<number, NeoWorkPr['state']>([
    [1, 'MERGED'],
    [2, 'OPEN'],
  ]);
  const read = async (urls: readonly string[]): Promise<NeoWorkPr[]> =>
    urls.map((item) => {
      const n = Number(item.split('/').pop());
      return { url: item, state: states.get(n) ?? 'OPEN', checks: 'passing', review: 'none' };
    });
  const repo = new CodingTodoPrRepository(db);
  const todos = createCodingTodoPack(repo, read);
  const coding: NeoPack & { todos: typeof todos } = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    todos,
    ...(judged ? { readFacts: todos.readFacts, judge: todos.judge } : {}),
  };
  coding.todos.schema(db);
  const told: string[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: async () => ({ kind: 'completed', value: null }) as never,
    packs: () => [coding],
    tell: async (_ask, _todo, note) => {
      told.push(note);
    },
    changed: () => {},
  });
  const ops = Object.fromEntries(
    createNeoTodoOperations(
      store,
      sessions,
      {
        resolveTarget: existingTodoTarget,
        recompute: runner.recompute,
        start: async () => ({ ok: false as const, reason: 'not started' }),
        proceed: async () => ({ ok: false as const, reason: 'no session' }),
        retry: async () => ({ ok: false as const, reason: 'not failed' }),
        stop,
      },
      () => [coding],
      () => null
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), owner)) as
      | { ok: true; todo: NeoTodo }
      | { ok: false; reason: string };
  return { db, store, states, runner, call, told, coding, repo };
}

describe('one completion rule for Neo todos', () => {
  test('upgrading preserves existing todos, dependent rows and indexes', () => {
    const db = new Database(':memory:');
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, state TEXT CHECK (state IN ('todo', 'doing', 'blocked', 'done', 'failed', 'removed')));
      CREATE TABLE links (todo_id TEXT REFERENCES neo_todos(id));
      CREATE INDEX todo_state ON neo_todos(state);
      INSERT INTO neo_todos VALUES ('existing', 'doing');
      INSERT INTO links VALUES ('existing');`);
    runMigration458(db);
    runMigration458(db);
    expect(db.prepare('SELECT * FROM neo_todos').get()).toEqual({ id: 'existing', state: 'doing' });
    db.exec("UPDATE neo_todos SET state = 'closed_unverified'");
    expect(db.prepare('SELECT todo_id FROM links').get()).toEqual({ todo_id: 'existing' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'todo_state'").get()).toEqual({
      name: 'todo_state',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test.each([false, true])(
    'a done request on an unmet check blocks the todo until the check passes (judged: %p)',
    async (judged) => {
      const { db, store, states, runner, call } = setup(undefined, judged);
      db.prepare(
        `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, state, created_at, updated_at)
       VALUES ('t', 'ask', 0, 'Land both', 'Both merged', ?, 'doing', 1, 1)`
      ).run(
        JSON.stringify({ pack: 'coding', kind: 'pr_opened', params: { urls: [url(1), url(2)] } })
      );
      runMigration396(db);
      expect(store.getTodo('t')?.check?.kind).toBe('pr_merged');
      const blocked = {
        state: 'blocked',
        blockedBy: 'check',
        blockedReason: 'check_unmet: "Both merged" has not passed.',
        finishedAt: null,
      };

      expect(
        await call('neo.todo.edit', { todoId: 't', done: 'met', evidence: 'Both opened' })
      ).toMatchObject({ ok: true, todo: blocked });
      expect(await call('neo.todo.close', { todoId: 't', reason: 'Looks done' })).toMatchObject({
        ok: true,
        todo: blocked,
      });
      await runner.checkNow(['t'], () => {});
      expect(store.getTodo('t')).toMatchObject(blocked);
      expect(await call('neo.todo.edit', { todoId: 't', title: 'Land both PRs' })).toMatchObject({
        ok: true,
        todo: { ...blocked, title: 'Land both PRs' },
      });

      states.set(2, 'MERGED');
      await runner.checkNow(['t'], () => {});
      expect(store.getTodo('t')).toMatchObject({
        state: 'done',
        blockedBy: null,
        evidence: '#1 #2 merged',
      });
      db.close();
    }
  );

  test('a required PR closed unmerged with no replacement fails the todo for Neo to redo or drop', async () => {
    const { db, store, states, runner, call } = setup();
    const todo = store.addTodo(
      't',
      'ask',
      {
        title: 'Land both',
        doneWhen: 'Both merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url(1), url(2)] } },
        instruction: null,
        named: null,
      },
      1
    );
    states.set(2, 'CLOSED');
    const reason = '#2 closed without merging and no pull request replaced it';
    expect(await call('neo.todo.close', { todoId: todo.id, reason: 'done' })).toEqual({
      ok: true,
      todo: expect.objectContaining({
        state: 'blocked',
        blockedBy: 'check',
        blockedReason: `check_failed: ${reason}`,
      }),
      todos: expect.any(Array),
    });
    await runner.checkNow([todo.id], () => {});
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'failed', reason });
    db.close();
  });

  test('a todo without a pack rule stays blocked until Neo gives it a check', async () => {
    const { db, store, call, coding } = setup();
    const todo = store.addTodo(
      't',
      'ask',
      { title: 'Deploy', doneWhen: 'Running', check: null, instruction: null, named: null },
      1
    );
    expect(await readNeoTodoCompletion([coding], todo)).toBeNull();
    expect(requireNeoTodoMayFinish({ todo }, null)).toEqual({ value: { todo } });
    expect(await call('neo.todo.close', { todoId: todo.id, reason: 'Running' })).toMatchObject({
      ok: true,
      todo: {
        state: 'blocked',
        blockedBy: 'check',
        blockedReason: 'check_unmet: outcome has not passed.',
      },
    });
    db.close();
  });

  test('the core todo modules import nothing from the coding pack', () => {
    for (const file of ['todo-completion.ts', 'todo-operations.ts', 'todo-runner.ts']) {
      const source = readFileSync(
        new URL(`../../../../src/lib/neo/${file}`, import.meta.url),
        'utf8'
      );
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((path) => path.includes('packs/coding'))).toEqual([]);
    }
  });
});

describe('coding todo PR ownership through add and edit', () => {
  test('an unknown PR is recorded without certifying completion', async () => {
    const { db, store, call, runner } = setup();
    try {
      const added = await call('neo.todo.add', {
        askId: 'ask',
        title: 'PR not yet known',
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: {} },
      });
      expect(added).toMatchObject({
        ok: true,
        records: [expect.stringContaining('pr_merged_needs_urls:')],
      });
      if (!added.ok) throw new Error(added.reason);
      await runner.checkNow([added.todo.id], () => {});
      expect(store.getTodo(added.todo.id)?.state).not.toBe('done');
      expect(
        await call('neo.todo.close', { todoId: added.todo.id, reason: 'PR remains unidentified' })
      ).toMatchObject({ ok: true, todo: { state: 'blocked', blockedBy: 'check' } });
    } finally {
      db.close();
    }
  });

  const draft = (urls: string[] = []) => ({
    title: 'Original fix',
    doneWhen: 'Merged',
    check: { pack: 'coding', kind: 'pr_merged', params: { urls } },
    instruction: 'Land the fix',
    named: null,
  });
  test.each(['named', 'ledger'])(
    'records a duplicate of a live %s PR claim on the same ask',
    async (claim) => {
      const { db, store, call, coding } = setup();
      try {
        const original = store.addTodo(
          'original',
          'ask',
          draft(claim === 'named' ? [url(2)] : []),
          1
        );
        if (claim === 'ledger') await coding.todos.openedPrs!(original, [url(2)]);
        const result = await call('neo.todo.add', {
          askId: 'ask',
          title: 'Pin PR link',
          doneWhen: 'Merged',
          check: {
            pack: 'coding',
            kind: 'pr_merged',
            params: { urls: [url(2).replace('lsm/HyperNeo', 'LSM/HYPERNEO') + '/'] },
          },
        });
        expect(result).toMatchObject({
          ok: true,
          records: [expect.stringMatching(/pr_already_tracked:.*todo original "Original fix"/)],
        });
        expect(store.listTodos('ask')).toHaveLength(2);
      } finally {
        db.close();
      }
    }
  );
  test('editing pins URLs on the original check and the pack closes it only when all merge', async () => {
    const { db, store, call, runner, states, coding } = setup();
    try {
      const original = store.addTodo('original', 'ask', draft(), 1);
      await coding.todos.openedPrs!(original, [url(2)]);
      expect(
        await call('neo.todo.edit', { todoId: original.id, addUrls: [url(1), url(2), url(2)] })
      ).toMatchObject({
        ok: true,
        todo: {
          check: { params: { urls: [url(1).toLowerCase(), url(2).toLowerCase()] } },
          doneWhen: 'lsm/hyperneo#1, lsm/hyperneo#2 merged',
        },
      });
      await runner.checkNow([original.id], () => {});
      expect(store.getTodo(original.id)?.state).not.toBe('done');
      states.set(2, 'MERGED');
      await runner.checkNow([original.id], () => {});
      expect(store.getTodo(original.id)).toMatchObject({ state: 'done', evidence: '#1 #2 merged' });
    } finally {
      db.close();
    }
  });
  test.each(['named', 'ledger'])(
    'edit records URLs claimed by another live todo through %s',
    async (claim) => {
      const { db, store, call, coding } = setup();
      try {
        const owner = store.addTodo(
          'owner',
          'ask',
          { ...draft(claim === 'named' ? [url(2)] : []), title: 'Existing owner' },
          1
        );
        if (claim === 'ledger') await coding.todos.openedPrs!(owner, [url(2)]);
        const target = store.addTodo('target', 'ask', draft([url(1)]), 2);
        expect(await call('neo.todo.edit', { todoId: target.id, addUrls: [url(2)] })).toMatchObject(
          { ok: true, records: [expect.stringContaining('owner')] }
        );
        expect(store.getTodo(target.id)?.check?.params.urls).toEqual([
          url(1).toLowerCase(),
          url(2).toLowerCase(),
        ]);
      } finally {
        db.close();
      }
    }
  );
  test.each(['done', 'closed_unverified', 'failed', 'removed'] as const)(
    'a %s todo does not reserve the PR',
    async (state) => {
      const { db, store, call, coding } = setup();
      try {
        const old = store.addTodo('old', 'ask', draft([url(2)]), 1);
        await coding.todos.openedPrs!(old, [url(2)]);
        store.updateTodo(old, { state }, 2);
        expect(
          await call('neo.todo.add', { askId: 'ask', ...draft([url(2)]), instruction: null })
        ).toMatchObject({
          ok: true,
        });
      } finally {
        db.close();
      }
    }
  );
  test('concurrent edits both record the same PR', async () => {
    const { db, store, call } = setup();
    try {
      store.addTodo('one', 'ask', draft(), 1);
      store.addTodo('two', 'ask', draft(), 2);
      const results = await Promise.all(
        ['one', 'two'].map((todoId) => call('neo.todo.edit', { todoId, addUrls: [url(2)] }))
      );
      expect(results.filter((result) => result.ok)).toHaveLength(2);
    } finally {
      db.close();
    }
  });
  test('concurrent URL additions to the same todo preserve every required PR', async () => {
    const { db, store, call, runner, states } = setup();
    try {
      store.addTodo('same', 'ask', draft([url(1)]), 1);
      const results = await Promise.all([
        call('neo.todo.edit', {
          todoId: 'same',
          addUrls: [url(1)],
          done: 'met',
          evidence: 'First merged',
        }),
        call('neo.todo.edit', { todoId: 'same', addUrls: [url(2)] }),
      ]);
      expect(results[1].ok).toBe(true);
      expect(results[0]).toMatchObject({
        ok: false,
        reason: expect.stringContaining('todo_changed'),
      });
      expect(store.getTodo('same')?.check?.params.urls).toEqual([
        url(1).toLowerCase(),
        url(2).toLowerCase(),
      ]);
      await runner.checkNow(['same'], () => {});
      expect(store.getTodo('same')?.state).not.toBe('done');
      states.set(2, 'MERGED');
      await runner.checkNow(['same'], () => {});
      expect(store.getTodo('same')).toMatchObject({ state: 'done', evidence: '#1 #2 merged' });
    } finally {
      db.close();
    }
  });
  test.each(['edit', 'close', 'sweep'] as const)(
    'an overlapping %s completion cannot ignore a newly pinned PR',
    async (path) => {
      const { db, store, call, runner, states } = setup();
      try {
        store.addTodo('same', 'ask', draft([url(1)]), 1);
        const pending =
          path === 'sweep'
            ? runner.checkNow(['same'], () => {})
            : call(
                `neo.todo.${path}`,
                path === 'edit'
                  ? { todoId: 'same', done: 'met', evidence: 'First merged' }
                  : { todoId: 'same', reason: 'First merged' }
              );
        expect(await call('neo.todo.edit', { todoId: 'same', addUrls: [url(2)] })).toMatchObject({
          ok: true,
        });
        await pending;
        expect(store.getTodo('same')?.state).not.toBe('done');
        expect(store.getTodo('same')?.check?.params.urls).toEqual([
          url(1).toLowerCase(),
          url(2).toLowerCase(),
        ]);
        await runner.checkNow(['same'], () => {});
        expect(store.getTodo('same')?.state).not.toBe('done');
        states.set(2, 'MERGED');
        await runner.checkNow(['same'], () => {});
        expect(store.getTodo('same')).toMatchObject({ state: 'done', evidence: '#1 #2 merged' });
      } finally {
        db.close();
      }
    }
  );
  test('close rechecks required URLs after stopping its session', async () => {
    let entered!: () => void;
    let release!: () => void;
    const stopping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { db, store, call } = setup(async () => {
      entered();
      await stopped;
      return null;
    });
    try {
      store.addTodo('same', 'ask', draft([url(1)]), 1);
      const closing = call('neo.todo.close', { todoId: 'same', reason: 'First merged' });
      await stopping;
      expect(await call('neo.todo.edit', { todoId: 'same', addUrls: [url(2)] })).toMatchObject({
        ok: true,
      });
      release();
      expect(await closing).toMatchObject({
        ok: false,
        reason: expect.stringContaining('todo_changed'),
      });
      expect(store.getTodo('same')?.state).not.toBe('done');
    } finally {
      release();
      db.close();
    }
  });
  test.each(['neo.todo.close', 'neo.todo.remove'])(
    '%s retains a concurrent report and applies the requested state',
    async (name) => {
      const h = setup(async () => {
        const current = h.store.getTodo('same')!;
        h.store.updateTodo(
          current,
          { report: 'New report while stopping 🦊' },
          current.updatedAt + 1
        );
        return null;
      });
      try {
        h.store.addTodo('same', 'ask', draft([url(1)]), 1);
        expect(await h.call(name, { todoId: 'same', reason: 'Requested change' })).toMatchObject({
          ok: true,
          todo: {
            state: name === 'neo.todo.close' ? 'done' : 'removed',
            report: 'New report while stopping 🦊',
          },
        });
      } finally {
        h.db.close();
      }
    }
  );

  test('completion edit retains a report written during its fact read', async () => {
    const h = setup();
    try {
      h.store.addTodo('same', 'ask', draft([url(1)]), 1);
      const check = h.coding.todos.check;
      h.coding.todos.check = async (todo) => {
        const result = await check(todo);
        const current = h.store.getTodo(todo.id)!;
        h.store.updateTodo(
          current,
          { report: 'Concurrent fact-read report' },
          current.updatedAt + 1
        );
        return result;
      };
      expect(
        await h.call('neo.todo.edit', { todoId: 'same', done: 'met', evidence: 'Merged' })
      ).toMatchObject({
        ok: true,
        todo: { state: 'done', report: 'Concurrent fact-read report' },
      });
    } finally {
      h.db.close();
    }
  });

  test('URL ownership is scoped to the ask', async () => {
    const { db, store, call } = setup();
    try {
      store.addTodo('old', 'ask', draft([url(2)]), 1);
      store.openAsk({
        id: 'other',
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Other',
        request: 'Other',
        createdAt: 2,
      });
      expect(
        await call('neo.todo.add', { askId: 'other', ...draft([url(2)]), instruction: null })
      ).toMatchObject({
        ok: true,
      });
    } finally {
      db.close();
    }
  });
  test('add and edit refuse invalid PR URLs without changing the check', async () => {
    const { db, store, call } = setup();
    try {
      const original = store.addTodo('original', 'ask', draft([url(1)]), 1);
      expect(
        await call('neo.todo.add', {
          askId: 'ask',
          ...draft(['https://example.com/not-a-pr']),
          instruction: null,
        })
      ).toMatchObject({ ok: false });
      expect(
        await call('neo.todo.edit', {
          todoId: original.id,
          addUrls: ['https://example.com/not-a-pr'],
        })
      ).toMatchObject({ ok: false });
      expect(store.getTodo(original.id)?.check?.params.urls).toEqual([url(1)]);
    } finally {
      db.close();
    }
  });
});

describe('coding todo facts and judgement boundary', () => {
  const add = (h: ReturnType<typeof setup>, kind = 'pr_merged') =>
    h.store.addTodo(
      'facts-todo',
      'ask',
      {
        title: 'Observe both PRs',
        doneWhen: 'Both merged',
        instruction: null,
        named: null,
        check: { pack: 'coding', kind, params: { urls: [url(1), url(2)] } },
      },
      1
    );

  test('a captured verdict needs no further I/O and ignores subsequent upstream changes', async () => {
    const h = setup();
    const todo = add(h);
    h.states.set(2, 'MERGED');
    const facts = await h.coding.todos.readFacts(todo);
    h.states.set(2, 'OPEN');
    h.db.close();
    expect(h.coding.todos.judge(todo, facts)).toEqual({
      state: 'done',
      evidence: '#1 #2 merged',
    });
    expect(h.coding.todos.judge(todo, facts)).toEqual({
      state: 'done',
      evidence: '#1 #2 merged',
    });
  });

  test('reading facts never finishes a todo before its caller applies a decision', async () => {
    const h = setup();
    try {
      const todo = add(h);
      h.states.set(2, 'MERGED');
      const before = h.store.getTodo(todo.id);
      const facts = await h.coding.todos.readFacts(todo);
      expect(h.store.getTodo(todo.id)).toEqual(before);
      expect(h.coding.todos.judge(todo, facts)).toMatchObject({ state: 'done' });
    } finally {
      h.db.close();
    }
  });

  test('incomplete facts cannot certify a merge and the existing check remains unmet', async () => {
    const h = setup();
    try {
      const todo = add(h);
      const pack = createCodingTodoPack(h.repo, async () => [
        { url: url(1), state: 'MERGED', checks: 'passing', review: 'none' },
      ]);
      expect(pack.judge(todo, await pack.readFacts(todo))).toEqual({ state: 'no_opinion' });
      expect(await pack.check(todo)).toEqual({ done: false, evidence: null });
    } finally {
      h.db.close();
    }
  });

  test('replacement grace uses the observation time rather than an implicit clock', () => {
    const h = setup();
    try {
      const todo = add(h);
      const prs: NeoWorkPr[] = [
        { url: url(1), state: 'CLOSED', checks: 'none', review: 'none', closedAt: 1000 },
      ];
      expect(h.coding.todos.judge(todo, { prs, observedAt: 1001 })).toEqual({
        state: 'no_opinion',
      });
      expect(h.coding.todos.judge(todo, { prs, observedAt: 1_000_000 })).toEqual({
        state: 'failed',
        reason: '#1 closed without merging and no pull request replaced it',
      });
    } finally {
      h.db.close();
    }
  });

  test('a foreign rule and an unsupported kind give no opinion without changing compatibility', async () => {
    const h = setup();
    try {
      const todo = add(h, 'synthetic_unsupported');
      expect(h.coding.todos.judge(todo, await h.coding.todos.readFacts(todo))).toEqual({
        state: 'no_opinion',
      });
      expect(await h.coding.todos.check(todo)).toBeNull();
      const foreign = { ...todo, check: { ...todo.check!, pack: 'other' } };
      expect(await h.coding.todos.readFacts(foreign)).toBeNull();
      expect(h.coding.todos.judge(foreign, null)).toEqual({ state: 'no_opinion' });
      expect(await h.coding.todos.check(foreign)).toBeNull();
    } finally {
      h.db.close();
    }
  });
});
