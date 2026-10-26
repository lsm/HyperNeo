import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack, NeoTodoCheckResult } from '../../../../src/lib/neo/pack-contract.ts';
import {
  createCodingTodoPack,
  CodingTodoPrRepository,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('Neo todo edit commits through its writer', () => {
  let directory: string;
  let main: Database;
  let writer: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  let check: (todo: NeoTodo) => Promise<NeoTodoCheckResult | null>;
  let started: string[];
  let start: (id: string) => Promise<void>;
  const url = (n: number) => `https://github.com/synthetic/edit/pull/${n}`;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-edit-writer-'));
    const file = join(directory, 'synthetic.db');
    writer = new Database(file);
    runMigrations(writer, () => {});
    createTables(writer);
    createCodingPackTables(writer);
    main = new Database(file);
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    store = new NeoAskTodoRepository(writer);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Edit',
      request: 'Atomic edits',
      createdAt: 1,
    });
    check = async () => ({ done: false, evidence: null });
    started = [];
    start = async (id) => {
      started.push(id);
    };
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const add = (id: string, urls: string[] = []) =>
    store.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls } },
        instruction: 'Ship',
        named: null,
      },
      1
    );
  const edit = (input: Record<string, unknown>) => {
    const repo = new NeoAskTodoRepository(main);
    const coding: NeoPack = {
      id: 'coding',
      describe: 'Coding',
      instructions: () => null,
      todos: {
        ...createCodingTodoPack(new CodingTodoPrRepository(main), async () => []),
        check: (todo) => check(todo),
      },
    };
    const operation = createNeoTodoOperations(
      repo,
      new NeoTodoSessionRepository(main),
      {
        recompute: (todo, patch) =>
          repo.recompute(todo, patch, 10, { state: 'no_opinion' }, (id) => start(id)),
        start: async (id) => {
          await start(id);
          return { ok: false, reason: 'Synthetic candidate has no target' };
        },
        proceed: async () => ({ ok: false, reason: 'No session' }),
        retry: async () => ({ ok: false, reason: 'No session' }),
        stop: async () => {
          throw new Error('Editing must not stop a worker');
        },
      },
      () => [coding],
      () => null
    ).find((operation) => operation.name === 'neo.todo.edit')!;
    return operation.execute(operation.inputSchema.parse(input), {
      source: 'mcp',
      sessionId: 'neo',
      role: 'neo',
    }) as Promise<
      | { ok: false; reason: string }
      | { ok: true; todo: NeoTodo; todos: NeoTodo[]; records?: string[] }
    >;
  };

  test('a failed ask stamp leaves both the title and human card unchanged', async () => {
    const todo = add('first');
    store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
    store.askQuestion(
      'start',
      'ask',
      {
        text: 'Start?',
        kind: 'start',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: ['first'],
      },
      3
    );
    writer.exec(
      "CREATE TRIGGER refuse_edit BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'refuse edit'); END"
    );
    await expect(edit({ todoId: 'first', title: 'Must roll back' })).rejects.toThrow('refuse edit');
    expect(store.getTodo('first')?.title).toBe('first');
    expect(store.getQuestion('start')?.state).toBe('open');
    expect(started).toEqual([]);
  });

  test('editing succeeds with no todo SQL available on the main connection', async () => {
    add('first', [url(1)]);
    const prepare = main.prepare.bind(main);
    main.prepare = ((sql: string) => {
      if (/neo_todos|neo_asks|neo_questions|pack_coding_pr_claims/.test(sql))
        throw new Error('Todo SQL on main');
      return prepare(sql);
    }) as typeof main.prepare;
    expect(await edit({ todoId: 'first', title: 'Renamed', addUrls: [url(2)] })).toMatchObject({
      ok: true,
      todo: { title: 'Renamed', check: { params: { urls: [url(1), url(2)] } } },
    });
  });

  test('concurrent edits retain current duplicate ownership records', async () => {
    add('first');
    add('second');
    const results = await Promise.all(
      ['first', 'second'].map((todoId) => edit({ todoId, addUrls: [url(2)] }))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter(
        (result) =>
          result.ok && result.records?.some((record) => record.startsWith('pr_already_tracked:'))
      )
    ).toHaveLength(1);
  });

  test('a new core completion check is derived and reopens a previously done todo', async () => {
    const first = add('first', [url(1)]);
    store.updateTodo(first, { state: 'done', finishedAt: 2 }, 2);
    const required = { pack: 'core', kind: 'evidence', params: { path: '/synthetic/receipt' } };
    expect(await edit({ todoId: 'first', check: required })).toMatchObject({
      ok: true,
      todo: {
        check: required,
        doneWhen: 'File /synthetic/receipt exists.',
        state: 'todo',
        finishedAt: null,
      },
    });
  });

  test('explicit PR replacement and appended URLs share current ownership admission', async () => {
    add('first');
    add('second');
    const required = { pack: 'coding', kind: 'pr_merged', params: { urls: [url(1)] } };
    const results = await Promise.all(
      ['first', 'second'].map((todoId) => edit({ todoId, check: required, addUrls: [url(2)] }))
    );
    expect(
      results.every(
        (result) =>
          result.ok && result.todo.check?.params.urls.join(',') === [url(1), url(2)].join(',')
      )
    ).toBe(true);
    expect(
      results.filter(
        (result) =>
          result.ok && result.records?.some((record) => record.startsWith('pr_already_tracked:'))
      )
    ).toHaveLength(1);
  });

  test('an invalid core check refuses the whole edit', async () => {
    add('first');
    expect(
      await edit({
        todoId: 'first',
        title: 'Not committed',
        check: { pack: 'core', kind: 'evidence', params: { path: 'relative' } },
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('invalid_core_check:') });
    expect(store.getTodo('first')?.title).toBe('first');
  });

  test('completion refuses a check replaced while the external check runs', async () => {
    add('first', [url(1)]);
    check = async () => {
      store.updateTodo(
        store.getTodo('first')!,
        { check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url(2)] } } },
        3
      );
      return { done: true, evidence: 'Old PR merged' };
    };
    expect(await edit({ todoId: 'first', done: 'met', evidence: 'Old PR merged' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todo_changed:'),
    });
    expect(store.getTodo('first')?.state).not.toBe('done');
    expect(started).toEqual([]);
  });

  test('a new unmet PR requirement cannot leave a previously verified todo done', async () => {
    const first = add('first', [url(1)]);
    store.updateTodo(first, { state: 'done', evidence: 'First PR merged', finishedAt: 2 }, 2);
    const result = await edit({ todoId: 'first', addUrls: [url(2)] });
    expect(result).toMatchObject({
      ok: true,
      todo: { state: 'todo', finishedAt: null, check: { params: { urls: [url(1), url(2)] } } },
    });
    expect(store.getTodo('first')?.state).toBe('todo');
  });

  test.each(['done', 'closed_unverified'] as const)(
    'URL bookkeeping preserves %s unless a done check gains a new requirement',
    async (state) => {
      const first = add('first', [url(1)]);
      store.updateTodo(first, { state, finishedAt: 2 }, 2);
      const added = state === 'done' ? url(1) : url(2);
      expect(await edit({ todoId: 'first', addUrls: [added] })).toMatchObject({
        ok: true,
        todo: { state, finishedAt: 2 },
      });
    }
  );

  test('completion observes an unanswered card added while checking', async () => {
    add('first', [url(1)]);
    check = async () => {
      store.askQuestion(
        'human',
        'ask',
        {
          text: 'Decide',
          kind: 'reply',
          todoId: 'first',
          options: null,
          multiple: false,
          yesLabel: null,
          noLabel: null,
          startTodos: null,
        },
        3
      );
      return { done: true, evidence: 'Merged' };
    };
    expect(await edit({ todoId: 'first', done: 'met', evidence: 'Merged' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('card_unanswered:'),
    });
    expect(store.getTodo('first')?.state).not.toBe('done');
  });

  test('unmet completion retains the full report and starts the next candidate only after commit', async () => {
    add('first', [url(1)]);
    add('second');
    const text = 'Unabridged evidence 🦊\n'.repeat(30000).trim();
    start = async (id) => {
      expect(new NeoAskTodoRepository(main).getTodo('first')).toMatchObject({
        state: 'closed_unverified',
        report: text,
      });
      started.push(id);
    };
    const result = await edit({ todoId: 'first', done: 'reported', evidence: text });
    expect(result).toMatchObject({ ok: true, todo: { state: 'closed_unverified', report: text } });
    expect(started).toEqual(['second']);
    expect(store.getTodo('second')?.state).toBe('todo');
  });
});
