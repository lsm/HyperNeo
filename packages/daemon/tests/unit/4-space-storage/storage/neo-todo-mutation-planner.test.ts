import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoPatch,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Result =
  | { ok: false; reason: string }
  | { ok: true; todo: NeoTodo; patch?: NeoTodoPatch; todos?: NeoTodo[]; records?: string[] };
describe('Read-only todo mutation plans', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  const url = (n: number) => `https://github.com/synthetic/planning/pull/${n}`;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    gateway = new DbGateway(':memory:', db);
    store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Planning',
      request: 'Plan without writing',
      createdAt: 1,
    });
    for (const id of ['first', 'peer'])
      store.addTodo(
        id,
        'ask',
        {
          title: id,
          doneWhen: 'Merged',
          check: {
            pack: 'coding',
            kind: 'pr_merged',
            params: { urls: id === 'peer' ? [url(1)] : [] },
          },
          instruction: 'Continue',
          named: null,
        },
        1
      );
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const snapshot = () => ({
    ask: store.getAsk('ask'),
    todos: store.listTodos('ask'),
    questions: store.listQuestions('ask'),
  });
  const plan = async (input: object, artifacts: unknown[] = []) => {
    const op = DB_OPS.get('neo.todoMutationReads') as
      | DbOp<{ method: string; args: unknown[] }, Result>
      | undefined;
    expect(op, 'the reader must register data-only mutation planning').toBeDefined();
    if (!op) throw new Error('Mutation planning is unavailable');
    expect(op.mode).toBe('read');
    const before = snapshot();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const result = await gateway.run(op, { method: 'plan', args: [input, 10, artifacts] });
    expect(snapshot()).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    return result;
  };

  test('returns a proposed title and completion report without changing the visible todo', async () => {
    const report = 'Full proposed report 🦊\n'.repeat(10000);
    expect(
      await plan({
        kind: 'edit',
        todoId: 'first',
        title: 'Proposed',
        done: 'reported',
        evidence: report,
      })
    ).toMatchObject({
      ok: true,
      todo: { title: 'first' },
      patch: { title: 'Proposed', state: 'done', report, finishedAt: 10 },
    });
  });

  test.each(['done', 'dropped'] as const)(
    'a %s ask returns successful unchanged bookkeeping',
    async (status) => {
      store.settleAsk(store.getAsk('ask')!, status, 'Human settled it', 2);
      const result = await plan({ kind: 'edit', todoId: 'first', title: 'Ignored' });
      expect(result).toMatchObject({
        ok: true,
        todo: { title: 'first' },
        records: [expect.stringContaining('ask_settled:')],
      });
      expect(result).not.toHaveProperty('patch');
    }
  );

  test.each([
    [{ kind: 'edit', todoId: 'missing', title: 'Ignored' }, 'not_found:'],
    [{ kind: 'edit', todoId: 'first', done: 'met' }, 'evidence_missing:'],
    [
      {
        kind: 'edit',
        todoId: 'first',
        check: { pack: 'core', kind: 'evidence', params: { path: 'relative' } },
      },
      'invalid_core_check:',
    ],
  ])('refuses an invalid plan without changing stored work', async (input, reason) => {
    expect(await plan(input)).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });

  test('artifact plans accept only the matching authorized reference', async () => {
    const ref = {
      daemonId: 'synthetic',
      artifactId: 'artifact',
      title: 'Report',
      kind: 'text',
      byteLength: 1,
    };
    const input = {
      kind: 'edit',
      todoId: 'first',
      done: 'reported',
      evidence: 'Full evidence',
      artifacts: [ref],
    };
    expect(await plan(input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('invalid_artifact_reference:'),
    });
    expect(await plan(input, [ref])).toMatchObject({
      ok: true,
      patch: { artifacts: [ref], report: 'Full evidence' },
    });
    expect(await plan({ ...input, artifacts: [{ ...ref, byteLength: 2 }] }, [ref])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('invalid_artifact_reference:'),
    });
  });

  test('a removed todo refuses edits', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'removed' }, 2);
    expect(await plan({ kind: 'edit', todoId: 'first', title: 'Ignored' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todo_removed:'),
    });
  });

  test('proposes a derived core label and reopens a previously completed requirement', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'done', finishedAt: 2 }, 2);
    const check = {
      pack: 'core',
      kind: 'evidence',
      params: { path: '/synthetic/planning/evidence' },
    };
    expect(await plan({ kind: 'edit', todoId: 'first', check })).toMatchObject({
      ok: true,
      patch: {
        check,
        doneWhen: 'File /synthetic/planning/evidence exists.',
        state: 'todo',
        finishedAt: null,
      },
    });
  });

  test('explicit check replacement and URLs use current peer ownership records', async () => {
    const check = { pack: 'coding', kind: 'pr_merged', params: { urls: [url(2)] } };
    expect(await plan({ kind: 'edit', todoId: 'first', check, addUrls: [url(1)] })).toMatchObject({
      ok: true,
      patch: { check: { params: { urls: [url(2), url(1)] } } },
      records: [expect.stringContaining('pr_already_tracked:')],
    });
  });

  test('unsupported URL bookkeeping preserves an unverified report and requirement', async () => {
    const check = {
      pack: 'core',
      kind: 'evidence',
      params: { path: '/synthetic/planning/evidence' },
    };
    store.updateTodo(
      store.getTodo('first')!,
      { check, state: 'closed_unverified', report: 'Complete report' },
      2
    );
    const result = await plan({ kind: 'edit', todoId: 'first', addUrls: [url(2)] });
    expect(result).toMatchObject({
      ok: true,
      todo: { state: 'closed_unverified', check, report: 'Complete report' },
      records: [expect.stringContaining('check_urls_unsupported:')],
    });
    expect(result.ok && result.patch?.state).toBeUndefined();
  });

  test('close and remove only propose their changes', async () => {
    expect(await plan({ kind: 'close', todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: true,
      patch: { state: 'done' },
    });
    expect(
      await plan({ kind: 'remove', todoId: 'first', reason: 'Replaced', replacedBy: 'peer' })
    ).toMatchObject({ ok: true, patch: { state: 'removed', replacedBy: 'peer' } });
  });
});
