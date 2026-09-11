import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createDirectKickoffRecorder } from '../../../../src/lib/space/runtime/direct-kickoff-intent';
import { createDirectKickoffReconciler } from '../../../../src/lib/space/runtime/reconcile-direct-kickoff';
import { captureDirectMailboxAdmission } from '../../../../src/lib/space/runtime/direct-mailbox-admission';
import { planMailboxAdmission } from '../../../../src/lib/mailbox/admission-plan';
import { ensurePrompt } from '../../../../src/lib/agent/message-delivery-outbox';
import type { MailboxEntry } from '../../../../src/lib/mailbox/entry';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import { createTestSession } from '../../../helpers/database';
import type { Session } from '@hyperneo/shared';

let db: Database;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let taskId: string;
let spaceId: string;
let live: Session;
let entry: MailboxEntry;
const input = { sessionId: 'worker', attemptId: 'attempt', generation: 1 };
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  live = {
    ...createTestSession(input.sessionId),
    type: 'worker',
    workspacePath: '/repo',
    context: { spaceId, taskId },
  };
  sessions.createSession(live, { enforceWorkspaceOwnership: false });
  attempts.select(taskId);
  attempts.claim(taskId, input.attemptId, input.sessionId);
  const recorded = createDirectKickoffRecorder(db)({
    ...input,
    message: { type: 'user', message: { content: 'Task prompt' }, parent_tool_use_id: null },
  });
  if (!recorded.recorded) throw new Error('Expected kickoff');
  entry = recorded.entry;
});
afterEach(() => db.close());
function activate() {
  attempts.activate(input.attemptId, input.sessionId);
  tasks.updateTask(taskId, { status: 'in_progress', taskAgentSessionId: input.sessionId });
}
function materialize() {
  expect(createDirectKickoffReconciler(db)(input)?.kind).toBe('enqueued');
  const plan = planMailboxAdmission({
    ...entry,
    to: { kind: 'session', sessionId: input.sessionId },
  });
  ensurePrompt({
    ...plan,
    db,
    sdkMessageRepo: new SDKMessageRepository(db),
    jobQueue: new JobQueueRepository(db),
  });
}
function guard(message = entry) {
  return captureDirectMailboxAdmission(db, message)!;
}

test('ordinary sessions keep the normal mailbox path', () => {
  expect(
    captureDirectMailboxAdmission(db, { ...entry, to: { kind: 'session', sessionId: 'ordinary' } })
  ).toBeUndefined();
});
test('reserved capture never gains admission after activation', () => {
  const check = guard();
  expect(check()).toBe('blocked');
  activate();
  createDirectKickoffReconciler(db)(input);
  expect(check()).toBe('blocked');
  expect(guard()()).toBe('admit');
});
test('kickoff needs its receipt but no materialized SDK row', () => {
  activate();
  expect(guard()()).toBe('blocked');
  createDirectKickoffReconciler(db)(input);
  expect(guard()()).toBe('admit');
  expect(
    new SDKMessageRepository(db).getDeliveryContent(input.sessionId, entry.messageUuid!)
  ).toBeNull();
});
test.each(['stop', 'paused', 'deleted', 'pointer', 'workspace', 'intent', 'input'] as const)(
  '%s after capture blocks delivery without materializing a prompt',
  (change) => {
    activate();
    createDirectKickoffReconciler(db)(input);
    const check = guard();
    if (change === 'stop') attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
    if (change === 'paused') new SpaceRepository(db).pauseSpace(spaceId);
    if (change === 'deleted') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
    if (change === 'pointer') tasks.updateTask(taskId, { taskAgentSessionId: 'other' });
    if (change === 'workspace') {
      tasks.updateTask(taskId, { workspacePath: '/other' });
      sessions.updateSession(input.sessionId, { workspacePath: '/other' });
    }
    if (change === 'intent')
      db.prepare('UPDATE direct_task_kickoff_intents SET entry = ?').run(
        JSON.stringify({ ...entry, origin: 'chat' })
      );
    if (change === 'input') entry.policy.ttlMs *= 2;
    expect(check()).toBe('blocked');
    expect(
      new SDKMessageRepository(db).getDeliveryContent(input.sessionId, entry.messageUuid!)
    ).toBeNull();
  }
);
test.each(['consumed', 'failed'] as const)(
  'settled %s kickoff never becomes retryable',
  (status) => {
    activate();
    materialize();
    const check = guard();
    expect(check()).toBe('admit');
    db.prepare('UPDATE sdk_messages SET send_status = ? WHERE session_id = ?').run(
      status,
      input.sessionId
    );
    expect(check()).toBe('settled');
    const settled = guard();
    db.prepare("UPDATE sdk_messages SET send_status = 'enqueued' WHERE session_id = ?").run(
      input.sessionId
    );
    expect(settled()).toBe('settled');
  }
);
test('later ordinary messages preserve normal failed-message handling under owner admission', () => {
  activate();
  materialize();
  db.prepare("UPDATE sdk_messages SET send_status = 'failed' WHERE session_id = ?").run(
    input.sessionId
  );
  const later = { ...entry, id: createUlid(), messageUuid: 'later-message' };
  const check = guard(later);
  expect(check()).toBe('admit');
  attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
  expect(check()).toBe('blocked');
});
test('kickoff identity collisions reject modified payloads', () => {
  activate();
  createDirectKickoffReconciler(db)(input);
  expect(guard({ ...entry, id: createUlid() })()).toBe('blocked');
  expect(guard({ ...entry, messageUuid: 'changed' })()).toBe('blocked');
});
test('elapsed TTL is not renewed by mutating both input and stored policy', () => {
  activate();
  createDirectKickoffReconciler(db)(input);
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    const check = guard();
    const ttl = entry.policy.ttlMs;
    clock.mockReturnValue(Date.now() + ttl + 1000);
    expect(check()).toBe('blocked');
    entry.policy.ttlMs *= 3;
    db.prepare('UPDATE direct_task_kickoff_intents SET entry = ?').run(JSON.stringify(entry));
    expect(guard()()).toBe('admit');
    expect(check()).toBe('blocked');
  } finally {
    clock.mockRestore();
  }
});

test.each(['valid', 'stopped', 'settled'] as const)(
  'mailbox wire rechecks %s owner after session loading',
  async (change) => {
    activate();
    createDirectKickoffReconciler(db)(input);
    const jobs = new JobQueueRepository(db);
    const sdk = new SDKMessageRepository(db);
    const [job] = jobs.dequeue('mailbox');
    const publish = mock(() => {});
    const getSession = mock(async () => {
      await Promise.resolve();
      if (change === 'stopped') attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
      if (change === 'settled') {
        ensurePrompt({
          ...planMailboxAdmission({
            ...entry,
            to: { kind: 'session', sessionId: input.sessionId },
          }),
          db,
          sdkMessageRepo: sdk,
          jobQueue: jobs,
        });
        db.prepare("UPDATE sdk_messages SET send_status = 'failed' WHERE session_id = ?").run(
          input.sessionId
        );
      }
      return {};
    });
    const handler = createMailboxDeliveryHandler({
      db,
      jobQueue: jobs,
      sdkMessageRepo: sdk,
      getSession,
      isSessionArchived: () => false,
      captureAdmission: (incoming) => captureDirectMailboxAdmission(db, incoming),
      publishStatusChanged: publish,
    });
    if (change === 'stopped') {
      await expect(handler(job)).rejects.toThrow('direct owner unavailable');
      expect(sdk.getDeliveryContent(input.sessionId, entry.messageUuid!)).toBeNull();
    } else if (change === 'settled') {
      expect(await handler(job)).toEqual({ outcome: 'already_settled' });
      expect(sdk.getDeliveryContent(input.sessionId, entry.messageUuid!)?.sendStatus).toBe(
        'failed'
      );
    } else {
      await handler(job);
      expect(sdk.getDeliveryContent(input.sessionId, entry.messageUuid!)?.sendStatus).toBe(
        'enqueued'
      );
    }
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(change === 'valid' ? 1 : 0);
  }
);
test('mailbox does not load a stopped direct session', async () => {
  activate();
  createDirectKickoffReconciler(db)(input);
  const jobs = new JobQueueRepository(db);
  const [job] = jobs.dequeue('mailbox');
  attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
  const getSession = mock(async () => ({}));
  const handler = createMailboxDeliveryHandler({
    db,
    jobQueue: jobs,
    sdkMessageRepo: new SDKMessageRepository(db),
    getSession,
    isSessionArchived: () => false,
    captureAdmission: (incoming) => captureDirectMailboxAdmission(db, incoming),
  });
  await expect(handler(job)).rejects.toThrow('direct owner unavailable');
  expect(getSession).not.toHaveBeenCalled();
});
