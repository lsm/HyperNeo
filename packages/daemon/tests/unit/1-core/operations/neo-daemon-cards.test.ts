import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoCheckOverdue,
  neoDaemonCardCodes,
  neoStartRetryDue,
  planNeoDaemonCardActions,
  planNeoRetriesCard,
} from '../../../../src/lib/neo/daemon-cards.ts';
import { createNeoQuestionAnswerDelivery } from '../../../../src/lib/neo/question-answer-delivery.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { neoStallReminderWrite } from '../../../../src/storage/repositories/neo-stall-reminder-write.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const DAY = 24 * 60 * 60 * 1000;

const row = (id: string, patch: Partial<NeoTodo> = {}) => ({
  id,
  title: id,
  state: 'blocked' as NeoTodo['state'],
  blockedReason: 'Could not start: host unreachable',
  updatedAt: 5,
  ...patch,
});

const card = (patch: Partial<NeoQuestion>) => ({
  id: 'card',
  state: 'open' as NeoQuestion['state'],
  cause: null as string | null,
  todos: [] as string[],
  text: '',
  answer: null as NeoQuestion['answer'],
  answeredAt: null as number | null,
  options: null as string[] | null,
  ...patch,
});

describe('neoStartRetryDue', () => {
  test('the daemon retries a failed start twice, then stops', () => {
    expect([0, 1, 2, 3].map(neoStartRetryDue)).toEqual([true, true, false, false]);
  });
});

describe('planNeoRetriesCard', () => {
  test('a second todo failing the same way joins the open card', () => {
    const first = row('first');
    const second = row('second');
    const open = card({ cause: 'retries_exhausted', todos: ['first'] });
    const plan = planNeoRetriesCard(second, [first, second], [open]);
    expect(plan?.replaces).toBe(open);
    expect(plan?.draft).toMatchObject({
      todos: ['first', 'second'],
      options: ['Retry', 'Mark done', 'Remove'],
      text: '"first", "second" could not start after 2 automatic retries: Could not start: host unreachable. Retry, mark done, or remove?',
    });
  });

  test('a different failure gets its own card, and a covered todo gets none', () => {
    const first = row('first');
    const other = row('other', { blockedReason: 'Could not start: login expired' });
    const open = card({ cause: 'retries_exhausted', todos: ['first'] });
    expect(planNeoRetriesCard(other, [first, other], [open])).toMatchObject({
      replaces: null,
      draft: { todos: ['other'] },
    });
    expect(planNeoRetriesCard(first, [first], [open])).toBeNull();
  });
});

describe('neoCheckOverdue', () => {
  const todo = { id: 'check', createdAt: 0 };
  test('a check-only todo is overdue 24 hours after it was added', () => {
    expect(neoCheckOverdue(todo, [], DAY - 1)).toBe(false);
    expect(neoCheckOverdue(todo, [], DAY)).toBe(true);
  });

  test('an open card covering it means no new one, and Keep waiting restarts the clock', () => {
    expect(neoCheckOverdue(todo, [card({ todos: ['check'] })], 2 * DAY)).toBe(false);
    const waited = card({
      cause: 'check_overdue',
      state: 'answered',
      todos: ['check'],
      answer: ['Keep waiting'],
      answeredAt: DAY,
    });
    expect(neoCheckOverdue(todo, [waited], 2 * DAY - 1)).toBe(false);
    expect(neoCheckOverdue(todo, [waited], 2 * DAY)).toBe(true);
  });
});

describe('planNeoDaemonCardActions', () => {
  const answered = (cause: string, answer: string, todos = ['a', 'b']) =>
    card({ cause, state: 'answered', todos, answer: [answer], answeredAt: 10 });

  test('Mark done and Remove act on every live todo the card covers', () => {
    const todos = [row('a'), row('b', { state: 'done' })];
    expect(planNeoDaemonCardActions(answered('worker_blocker', 'Mark done'), todos)).toEqual([
      {
        todoId: 'a',
        name: 'neo.todo.done',
        input: { todoId: 'a', reason: 'The human marked it done on a card.' },
      },
    ]);
    expect(
      planNeoDaemonCardActions(answered('check_overdue', 'Remove'), todos).map((a) => a.name)
    ).toEqual(['neo.todo.remove']);
  });

  test('Retry retries only todos untouched since the answer', () => {
    const todos = [row('a'), row('b', { updatedAt: 11 })];
    expect(planNeoDaemonCardActions(answered('retries_exhausted', 'Retry'), todos)).toEqual([
      { todoId: 'a', name: 'neo.todo.retry', input: { todoId: 'a' } },
    ]);
  });

  test('Keep waiting, a free reply, an open card or another cause do nothing', () => {
    const todos = [row('a'), row('b')];
    expect(planNeoDaemonCardActions(answered('check_overdue', 'Keep waiting'), todos)).toEqual([]);
    expect(
      planNeoDaemonCardActions(answered('worker_blocker', 'Use the staging host'), todos)
    ).toEqual([]);
    expect(
      planNeoDaemonCardActions(card({ cause: 'worker_blocker', todos: ['a'] }), todos)
    ).toEqual([]);
    expect(planNeoDaemonCardActions(answered('removed_prerequisite', 'Remove'), todos)).toEqual([]);
  });
});

describe('neoDaemonCardCodes', () => {
  test('a daemon card the client can localize carries its codes', () => {
    const blocked = row('Deploy', { blockedReason: 'Needs the staging password.' });
    expect(
      neoDaemonCardCodes(
        {
          cause: 'worker_blocker',
          todos: ['Deploy'],
          options: ['Mark done', 'Remove'],
          text: '"Deploy" is blocked: Needs the staging password. Reply to its worker, mark it done, or remove it?',
        },
        [blocked]
      )
    ).toEqual({
      textCodes: [
        {
          code: 'question.workerBlocker',
          params: {
            steps: '"Deploy"',
            reason: 'Needs the staging password',
            retries: '2',
            hours: '24',
          },
        },
      ],
      optionCodes: [
        { code: 'question.daemonMarkDone', params: {} },
        { code: 'question.daemonRemove', params: {} },
      ],
    });
  });
});

describe('daemon cards in the store', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    gateway = new DbGateway(':memory:', db);
    store = new NeoAskTodoRepository(db);
    db.prepare(
      "INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('neo','Neo','/tmp','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z','active','{}','{}')"
    ).run();
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Wait for the merge',
      request: 'Wait for the merge',
      createdAt: 0,
    });
    store.addTodo(
      'check',
      'ask',
      {
        title: 'Merged',
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } },
        instruction: null,
        named: null,
      },
      0
    );
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const sweep = (now: number) => gateway.run(neoStallReminderWrite, { now });
  const open = () =>
    store.listQuestions('ask').filter((q) => q.state === 'open' && q.cause === 'check_overdue');

  test('an overdue check opens one card, and Keep waiting holds it off another 24 hours', async () => {
    await sweep(DAY - 1);
    expect(open()).toEqual([]);
    await sweep(DAY);
    await sweep(DAY + 1);
    expect(open().map((q) => q.text)).toEqual([
      `"Merged" has waited 24 hours and its check hasn't passed. Keep waiting, mark it done, or remove it?`,
    ]);
    store.answerQuestion(open()[0], ['Keep waiting'], 'button', DAY + 2);
    await sweep(2 * DAY + 1);
    expect(open()).toEqual([]);
    await sweep(2 * DAY + 2);
    expect(open()).toHaveLength(1);
  });

  test('the daemon carries out the human answer on its card', async () => {
    await sweep(DAY);
    const [overdue] = open();
    store.answerQuestion(overdue, ['Mark done'], 'button', DAY + 1);
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const deliver = createNeoQuestionAnswerDelivery(
      store,
      new NeoTodoSessionRepository(db),
      async (_caller, name, input) => {
        calls.push({ name, input });
        return { kind: 'completed', value: { ok: true } } as never;
      },
      async () => {},
      async (todo) => todo,
      () => {}
    );
    await deliver(overdue.id);
    expect(calls).toEqual([
      {
        name: 'neo.todo.done',
        input: { todoId: 'check', reason: 'The human marked it done on a card.' },
      },
    ]);
  });
});
