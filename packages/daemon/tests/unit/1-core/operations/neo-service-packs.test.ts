import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { NEO_WORK_GOAL_MERGE } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import { BUILD_METADATA } from '../../../../src/lib/build-metadata.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>, service: ReturnType<typeof createNeoService>;
const url = 'https://github.com/synthetic/plan/pull/8';
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
});
afterEach(() => {
  service.dispose();
  db.close();
});

test('core checks stay installed with only life-admin enabled and read actual outcomes', async () => {
  db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  const core = service.pack('core');
  expect(core).not.toBeNull();
  service.todos.openAsk({
    id: 'ask',
    title: 'Decision',
    request: 'Confirm the result',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const question = service.todos.askQuestion(
    'question',
    'ask',
    {
      text: 'Is it done?',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: null,
    },
    1
  );
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    {
      title: 'Confirm result',
      doneWhen: 'Human confirms',
      instruction: null,
      named: null,
      check: { pack: 'core', kind: 'human_confirmed', params: { questionId: question.id } },
    },
    1
  );
  expect(await core!.todos!.check(todo)).toEqual({ done: false, evidence: null });
  service.todos.answerQuestion(question, 'no', 'button', 2);
  expect(await core!.todos!.check(todo)).toEqual({ done: false, evidence: null });
  const yes = service.todos.askQuestion('yes', 'ask', question, 3);
  service.todos.answerQuestion(yes, 'yes', 'chat', 4);
  const confirmed = { ...todo, check: { ...todo.check!, params: { questionId: yes.id } } };
  expect(await core!.todos!.check(confirmed)).toMatchObject({ done: true });
  expect(await core!.todos!.check({ ...confirmed, askId: 'foreign' })).toEqual({
    done: false,
    evidence: null,
  });
  expect(
    await core!.todos!.check({
      ...todo,
      check: {
        pack: 'core',
        kind: 'deployed',
        params: { repo: 'lsm/HyperNeo', sha: BUILD_METADATA.commit },
      },
    })
  ).toMatchObject({ done: true });
  expect(
    await core!.todos!.check({
      ...todo,
      check: {
        pack: 'core',
        kind: 'deployed',
        params: { repo: 'other/repository', sha: BUILD_METADATA.commit },
      },
    })
  ).toEqual({ done: false, evidence: null });
  expect(service.todos.getTodo(todo.id)?.state).toBe('todo');
});

test('installed builtins keep identity and settings select without rebuilding them', () => {
  const installed = service.installedPacks();
  expect(installed.map((pack) => pack.id)).toEqual(['coding', 'life-admin', 'core']);
  expect(service.packs()).toEqual([installed[0]]);
  db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  expect(service.packs()).toEqual([installed[1]]);
  expect(service.installedPacks()[0]).toBe(installed[0]);
  expect(service.installedPacks()[1]).toBe(installed[1]);
  expect(
    service.installedPacks()[0].workGoal?.('Ship', {
      workId: 'todo',
      goal: null,
      doneWhen: 'PR merged',
      checkKind: 'pr_merged',
    })
  ).toContain(NEO_WORK_GOAL_MERGE);
  expect(
    service.installedPacks()[0].workGoal?.('Ship', {
      workId: 'todo',
      goal: null,
      doneWhen: 'PR #42 is live on main',
      checkKind: 'pr_merged',
    })
  ).toContain(NEO_WORK_GOAL_MERGE);
  expect(
    service.installedPacks()[0].workGoal?.('Ship', {
      workId: 'todo',
      goal: null,
      doneWhen: 'Merged',
      checkKind: null,
    })
  ).toContain(NEO_WORK_GOAL_MERGE);
  expect(
    service.installedPacks()[0].workGoal?.('Ship', {
      workId: 'todo',
      goal: null,
      doneWhen: 'Runs in the simulator',
      checkKind: null,
    })
  ).not.toContain(NEO_WORK_GOAL_MERGE);
});

test.each([
  { kind: 'yesno' as const, answer: 'yes', via: 'button' as const },
  { kind: 'yesno' as const, answer: 'Yes, go ahead with this plan.', via: 'chat' as const },
  { kind: 'reply' as const, answer: 'The synthetic plan is approved.', via: 'chat' as const },
  {
    kind: 'choice' as const,
    answer: ['Delete the approved synthetic leftovers'],
    via: 'button' as const,
  },
])(
  'an approved $kind card completes its still-queued todo ($via: $answer)',
  async ({ kind, answer, via }) => {
    service.todos.openAsk({
      id: 'ask',
      title: 'Confirm synthetic plan',
      request: 'Approve the synthetic plan',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      createdAt: 1,
    });
    const question = service.todos.askQuestion(
      'approval',
      'ask',
      {
        text: 'Approve the synthetic plan?',
        kind,
        options:
          kind === 'choice' ? ['Keep everything', 'Delete the approved synthetic leftovers'] : null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      1
    );
    const todo = service.todos.addTodo(
      'queued',
      'ask',
      {
        title: 'Human approves the synthetic plan',
        doneWhen: 'Human confirms',
        instruction: null,
        named: null,
        check: { pack: 'core', kind: 'human_confirmed', params: { questionId: question.id } },
      },
      1
    );
    expect(todo.state).toBe('todo');
    service.todos.answerQuestion(
      question,
      typeof answer === 'string' ? answer : [...answer],
      via,
      2
    );
    await service.deliverQuestionAnswers(question.id);
    expect(service.todos.getTodo(todo.id)?.state).toBe('done');
  }
);

test('a queued confirmation starts its successor exactly once when the answer arrives', async () => {
  const store = service.todos;
  store.openAsk({
    id: 'ask',
    title: 'Synthetic ordered work',
    request: 'Approve and continue',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  store.addTodo(
    'first',
    'ask',
    {
      title: 'Human decides',
      doneWhen: 'Human confirms',
      instruction: null,
      named: null,
      check: { pack: 'core', kind: 'human_confirmed', params: { questionId: 'card' } },
    },
    1
  );
  const card = store.askQuestion(
    'card',
    'ask',
    {
      text: 'Approve the synthetic plan?',
      kind: 'reply',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: null,
      todoId: 'first',
    },
    1
  );
  store.addTodo(
    'next',
    'ask',
    {
      title: 'Next step',
      doneWhen: 'Output exists',
      instruction: 'Record a synthetic dispatch',
      named: null,
      check: null,
    },
    2
  );
  const raw = db.getDatabase(),
    gateway = gatewayFor(raw),
    sessions = new NeoTodoSessionRepository(raw);
  sessions.create('next', { verb: 'send', ref: { adapter: 'hyperneo', id: 'synthetic-worker' } });
  const dispatches: unknown[] = [];
  const runner = createNeoTodoRunner({
    store,
    sessions,
    write: gateway.run.bind(gateway),
    packs: () => service.installedPacks(),
    changed: () => {},
    tell: async () => {},
    invoke: async (_caller, name, input) => {
      if (name === 'work.send') dispatches.push(input.ref);
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: {
            delivered: true,
            ref: input.ref,
            status: 'running',
            lastActivityAt: 1,
          },
        },
      };
    },
  });
  store.answerQuestion(card, 'The synthetic plan is approved.', 'chat', 3);
  await runner.checkNow({ questionId: 'card' }, (_message, error) => {
    throw error;
  });
  expect(store.getTodo('first')?.state).toBe('done');
  expect(store.getTodo('next')?.state).toBe('doing');
  expect(dispatches).toEqual([{ adapter: 'hyperneo', id: 'synthetic-worker' }]);
  await runner.checkNow({ questionId: 'card' }, (_message, error) => {
    throw error;
  });
  expect(dispatches).toHaveLength(1);
});

test('an installed legacy todo check observes reader replacements and retains its claims', async () => {
  service.todos.openAsk({
    id: 'ask',
    title: 'Legacy',
    request: 'Ship',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    {
      title: 'Stage',
      doneWhen: 'Merged',
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
      instruction: null,
      named: null,
    },
    1
  );
  const pack = service.pack('coding')!;
  service.readPrs = mock(async () => [{ url, state: 'OPEN', checks: 'pending', review: 'none' }]);
  expect(await pack.todos!.check(todo)).toEqual({ done: false, evidence: null });
  service.readPrs = mock(async () => [
    { url, state: 'MERGED', checks: 'passing', review: 'approved' },
  ]);
  expect(await pack.todos!.check(todo)).toEqual({ done: true, evidence: '#8 merged' });
  expect(service.readPrs).toHaveBeenCalledWith([url]);
  expect(service.todoPrs.urls(todo.id)).toEqual([url]);
  expect(service.todos.getTodo(todo.id)?.state).toBe('todo');
});

test('an installed issue judgement observes the current reader without writing todo state', async () => {
  service.todos.openAsk({
    id: 'ask',
    title: 'Issue',
    request: 'Ship',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    {
      title: 'Stage',
      doneWhen: 'Completed',
      check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'synthetic/plan#1' } },
      instruction: null,
      named: null,
    },
    1
  );
  const pack = service.pack('coding')!;
  service.readRefStates = mock(async () => []);
  expect(pack.judge!(todo, await pack.readFacts!(todo))).toEqual({ state: 'no_opinion' });
  service.readRefStates = mock(async () => [
    {
      kind: 'issue',
      url: 'https://github.com/synthetic/plan/issues/1',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      done: true,
      closedBy: null,
      closingPrs: [],
      at: 2,
    },
  ]);
  expect(pack.judge!(todo, await pack.readFacts!(todo))).toMatchObject({ state: 'done' });
  expect(service.todos.getTodo(todo.id)?.state).toBe('todo');
});
