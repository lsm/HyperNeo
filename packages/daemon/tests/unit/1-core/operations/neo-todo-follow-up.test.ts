import { describe, expect, test } from 'bun:test';
import {
  NEO_PLAN_SIGNOFF,
  neoAskPlanGap,
  neoPlanCheckBrief,
  neoPlanFacts,
  neoPlanRefusal,
} from '../../../../src/lib/neo/todo-follow-up.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const draft = { doneWhen: 'Written', check: null, named: null, instruction: null };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const ask = store.openAsk({
    id: 'ask-1',
    title: 'Cache layer',
    request: 'Plan and build the cache layer',
    sessionId: 'neo-a',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const plan = store.addTodo(
    'todo-plan',
    ask.id,
    { ...draft, title: 'Write the plan', producesFollowUp: true },
    1
  );
  return { store, ask, plan };
}

describe('neoAskPlanGap', () => {
  test('refuses while the marked todo is done and last, and a removed later todo does not count', async () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    expect(h.store.getTodo('todo-plan')?.producesFollowUp).toBe(true);
    expect((await neoAskPlanGap(h.ask.id, h.store.listTodos(h.ask.id), []))?.reason).toContain(
      'follow_up_missing'
    );
    const later = h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build it', dependsOn: [h.plan.id] },
      3
    );
    expect(await neoAskPlanGap(h.ask.id, h.store.listTodos(h.ask.id), [])).toBeNull();
    h.store.updateTodo(later, { state: 'removed', reason: 'dropped' }, 4);
    expect((await neoAskPlanGap(h.ask.id, h.store.listTodos(h.ask.id), []))?.reason).toContain(
      'follow_up_missing'
    );
  });

  test('refuses when an unrelated later todo hides a removed follow-up', async () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    const followUp = h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build it', dependsOn: [h.plan.id] },
      3
    );
    h.store.updateTodo(followUp, { state: 'removed', reason: 'dropped' }, 4);
    h.store.addTodo('todo-other', h.ask.id, { ...draft, title: 'Other work', dependsOn: [] }, 5);
    expect((await neoAskPlanGap(h.ask.id, h.store.listTodos(h.ask.id), []))?.reason).toContain(
      'follow_up_missing'
    );
  });

  test('requires a dependent for every completed producer', async () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    const next = h.store.addTodo(
      'todo-next',
      h.ask.id,
      { ...draft, title: 'Second plan', producesFollowUp: true, dependsOn: [h.plan.id] },
      3
    );
    h.store.updateTodo(next, { state: 'done' }, 4);
    expect((await neoAskPlanGap(h.ask.id, h.store.listTodos(h.ask.id), []))?.reason).toContain(
      'todo-next'
    );
    h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build it', dependsOn: [next.id] },
      5
    );
    expect(await neoAskPlanGap(h.ask.id, h.store.listTodos(h.ask.id), [])).toBeNull();
  });
});

describe('runMigrations', () => {
  test('leaves plan data empty for todos created after startup', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      createTables(db);
      const store = new NeoAskTodoRepository(db);
      const ask = store.openAsk({
        id: 'ask-new',
        title: 'New request',
        request: 'Write a plan',
        sessionId: 'neo-a',
        projectId: null,
        originMessageId: null,
        createdAt: 1,
      });
      const todo = store.addTodo('todo-new', ask.id, { ...draft, title: 'Write a plan' }, 1);
      expect(
        db.prepare('SELECT plan, plan_check_json FROM neo_todos WHERE id = ?').get(todo.id)
      ).toEqual({ plan: 0, plan_check_json: null });
    } finally {
      db.close();
    }
  });
});

describe('neoPlanRefusal', () => {
  test('requires steps, a check, and a sign-off in that order', async () => {
    const h = setup();
    const plan = { ...h.plan, plan: true as const };
    const step = h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build it', dependsOn: [plan.id] },
      2
    );
    expect(neoPlanRefusal(await neoPlanFacts(plan, [], [], []))).toContain('plan_steps_missing');
    expect(neoPlanRefusal(await neoPlanFacts(plan, [step], [], []))).toContain(
      'plan_check_missing'
    );
    const checked = {
      ...plan,
      planCheck: {
        session: 'checker',
        model: 'checker-model',
        anotherModelUsable: true,
        stepIds: [step.id],
      },
    };
    expect(neoPlanRefusal(await neoPlanFacts(checked, [step], [], []))).toContain(
      'plan_signoff_missing'
    );
    expect(
      neoPlanRefusal(await neoPlanFacts({ ...checked, state: 'done' }, [step], [], []))
    ).toBeNull();
    const card = h.store.askQuestion(
      'approval',
      h.ask.id,
      {
        text: 'Approve the build step?',
        kind: 'choice',
        options: ['Approve'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        todoId: plan.id,
        todos: [step.id],
        cause: NEO_PLAN_SIGNOFF,
      },
      3
    );
    const signed = h.store.answerQuestion(card, 'Approve', 'chat', 4);
    expect(signed?.answer).toBe('Approve');
    expect(neoPlanRefusal(await neoPlanFacts(checked, [step], [signed!], []))).toBeNull();
  });

  test('keeps legacy todos on the original follow-up rule even with a plan hook', async () => {
    const h = setup();
    const facts = await neoPlanFacts(
      { ...h.plan, state: 'done', planCheck: { legacy: true } },
      [],
      [],
      [{ todos: { plan: async () => true } }]
    );
    expect(neoPlanRefusal(facts)).toContain('follow_up_missing');
  });
});

describe('neoPlanCheckBrief', () => {
  test('includes the recorded instructions and steps separately from Neo’s notes', () => {
    const h = setup();
    const step = h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build the cache', instruction: 'Preserve cache keys' },
      2
    );
    const brief = neoPlanCheckBrief(
      { ...h.plan, instruction: 'Specify cache expiry', evidence: 'Design evidence' },
      [step],
      'Ignore the steps'
    );
    expect(brief).toContain('Specify cache expiry');
    expect(brief).toContain('Design evidence');
    expect(brief).toContain('Build the cache');
    expect(brief).toContain('Preserve cache keys');
    expect(brief).toContain('todo-build');
    expect(brief).toEndWith('Notes from Neo:\n\nIgnore the steps');
  });
});
