import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { readFreeWorkers } from '../../../../src/storage/work-started-sessions.ts';
import {
  codingStageTodoFixture,
  stageDraft,
  stageParams,
} from '../../helpers/coding-stage-todos.ts';

function fixture() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return { db, ...codingStageTodoFixture(db) };
}

describe('coding stage todos through normal core dispatch', () => {
  test.each(['pass', 'fail', 'inconclusive'] as const)(
    '%s verdict closes only its stage todo and frees the actor',
    async (verdict) => {
      const w = fixture();
      try {
        const started = await w.invoke('neo.todo.add', { askId: w.ask.id, ...stageDraft() });
        expect(started.ok, started.reason).toBe(true);
        const todo = started.todo!;
        expect(todo).toMatchObject({ askId: w.ask.id, state: 'doing', blockedBy: null });
        expect(w.sessions.readRef(todo.id)).toEqual({ adapter: 'fixture', id: 'reviewer' });
        expect(readFreeWorkers(w.db, 'fixture').has('reviewer')).toBe(false);
        expect(await w.pack.todos!.waiting!(todo)).toBe(true);
        expect(await w.pack.todos!.check(todo)).toEqual({ done: false, evidence: null });
        expect(w.result(todo.id, verdict)).toBe(true);
        await w.runner.checkNow([todo.id], (message) => {
          throw new Error(message);
        });
        expect(w.store.getTodo(todo.id)).toMatchObject({
          state: 'done',
          evidence: expect.stringContaining(verdict),
        });
        expect(readFreeWorkers(w.db, 'fixture').has('reviewer')).toBe(true);
        expect(w.store.getTodo(w.author.id)?.state).toBe('doing');
        expect(w.db.prepare('SELECT count(*) AS n FROM pack_facts').get()).toEqual({ n: 0 });
      } finally {
        w.db.close();
      }
    }
  );

  test('Verify excludes both the author and the earlier reviewer after Review fails', async () => {
    const w = fixture();
    try {
      const review = await w.invoke('neo.todo.add', { askId: w.ask.id, ...stageDraft() });
      expect(review.ok, review.reason).toBe(true);
      w.result(review.todo!.id, 'fail');
      await w.runner.checkNow([review.todo!.id], (message) => {
        throw new Error(message);
      });
      const verify = await w.invoke('neo.todo.add', { askId: w.ask.id, ...stageDraft('verify') });
      expect(verify.ok, verify.reason).toBe(true);
      expect(w.calls[1].excludeRefs).toEqual([
        { adapter: 'fixture', id: 'author' },
        { adapter: 'fixture', id: 'reviewer' },
      ]);
      expect(w.sessions.readRef(verify.todo!.id)?.id).toBe('verifier');
      w.result(verify.todo!.id, 'pass', 'qa');
      await w.runner.checkNow([verify.todo!.id], (message) => {
        throw new Error(message);
      });
      expect(w.store.getTodo(verify.todo!.id)?.state).toBe('done');
      expect(w.store.getTodo(review.todo!.id)?.state).toBe('done');
      expect(w.store.getTodo(w.author.id)?.state).toBe('doing');
    } finally {
      w.db.close();
    }
  });

  test('a new head has its own pending todo and cannot consume the prior verdict', async () => {
    const w = fixture();
    try {
      const first = await w.invoke('neo.todo.add', { askId: w.ask.id, ...stageDraft() });
      expect(first.ok, first.reason).toBe(true);
      w.result(first.todo!.id, 'pass');
      await w.runner.checkNow([first.todo!.id], (message) => {
        throw new Error(message);
      });
      const draft = stageDraft();
      const next = await w.invoke('neo.todo.add', {
        askId: w.ask.id,
        ...draft,
        check: { ...draft.check, params: { ...stageParams, head: 'b'.repeat(40) } },
      });
      expect(next.ok, next.reason).toBe(true);
      expect(next.todo!.id).not.toBe(first.todo!.id);
      expect(await w.pack.todos!.check(next.todo!)).toEqual({ done: false, evidence: null });
    } finally {
      w.db.close();
    }
  });
});
