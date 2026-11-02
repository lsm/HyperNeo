import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { packWorkerStartFixture } from '../../helpers/pack-worker-start.ts';

function setup(options?: Parameters<typeof packWorkerStartFixture>[1]) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return { db, ...packWorkerStartFixture(db, options) };
}

describe('core todo starts respect pack worker exclusions', () => {
  test('add/start binds an independent worker using the normal core receipt', async () => {
    const world = setup();
    try {
      const opened = await world.open();
      const ask = world.store.listOpenAsks()[0];
      expect(opened.ok).toBe(true);
      const author = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Author'),
        start: false,
      });
      world.bind(author.todo.id, 'author');
      const prior = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Earlier actor'),
        start: false,
      });
      world.bind(prior.todo.id, 'prior');
      const result = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Independent work', [author.todo.id, prior.todo.id]),
      });
      expect(result.todo).toMatchObject({ askId: ask.id, state: 'doing', blockedBy: null });
      expect(world.sessions.readRef(result.todo.id)).toEqual({
        adapter: 'fixture',
        id: 'independent',
      });
      expect(world.calls[0].input).toMatchObject({
        todoId: result.todo.id,
        excludeRefs: [
          { adapter: 'fixture', id: 'author' },
          { adapter: 'fixture', id: 'prior' },
        ],
      });
      expect(world.sessions.inputs.list(result.todo.id)).toMatchObject([
        { outcome: { ref: { id: 'independent' } } },
      ]);
      expect(world.db.prepare('SELECT count(*) AS n FROM pack_facts').get()).toEqual({ n: 0 });
    } finally {
      world.db.close();
    }
  });

  test('missing required binding fails before any send, receipt or binding', async () => {
    const world = setup();
    try {
      await world.open();
      const ask = world.store.listOpenAsks()[0];
      const result = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Requires identity', ['missing']),
      });
      expect(result.todo).toMatchObject({
        state: 'failed',
        reason: expect.stringContaining('missing_worker_binding'),
      });
      expect(world.calls).toEqual([]);
      expect(world.sessions.readRef(result.todo.id)).toBeNull();
      expect(world.sessions.inputs.list(result.todo.id)).toEqual([]);
    } finally {
      world.db.close();
    }
  });

  test('while start is pending the todo is doing, never blocked awaiting a receipt', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const world = setup({
      invoke: async () => {
        entered();
        await pending;
        return {
          kind: 'completed',
          value: { ok: true, value: { ref: { adapter: 'fixture', id: 'independent' } } },
        };
      },
    });
    let adding: ReturnType<typeof world.invoke> | undefined;
    try {
      await world.open();
      const ask = world.store.listOpenAsks()[0];
      adding = world.invoke('neo.todo.add', { askId: ask.id, ...world.draft('Pending start') });
      await called;
      const todo = world.store.listTodos(ask.id)[0];
      expect(todo).toMatchObject({ state: 'doing', blockedBy: null });
      expect(world.checked).toEqual([todo.id]);
      expect(world.sessions.readRef(todo.id)).toBeNull();
      expect(world.sessions.inputs.list(todo.id)).toMatchObject([{ outcome: null }]);
      release();
      expect((await adding).todo.state).toBe('doing');
      expect(world.sessions.readRef(todo.id)?.id).toBe('independent');
    } finally {
      release();
      await adding;
      world.db.close();
    }
  });

  test('retry reads current bindings before core dispatches again', async () => {
    const world = setup();
    try {
      await world.open();
      const ask = world.store.listOpenAsks()[0];
      const author = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Author'),
        start: false,
      });
      const failed = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Independent work', [author.todo.id]),
      });
      expect(failed.todo.state).toBe('failed');
      expect(world.calls).toEqual([]);
      world.bind(author.todo.id, 'author');
      const retried = await world.invoke('neo.todo.retry', { todoId: failed.todo.id });
      expect(retried.todo.state).toBe('doing');
      expect(world.checked).toEqual([failed.todo.id, failed.todo.id]);
      expect(world.calls[0].input.excludeRefs).toEqual([{ adapter: 'fixture', id: 'author' }]);
      expect(world.sessions.readRef(failed.todo.id)?.id).toBe('prior');
      expect(world.sessions.inputs.list(failed.todo.id)).toHaveLength(1);
    } finally {
      world.db.close();
    }
  });

  test('packs without a hook keep their existing start input', async () => {
    const world = setup({ hook: false });
    try {
      await world.open();
      const ask = world.store.listOpenAsks()[0];
      const result = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Unrestricted work'),
      });
      expect(result.todo.state).toBe('doing');
      expect(world.calls[0].input.excludeRefs).toBeUndefined();
      expect(world.checked).toEqual([]);
    } finally {
      world.db.close();
    }
  });

  test('explicit sends do not use start restrictions', async () => {
    const world = setup();
    try {
      await world.open();
      const ask = world.store.listOpenAsks()[0];
      const result = await world.invoke('neo.todo.add', {
        askId: ask.id,
        ...world.draft('Continue work', ['missing']),
        target: { verb: 'send', ref: { adapter: 'fixture', id: 'existing' } },
      });
      expect(result.todo.state).toBe('doing');
      expect(world.checked).toEqual([]);
      expect(world.calls.some((call) => call.name === 'work.send')).toBe(true);
    } finally {
      world.db.close();
    }
  });
});
