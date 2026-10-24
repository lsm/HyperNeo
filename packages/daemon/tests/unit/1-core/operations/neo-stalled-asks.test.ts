import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const hour = 3_600_000;
let clock: number;
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let now: ReturnType<typeof spyOn>;
const note = 'This ask has nothing in progress. Add the next todo, or settle it.';
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  spyOn(service.todoRunner, 'refresh').mockResolvedValue(undefined);
  spyOn(service.sessionWatcher, 'watchSessions').mockResolvedValue(undefined);
  clock = 10 * hour;
  now = spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  await service.dispose();
  now.mockRestore();
  db.close();
});
function ask(id: string, at = clock - 2 * hour) {
  return service.todos.openAsk({
    id,
    sessionId: 'recipient-' + id,
    projectId: null,
    originMessageId: null,
    title: id,
    request: 'Synthetic work',
    createdAt: at,
  });
}
function todo(askId: string, state: 'todo' | 'doing' | 'blocked' | 'done') {
  const item = service.todos.addTodo(
    'todo-' + askId,
    askId,
    { title: 'Step', doneWhen: 'Done', check: null, instruction: null, named: null },
    clock - 2 * hour
  );
  service.todos.updateTodo(item, { state }, clock - 2 * hour);
}

test('only stale open asks without active, waiting or questioned work receive the wake', async () => {
  ask('empty');
  ask('recent', clock - 2 * hour + 1);
  for (const state of ['todo', 'doing', 'blocked', 'done'] as const) {
    ask(state);
    todo(state, state);
  }
  ask('question');
  service.todos.askQuestion(
    'question',
    'question',
    {
      text: 'Choose',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      startTodos: null,
      confirm: null,
      document: null,
      replyTo: [],
      todoId: null,
      artifacts: [],
    },
    clock - 2 * hour
  );
  const closed = ask('closed');
  service.todos.settleAsk(closed, 'done', 'Settled', clock - 2 * hour);
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell.mock.calls.map((call) => call[0]).sort()).toEqual([
    'recipient-blocked',
    'recipient-done',
    'recipient-empty',
  ]);
  expect(
    tell.mock.calls.every(
      (call) => String(call[2]).includes(note) && String(call[2]).includes('Ask:')
    )
  ).toBe(true);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(3);
});

test('a wake repeats no sooner than four hours and concurrent refreshes send once', async () => {
  ask('empty');
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await Promise.all([service.refreshDriverWork(), service.refreshDriverWork()]);
  expect(tell).toHaveBeenCalledTimes(1);
  clock += 4 * hour - 1;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  clock++;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
  expect(tell.mock.calls[0][1]).not.toEqual(tell.mock.calls[1][1]);
});

test('failed handoff retries the same wake identity without consuming the cooldown', async () => {
  ask('empty');
  const tell = spyOn(service, 'deliverForward')
    .mockRejectedValueOnce(new Error('Synthetic unavailable'))
    .mockResolvedValue(undefined);
  await service.refreshDriverWork();
  clock += 60_000;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
  expect(tell.mock.calls[0][1]).toEqual(tell.mock.calls[1][1]);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
});

test('new todo activity restarts the inactivity clock before a later wake', async () => {
  ask('active');
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  clock += 4 * hour;
  const step = service.todos.addTodo(
    'next',
    'active',
    { title: 'Next', doneWhen: 'Done', check: null, instruction: null, named: null },
    clock
  );
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  service.todos.updateTodo(step, { state: 'done' }, clock);
  clock += 2 * hour - 1;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  clock++;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
});
