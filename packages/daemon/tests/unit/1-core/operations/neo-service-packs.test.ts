import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_WORK_GOAL_MERGE } from '@hyperneo/prompts';
import { BUILD_METADATA } from '../../../../src/lib/build-metadata.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
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
  service.todos.answerQuestion(service.todos.getQuestion(question.id)!, 'yes', 'chat', 3);
  expect(await core!.todos!.check(todo)).toMatchObject({ done: true });
  expect(await core!.todos!.check({ ...todo, askId: 'foreign' })).toEqual({
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
  expect(installed.map((pack) => pack.id)).toEqual(['coding', 'life-admin']);
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
    })
  ).toContain(NEO_WORK_GOAL_MERGE);
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
