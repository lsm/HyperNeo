import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const hour = 3_600_000;
let clock: number;
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let now: ReturnType<typeof spyOn>;
const note = 'This ask has nothing in progress. Add the next todo, or settle it.';
const finishedNote =
  'All todos are finished: write the outcome with neo.ask.settle, or add the next todo.';
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
  db.getDatabase()
    .prepare(
      'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      'recipient-' + id,
      'Synthetic',
      'general',
      '/synthetic',
      new Date(at).toISOString(),
      new Date(at).toISOString(),
      'active',
      '{}',
      '{}'
    );
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
  for (const [recipient, , text] of tell.mock.calls) {
    expect(String(text)).toContain('Ask:');
    expect(String(text)).toContain(recipient === 'recipient-done' ? finishedNote : note);
  }
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(3);
});

test('Neo is told when the last todo ends, then on the repeat, and again after new work', async () => {
  ask('finished', clock);
  todo('finished', 'doing');
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(0);
  clock += 1;
  service.todos.updateTodo(service.todos.getTodo('todo-finished')!, { state: 'done' }, clock);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  expect(String(tell.mock.calls[0][2])).toContain(finishedNote);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  clock += 4 * hour;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
  clock += 1;
  const item = service.todos.getTodo('todo-finished')!;
  service.todos.updateTodo(item, { state: 'doing' }, clock);
  clock += 1;
  service.todos.updateTodo(service.todos.getTodo(item.id)!, { state: 'done' }, clock);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(3);
});

test('an unfinished ask still waits two hours', async () => {
  ask('failed', clock);
  todo('failed', 'doing');
  service.todos.updateTodo(service.todos.getTodo('todo-failed')!, { state: 'failed' }, clock);
  ask('empty-recent', clock);
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(0);
});

test('a parent with an open child is not finished', async () => {
  ask('parent', clock);
  todo('parent', 'done');
  service.todos.updateTodo(service.todos.getTodo('todo-parent')!, { state: 'done' }, clock);
  service.todos.openAsk({
    id: 'child',
    sessionId: 'recipient-parent',
    projectId: null,
    originMessageId: null,
    title: 'child',
    request: 'Synthetic work',
    createdAt: clock,
    parentId: 'parent',
  });
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(0);
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
  service.todos.updateTodo(step, { state: 'removed' }, clock);
  clock += 2 * hour - 1;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(1);
  clock++;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
});

test('one failed mailbox handoff does not block other asks or session watching', async () => {
  ask('first');
  ask('second');
  const tell = spyOn(service, 'deliverForward')
    .mockRejectedValueOnce(new Error('Synthetic unavailable'))
    .mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(2);
  expect(service.sessionWatcher.watchSessions).toHaveBeenCalledTimes(1);
  clock += 60_000;
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(3);
  expect(tell.mock.calls[2][1]).toEqual(tell.mock.calls[0][1]);
});

test('asks with deleted or archived recipients do not create doomed wake jobs', async () => {
  ask('live');
  ask('deleted');
  ask('archived');
  db.getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run('recipient-deleted');
  db.getDatabase()
    .prepare("UPDATE sessions SET status = 'archived' WHERE id = ?")
    .run('recipient-archived');
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell.mock.calls.map((call) => call[0])).toEqual(['recipient-live']);
  clock += 4 * hour;
  await service.refreshDriverWork();
  expect(tell.mock.calls.map((call) => call[0])).toEqual(['recipient-live', 'recipient-live']);
});

test('a stalled-ask query failure never suppresses the independent session watcher', async () => {
  ask('live');
  spyOn(service.todos, 'listStalledAsks').mockImplementation(() => {
    throw new Error('Synthetic query fault');
  });
  await service.refreshDriverWork();
  expect(service.sessionWatcher.watchSessions).toHaveBeenCalledTimes(1);
});

test('a watcher failure never suppresses the stalled-ask wake', async () => {
  ask('live');
  spyOn(service.sessionWatcher, 'watchSessions').mockRejectedValue(
    new Error('Synthetic watcher fault')
  );
  const tell = spyOn(service, 'deliverForward').mockResolvedValue(undefined);
  await service.refreshDriverWork();
  expect(tell.mock.calls.map((call) => call[0])).toEqual(['recipient-live']);
});
