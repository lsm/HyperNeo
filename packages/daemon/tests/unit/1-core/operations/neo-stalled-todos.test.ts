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
function add(id: string, state: 'doing' | 'blocked' = 'blocked') {
  const todo = service.todos.addTodo(
    id,
    'ask',
    { title: id, doneWhen: 'Done', check: null, instruction: null, named: null },
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

test('a stalled todo in a busy, questioned ask gets steer then two queued reminders, then stays visible', async () => {
  add('stuck');
  clock += 2 * hour - 1;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(0);
  clock++;
  await Promise.all([service.refreshDriverWork(), service.refreshDriverWork()]);
  expect(notes()).toHaveLength(1);
  expect(notes()[0].deliveryMode).toBe('immediate');
  expect(notes()[0].message.message.content).toContain('stuck');
  expect(notes()[0].message.neoWakeEvent).toBe(true);
  await consume(0);
  for (let count = 2; count <= 3; count++) {
    clock += 2 * hour - 1;
    await service.refreshDriverWork();
    expect(notes()).toHaveLength(count - 1);
    clock++;
    await service.refreshDriverWork();
    expect(notes()).toHaveLength(count);
    expect(notes()[count - 1].deliveryMode).toBe('defer');
    await consume(count - 1);
  }
  clock += 24 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(3);
  expect(service.todos.getTodo('stuck')?.blockedBy).toBe('stalled');
});

test('admission is not delivery and a failed input retries without spending a reminder', async () => {
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  clock += 4 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
  await consume(0, 'failed');
  expect(notes()).toHaveLength(2);
  expect(notes()[1].deliveryMode).toBe('immediate');
  expect(notes()[1].messageUuid).not.toBe(notes()[0].messageUuid);
  await consume(1);
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(3);
  expect(notes()[2].deliveryMode).toBe('defer');
});

test('each stalled todo owns its clock and activity on a sibling does not reset it', async () => {
  add('first');
  clock += hour;
  add('second');
  clock += hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
  expect(notes()[0].message.message.content).toContain('first');
  await consume(0);
  const first = service.todos.getTodo('first')!;
  service.todos.commitState('first', { blockedReason: 'Neo acted' }, clock, {
    state: 'no_opinion',
  });
  clock += hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  expect(notes()[1].message.message.content).toContain('second');
  clock += hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(3);
  expect(notes()[2].deliveryMode).toBe('immediate');
  expect(service.todos.getTodo('first')?.updatedAt).toBeGreaterThan(first.updatedAt);
});

test('a terminal mailbox failure without an SDK row does not count as delivery', async () => {
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  db.getDatabase()
    .prepare("UPDATE job_queue SET status='dead', error='Synthetic failure' WHERE queue='mailbox'")
    .run();
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  expect(notes()[1].deliveryMode).toBe('immediate');
});

test('completed todos and archived recipients stay quiet', async () => {
  add('done');
  add('stuck');
  service.todos.commitState('done', { state: 'done' }, clock, { state: 'done' });
  db.getDatabase().prepare("UPDATE sessions SET status='archived' WHERE id='neo'").run();
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(0);
});

test('a failed queued reminder retries queued and preserves the remaining delivery budget', async () => {
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  await consume(0);
  clock += 2 * hour;
  await service.refreshDriverWork();
  await consume(1, 'failed');
  expect(notes()).toHaveLength(3);
  expect(notes()[2].deliveryMode).toBe('defer');
  await consume(2);
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(4);
  await consume(3);
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(4);
});

test('a stalled-only ask gets one todo reminder while the daily inventory still counts it', async () => {
  service.todos.commitState('busy', { state: 'done' }, clock, { state: 'done' });
  service.todos.retireQuestions('ask', clock);
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
  expect(notes()[0].message.message.content).toContain('stuck');
  expect(service.todos.listStalledAsks(clock - 2 * hour)).toHaveLength(1);
});

test('a delayed refresh measures the repeat from consumption, not the later observation', async () => {
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  const entry = notes()[0];
  const dbId = await db.saveUserMessage(
    'neo',
    {
      ...entry.message,
      type: 'user',
      uuid: entry.messageUuid,
      session_id: 'neo',
      message: { role: 'user', content: entry.message.message.content },
    },
    'consumed'
  );
  db.getSDKMessageRepo().updateMessageTimestamp(dbId, clock);
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  expect(notes()[1].deliveryMode).toBe('defer');
});

test('a consumed reminder later marked failed is removed from the delivered budget', async () => {
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  await consume(0);
  await db
    .getSDKMessageRepo()
    .write('markDeliveryFailedByUuidInclusive', 'neo', notes()[0].messageUuid);
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  expect(notes()[1].deliveryMode).toBe('immediate');
});

test('turn-end consumption refreshes an old receipt before its separate timestamp follow-up', async () => {
  clock = new Date().getTime() - 4 * hour;
  add('stuck');
  clock += 2 * hour;
  await service.refreshDriverWork();
  const entry = notes()[0];
  const dbId = await db.saveUserMessage(
    'neo',
    {
      ...entry.message,
      type: 'user',
      uuid: entry.messageUuid,
      session_id: 'neo',
      message: { role: 'user', content: entry.message.message.content },
    },
    'enqueued'
  );
  db.getSDKMessageRepo().updateMessageTimestamp(dbId, clock);
  clock += 2 * hour;
  const resultUuid = crypto.randomUUID();
  await db.saveSDKMessage('neo', {
    type: 'result',
    subtype: 'success',
    uuid: resultUuid,
    parent_tool_use_id: null,
    is_error: false,
  } as unknown as SDKMessage);
  const consumed = await db
    .getSDKMessageRepo()
    .write('markDeliveriesConsumedAtTurnEnd', 'neo', [entry.messageUuid], resultUuid);
  expect(consumed.ids).toEqual([dbId]);
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(1);
  clock = new Date().getTime() + 2 * hour;
  await service.refreshDriverWork();
  expect(notes()).toHaveLength(2);
  expect(notes()[1].deliveryMode).toBe('defer');
});
