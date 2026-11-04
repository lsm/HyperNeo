import { QA_SYSTEM_CONTRACT, REVIEWER_SYSTEM_CONTRACT } from '@hyperneo/prompts';
import { withWorkGoal } from '../../../../src/lib/neo/driver-work.ts';
import { checkCodingStageTodo } from '../../../../src/lib/neo/packs/coding/stage-todo.ts';
import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { readFreeWorkers } from '../../../../src/storage/work-started-sessions.ts';
import {
  codingStageTodoFixture,
  stageDraft,
  stageParams,
  stageTarget,
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
  test.each(['review', 'verify'] as const)(
    '%s description carries IDs and exact checkout data; complete role guidance survives core formatting',
    (stage) => {
      const w = fixture();
      try {
        const draft = w.pack.describeStageTodo({ ...stageParams, stage }, stageTarget, true);
        expect(draft.title).toBe(
          `${stage === 'review' ? 'Review' : 'Verify'} PR #7 at ${stageParams.head}`
        );
        expect(draft.check.params).toEqual({ ...stageParams, stage });
        expect(draft.target).toMatchObject({
          verb: 'start',
          sandbox: true,
          preparationParameters: {
            stageTodo: true,
            role: stage,
            head: stageParams.head,
            pullRequest: 7,
          },
        });
        const brief = w.pack.workerStartBrief!(
          withWorkGoal('x'.repeat(30000), null),
          draft.target.preparationParameters
        );
        expect(brief).toContain(stage === 'review' ? REVIEWER_SYSTEM_CONTRACT : QA_SYSTEM_CONTRACT);
        expect(brief).toContain(stageParams.head);
        expect(brief.length).toBeLessThan(100000);
        if (stage === 'verify') expect(brief).toContain('verify/SKILL.md');
      } finally {
        w.db.close();
      }
    }
  );

  test.each(['head', 'stage', 'acceptanceContract', 'parentTodoId'] as const)(
    'malformed %s is refused before a stage is created',
    async (field) => {
      const w = fixture();
      try {
        const draft = stageDraft();
        const result = await w.invoke('neo.todo.add', {
          askId: w.ask.id,
          ...draft,
          check: { ...draft.check, params: { ...draft.check.params, [field]: '' } },
        });
        expect(result).toMatchObject({
          ok: false,
          reason: expect.stringContaining('stage_result_invalid'),
        });
        expect(w.store.listTodos(w.ask.id)).toHaveLength(1);
        expect(w.calls).toEqual([]);
      } finally {
        w.db.close();
      }
    }
  );

  test.each(['ref', 'model', 'harness', 'head', 'contract', 'stage'] as const)(
    'a verdict with the wrong %s cannot complete the stage',
    async (mismatch) => {
      const w = fixture();
      try {
        const started = await w.invoke('neo.todo.add', { askId: w.ask.id, ...stageDraft() });
        expect(started.ok, started.reason).toBe(true);
        w.result(started.todo!.id, 'pass');
        const [original] = w.ledger.stageFacts.read(stageParams.url);
        const fact = {
          ...original,
          actor: {
            kind: 'agent' as const,
            id: 'reviewer',
            harness: 'fixture',
            model: 'claude-opus-5-5',
          },
        };
        if (mismatch === 'ref') fact.ref = { adapter: 'fixture', id: 'other' };
        if (mismatch === 'model') fact.actor.model = 'other';
        if (mismatch === 'harness') fact.actor.harness = 'other';
        if (mismatch === 'head') fact.head = 'b'.repeat(40);
        if (mismatch === 'contract') fact.acceptanceContract = 'other';
        if (mismatch === 'stage') fact.stage = 'qa';
        expect(
          checkCodingStageTodo(started.todo!, w.sessions.readCard(started.todo!.id), [fact])
        ).toEqual({ done: false, evidence: null });
      } finally {
        w.db.close();
      }
    }
  );

  test('Verify without an earlier reviewer fails before dispatch', async () => {
    const w = fixture();
    try {
      const result = await w.invoke('neo.todo.add', { askId: w.ask.id, ...stageDraft('verify') });
      expect(result.todo).toMatchObject({
        state: 'failed',
        reason: expect.stringContaining('stage_review_binding_missing'),
      });
      expect(w.calls).toEqual([]);
      expect(w.sessions.inputs.list(result.todo!.id)).toEqual([]);
    } finally {
      w.db.close();
    }
  });
});
