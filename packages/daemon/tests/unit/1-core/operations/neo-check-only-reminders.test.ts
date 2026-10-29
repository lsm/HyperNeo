import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { MessageHub } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const hour = 3_600_000;
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let clock: number;
let now: ReturnType<typeof spyOn>;
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
  db.getDatabase()
    .prepare(`INSERT INTO sessions
    (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES ('neo','Synthetic','general','/synthetic',?,?, 'active','{}','{}')`)
    .run(new Date(clock).toISOString(), new Date(clock).toISOString());
  service.todos.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Busy ask',
    request: 'Synthetic',
    createdAt: clock,
  });
  add('busy', 'doing');
  service.todos.askQuestion(
    'unrelated',
    'ask',
    {
      text: 'Unrelated choice',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      startTodos: null,
      confirm: null,
      document: null,
      replyTo: [],
      todoId: 'busy',
      artifacts: [],
    },
    clock
  );
});
afterEach(async () => {
  await service.dispose();
  now.mockRestore();
  db.close();
});
function add(id: string, state: 'todo' | 'doing' = 'todo') {
  const todo = service.todos.addTodo(
    id,
    'ask',
    {
      title: id,
      doneWhen: 'Done',
      check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/missing' } },
      instruction: null,
      named: null,
    },
    clock
  );
  return service.todos.commitState(
    todo.id,
    state === 'blocked' ? { state, blockedBy: 'stalled', blockedReason: 'No progress' } : { state },
    clock,
    { state: 'no_opinion' }
  ).todo!;
}
function notes() {
  return (
    db
      .getDatabase()
      .prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY rowid")
      .all() as { payload: string }[]
  ).map((row) => JSON.parse(row.payload));
}
async function consume(index: number, status: 'consumed' | 'failed' = 'consumed') {
  const entry = notes()[index];
  const dbId = await db.saveUserMessage(
    'neo',
    {
      ...entry.message,
      type: 'user',
      uuid: entry.messageUuid,
      session_id: 'neo',
      message: { role: 'user', content: entry.message.message.content },
    },
    status
  );
  db.getSDKMessageRepo().updateMessageTimestamp(dbId, clock);
  await service.refreshDriverWork();
}

test('a check-only todo queues one daily reminder to Neo, counting consumption rather than admission', async () => {
  add('queued');
  clock += 24 * hour - 1;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(0);
  clock++;
  await Promise.all([service.refreshDriverWork(), service.refreshDriverWork()]);
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatchObject({
    to: { kind: 'session', sessionId: 'neo' },
    deliveryMode: 'defer',
  });
  expect(notes()[0].message.message.content).toMatch(/instruction.*target.*hold.*remove/i);
  clock += 48 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
  await consume(0, 'failed');
  expect(notes()).toHaveLength(2);
  await consume(1);
  clock += 24 * hour - 1;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  clock++;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(3);
});

test('daily reminders continue beyond three deliveries while the todo stays queued', async () => {
  add('queued');
  for (let day = 0; day < 5; day++) {
    clock += 24 * hour;
    await service.refreshDriverWork();
    expect(notes()).toHaveLength(day + 1);
    await consume(day);
  }
  expect(service.todos.getTodo('queued')?.state).toBe('todo');
});

test.each(['instruction', 'target', 'held', 'removed', 'done', 'no-check'] as const)(
  '%s stops a check-only reminder',
  async (action) => {
    const todo = add('queued');
    clock += 24 * hour;
    await service.refreshDriverWork();
    expect(notes()).toHaveLength(1);
    await consume(0);
    if (action === 'instruction')
      service.todos.updateTodo(todo, { instruction: 'Do the work' }, clock);
    if (action === 'target')
      service.todoSessions.create(todo.id, {
        verb: 'send',
        ref: { adapter: 'hyperneo', id: 'worker' },
      });
    if (action === 'held')
      service.todos.commitState(todo.id, { state: 'blocked', blockedBy: 'held' }, clock, {
        state: 'no_opinion',
      });
    if (action === 'removed')
      service.todos.commitState(todo.id, { state: 'removed' }, clock, { state: 'no_opinion' });
    if (action === 'done')
      service.todos.commitState(todo.id, {}, clock, { state: 'done', evidence: 'Observed' });
    if (action === 'no-check') service.todos.updateTodo(todo, { check: null }, clock);
    clock += 48 * hour;
    await service.refreshDriverWork();
    expect(notes()).toHaveLength(1);
  }
);

test('changing the title does not restart the age of a check-only todo', async () => {
  const todo = add('queued');
  clock += 23 * hour;
  service.todos.updateTodo(todo, { title: 'Renamed waiting work' }, clock);
  clock += hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
});

test('a consumed receipt later marked failed does not spend the daily reminder', async () => {
  add('queued');
  clock += 24 * hour;
  await service.refreshDriverWork();
  await consume(0);
  await db
    .getSDKMessageRepo()
    .write('markDeliveryFailedByUuidInclusive', 'neo', notes()[0].messageUuid);
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
});

test('closing the ask stops its daily reminders', async () => {
  add('queued');
  clock += 24 * hour;
  await service.refreshDriverWork();
  await consume(0);
  service.todos.settleAsk(service.todos.getAsk('ask')!, 'dropped', 'Held elsewhere', clock);
  clock += 48 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
});
