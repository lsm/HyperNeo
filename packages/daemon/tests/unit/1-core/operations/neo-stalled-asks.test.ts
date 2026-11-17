import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createCleanupHandler } from '../../../../src/lib/job-handlers/cleanup.handler.ts';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository.ts';
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
const root = 'neo-root';
function session(id: string, at = clock) {
  db.getDatabase()
    .prepare(
      'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      'Synthetic',
      'general',
      '/synthetic',
      new Date(at).toISOString(),
      new Date(at).toISOString(),
      'active',
      '{}',
      '{}'
    );
}
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
  session(root);
  service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
});
afterEach(async () => {
  await service.dispose();
  now.mockRestore();
  db.close();
});
function ask(id: string, at = clock - 2 * hour, sessionId = root) {
  return service.todos.openAsk({
    id,
    sessionId,
    projectId: null,
    originMessageId: null,
    title: id,
    request: 'Synthetic work',
    createdAt: at,
  });
}
function todo(askId: string, state: 'todo' | 'doing' | 'blocked' | 'done' | 'removed') {
  const item = service.todos.addTodo(
    'todo-' + askId,
    askId,
    { title: 'Step', doneWhen: 'Done', check: null, instruction: null, named: null },
    clock - 2 * hour
  );
  service.todos.updateTodo(item, { state }, clock - 2 * hour);
}
const told = (queue: 'mailbox' | 'neo_notes') =>
  (
    db
      .getDatabase()
      .prepare(
        "SELECT json_extract(payload, '$.message.message.content') AS text FROM job_queue WHERE queue = ? AND json_extract(payload, '$.to.sessionId') = ?"
      )
      .all(queue, root) as { text: string | null }[]
  )
    .map((row) => String(row.text))
    .filter((text) => text.startsWith('Ask: '))
    .sort();
const mailed = () =>
  (
    db
      .getDatabase()
      .prepare(
        "SELECT json_extract(payload, '$.message.message.content') AS text FROM job_queue WHERE queue = 'mailbox'"
      )
      .all() as { text: string | null }[]
  ).map((row) => String(row.text));
const wakes = () => told('mailbox');
const digests = () => told('neo_notes');
const idle = (id: string) => `Ask: ${id} (${id})\n${note}`;
const finished = (id: string) => `Ask: ${id} (${id})\n${finishedNote}`;
const failTell = (times: number) => {
  const entry = service as unknown as { attention(...args: unknown[]): Promise<unknown> };
  const tell = entry.attention;
  let left = times;
  return spyOn(entry, 'attention').mockImplementation(async (...args) => {
    if (left-- > 0) throw new Error('Synthetic unavailable');
    return tell(...args);
  });
};

test('an idle ask with no todo left is a digest line and a finished ask wakes Neo', async () => {
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
  await service.refreshDriverWork();
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('empty')]);
  expect(wakes()).toEqual([finished('done')]);
});

test('Neo is woken when the last todo ends, once more a day later, and again after new work', async () => {
  ask('finished', clock);
  todo('finished', 'doing');
  await service.refreshDriverWork();
  expect(wakes()).toEqual([]);
  clock += 1;
  service.todos.updateTodo(service.todos.getTodo('todo-finished')!, { state: 'done' }, clock);
  await service.refreshDriverWork();
  await service.refreshDriverWork();
  expect(wakes()).toEqual([finished('finished')]);
  clock += 4 * hour;
  await service.refreshDriverWork();
  expect(wakes()).toHaveLength(1);
  clock += 20 * hour;
  await service.refreshDriverWork();
  expect(wakes()).toHaveLength(2);
  clock += 48 * hour;
  await service.refreshDriverWork();
  expect(wakes()).toHaveLength(2);
  const item = service.todos.getTodo('todo-finished')!;
  service.todos.updateTodo(item, { state: 'doing' }, clock);
  clock += 1;
  service.todos.updateTodo(service.todos.getTodo(item.id)!, { state: 'done' }, clock);
  await service.refreshDriverWork();
  expect(wakes()).toHaveLength(3);
  expect(digests()).toEqual([]);
});

test('writing the outcome does not wake Neo about the same finish again', async () => {
  ask('finished', clock);
  todo('finished', 'done');
  await service.refreshDriverWork();
  clock += 60_000;
  service.todos.recordAskOutcome('finished', 'Shipped', clock);
  await service.refreshDriverWork();
  expect(wakes()).toEqual([finished('finished')]);
});

test('an unfinished ask still waits two hours', async () => {
  ask('removed', clock);
  todo('removed', 'doing');
  service.todos.updateTodo(service.todos.getTodo('todo-removed')!, { state: 'removed' }, clock);
  ask('empty-recent', clock);
  await service.refreshDriverWork();
  expect([...wakes(), ...digests()]).toEqual([]);
  clock += 2 * hour;
  await service.refreshDriverWork();
  expect(wakes()).toEqual([]);
  expect(digests()).toEqual([idle('empty-recent'), idle('removed')]);
});

test('an ask with a failed todo is the todo’s own step, not an idle ask', async () => {
  ask('failed', clock);
  const item = service.todos.addTodo(
    'todo-failed',
    'failed',
    {
      title: 'Step',
      doneWhen: 'Done',
      check: null,
      instruction: 'Do it.',
      named: null,
      approvedAt: clock,
    },
    clock
  );
  service.todos.updateTodo(
    item,
    { state: 'blocked', blockedBy: 'failure', blockedReason: 'No network' },
    clock
  );
  clock += 2 * hour;
  await service.sweepPacks();
  await service.refreshDriverWork();
  expect(digests()).toEqual([]);
  expect(
    mailed().filter((text) => text.includes('(todo-failed) needs your next step'))
  ).toHaveLength(1);
});

test('an idle ask is told again after a card is answered, with no todo change', async () => {
  ask('quiet', clock - 2 * hour);
  todo('quiet', 'removed');
  await service.refreshDriverWork();
  clock += 24 * hour;
  await service.refreshDriverWork();
  clock += 24 * hour;
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('quiet'), idle('quiet')]);
  const card = service.todos.askQuestion(
    'card',
    'quiet',
    {
      text: 'Choose',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      confirm: null,
      document: null,
      replyTo: [],
      todoId: null,
      artifacts: [],
    },
    clock
  );
  service.todos.answerQuestion(card, true as never, 'button', clock);
  clock += 2 * hour - 1;
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(2);
  clock += 1;
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('quiet'), idle('quiet'), idle('quiet')]);
});

test('an idle ask whose reminder was read settles once the card answer is read, with no second reminder', async () => {
  ask('quiet', clock - 2 * hour);
  todo('quiet', 'removed');
  await service.refreshDriverWork();
  clock += 16 * 60_000;
  await service.refreshDriverWork();
  const raw = db.getDatabase();
  let turn = 0;
  const row = (kind: 'user' | 'result', uuid?: string) =>
    raw
      .prepare(`INSERT INTO sdk_messages
        (seq, id, session_id, message_type, sdk_message, timestamp, sdk_uuid, consumed_seq,
         is_terminal, send_status)
        VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM sdk_messages), ?, ?, ?, ?, ?, ?, ?, ?, 'consumed')`)
      .run(
        `turn-${++turn}`,
        root,
        kind,
        JSON.stringify({ type: kind }),
        new Date(clock).toISOString(),
        uuid ?? `turn-${turn}`,
        10 + turn,
        kind === 'result' ? 1 : 0
      );
  expect(
    raw
      .prepare(`UPDATE sdk_messages SET consumed_seq = 10, send_status = 'consumed'
        WHERE session_id = ? AND message_type = 'user' AND sdk_message LIKE '%Ask: quiet (quiet)%'`)
      .run(root).changes
  ).toBe(1);
  const card = service.todos.askQuestion(
    'card',
    'quiet',
    {
      text: 'Choose',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      confirm: null,
      document: null,
      replyTo: [],
      todoId: null,
      artifacts: [],
    },
    clock
  );
  row('result');
  await service.refreshDriverWork();
  expect(service.todos.getAsk('quiet')?.status).toBe('open');
  clock += hour;
  service.todos.answerQuestion(card, true as never, 'button', clock);
  await service.refreshDriverWork();
  expect(service.todos.getAsk('quiet')?.status).toBe('open');
  row('user', 'neo-question:card');
  row('result');
  await service.refreshDriverWork();
  expect(service.todos.getAsk('quiet')?.status).toBe('dropped');
  expect(digests()).toEqual([idle('quiet')]);
});

test('a parent with an open child is not finished', async () => {
  ask('parent', clock);
  todo('parent', 'done');
  service.todos.updateTodo(service.todos.getTodo('todo-parent')!, { state: 'done' }, clock);
  service.todos.openAsk({
    id: 'child',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    title: 'child',
    request: 'Synthetic work',
    createdAt: clock,
    parentId: 'parent',
  });
  await service.refreshDriverWork();
  expect([...wakes(), ...digests()]).toEqual([]);
});

test('an idle ask is told once, once more after a day, and concurrent refreshes send once', async () => {
  ask('empty');
  await Promise.all([service.refreshDriverWork(), service.refreshDriverWork()]);
  expect(digests()).toHaveLength(1);
  clock += 4 * hour;
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(1);
  clock += 18 * hour - 1;
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(1);
  clock++;
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(2);
  clock += 48 * hour;
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('empty'), idle('empty')]);
  expect(wakes()).toEqual([]);
});

test('a tell that failed is made again on the next refresh', async () => {
  ask('empty');
  const tell = failTell(1);
  await service.refreshDriverWork();
  expect(digests()).toEqual([]);
  clock += 60_000;
  await service.refreshDriverWork();
  await service.refreshDriverWork();
  expect(tell).toHaveBeenCalledTimes(3);
  expect(digests()).toEqual([idle('empty')]);
});

test('new todo activity restarts the inactivity clock before a later note', async () => {
  ask('active');
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(1);
  clock += 4 * hour;
  const step = service.todos.addTodo(
    'next',
    'active',
    { title: 'Next', doneWhen: 'Done', check: null, instruction: null, named: null },
    clock
  );
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(1);
  service.todos.updateTodo(step, { state: 'removed' }, clock);
  clock += 2 * hour - 1;
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(1);
  clock++;
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(2);
});

test('one failed tell does not block other asks or session watching', async () => {
  ask('first');
  ask('second');
  failTell(1);
  await service.refreshDriverWork();
  expect(digests()).toHaveLength(1);
  expect(service.sessionWatcher.watchSessions).toHaveBeenCalledTimes(1);
  clock += 60_000;
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('first'), idle('second')]);
});

test('asks whose own session is deleted or archived are not told', async () => {
  ask('live');
  for (const id of ['deleted', 'archived']) {
    session('recipient-' + id);
    ask(id, clock - 2 * hour, 'recipient-' + id);
  }
  db.getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run('recipient-deleted');
  db.getDatabase()
    .prepare("UPDATE sessions SET status = 'archived' WHERE id = ?")
    .run('recipient-archived');
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('live')]);
});

test('a stalled-ask query failure never suppresses the independent session watcher', async () => {
  ask('live');
  spyOn(service.todos, 'listStalledAsks').mockImplementation(() => {
    throw new Error('Synthetic query fault');
  });
  await service.refreshDriverWork();
  expect(service.sessionWatcher.watchSessions).toHaveBeenCalledTimes(1);
});

test('a watcher failure never suppresses the stalled-ask note', async () => {
  ask('live');
  spyOn(service.sessionWatcher, 'watchSessions').mockRejectedValue(
    new Error('Synthetic watcher fault')
  );
  await service.refreshDriverWork();
  expect(digests()).toEqual([idle('live')]);
});

test('an idle ask is not delivered a third time once its queue rows are cleaned up', async () => {
  ask('empty');
  const delivered = () =>
    (
      db
        .getDatabase()
        .prepare(
          "SELECT sdk_message AS body FROM sdk_messages WHERE session_id = ? AND message_type = 'user'"
        )
        .all(root) as { body: string }[]
    ).filter((row) => row.body.includes('Ask: empty (empty)')).length;
  const refreshAndFlush = async () => {
    await service.refreshDriverWork();
    clock += 16 * 60_000;
    await service.refreshDriverWork();
  };
  await refreshAndFlush();
  expect(delivered()).toBe(1);
  clock += 22 * hour;
  await refreshAndFlush();
  expect(delivered()).toBe(2);
  clock += 8 * 24 * hour;
  const cleaned = await createCleanupHandler(db.getJobQueueRepo())({} as Job);
  expect(cleaned.deletedJobs).toBeGreaterThanOrEqual(2);
  expect(digests()).toEqual([]);
  await refreshAndFlush();
  expect(digests()).toEqual([]);
  expect(delivered()).toBe(2);
});
