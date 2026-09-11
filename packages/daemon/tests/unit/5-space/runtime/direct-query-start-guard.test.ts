import { afterEach, beforeEach, expect, test } from 'bun:test';
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
import { createDirectQueryStartGuard } from '../../../../src/lib/space/runtime/direct-query-start-guard';
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
function guard() {
  return createDirectQueryStartGuard(db, () => live);
}

test('ordinary sessions keep the unguarded path', () => {
  expect(createDirectQueryStartGuard(db, () => createTestSession('ordinary'))).toBeUndefined();
});
test('reservation, missing receipt and unmaterialized kickoff cannot start', () => {
  expect(guard).toThrow('executor activation admission');
  activate();
  expect(guard).toThrow('executor activation admission');
  createDirectKickoffReconciler(db)(input);
  expect(guard).toThrow('executor activation admission');
});
test('matching materialized kickoff permits startup and receipt remains required', () => {
  activate();
  materialize();
  const check = guard()!;
  expect(check).not.toThrow();
  db.exec('DELETE FROM direct_task_kickoff_dispatches');
  expect(check).toThrow('executor activation admission');
});
test.each(['stop', 'paused', 'deleted', 'pointer', 'workspace', 'coordinator', 'intent'] as const)(
  '%s during asynchronous startup invalidates the captured owner',
  (change) => {
    activate();
    materialize();
    const check = guard()!;
    if (change === 'stop') attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
    if (change === 'paused') new SpaceRepository(db).pauseSpace(spaceId);
    if (change === 'deleted') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
    if (change === 'pointer') tasks.updateTask(taskId, { taskAgentSessionId: 'other' });
    if (change === 'workspace') {
      tasks.updateTask(taskId, { workspacePath: '/other' });
      sessions.updateSession(input.sessionId, { workspacePath: '/other' });
      live = { ...live, workspacePath: '/other' };
    }
    if (change === 'coordinator')
      live = { ...live, config: { ...live.config, coordinatorMode: true } };
    if (change === 'intent')
      db.prepare('UPDATE direct_task_kickoff_intents SET entry = ? WHERE attempt_id = ?').run(
        JSON.stringify({ ...entry, id: createUlid() }),
        input.attemptId
      );
    expect(check).toThrow('executor activation admission');
  }
);
test.each(['failed', 'deferred'] as const)('%s kickoff remains blocked', (status) => {
  activate();
  materialize();
  db.prepare('UPDATE sdk_messages SET send_status = ? WHERE session_id = ? AND sdk_uuid = ?').run(
    status,
    input.sessionId,
    entry.messageUuid!
  );
  expect(guard).toThrow('executor activation admission');
});
test('expired unconsumed kickoff is blocked but consumed kickoff can resume the same active owner', () => {
  activate();
  materialize();
  entry = { ...entry, id: createUlid(Date.now() - entry.policy.ttlMs - 1000) };
  db.prepare('UPDATE direct_task_kickoff_intents SET entry = ? WHERE attempt_id = ?').run(
    JSON.stringify(entry),
    input.attemptId
  );
  expect(guard).toThrow('executor activation admission');
  db.prepare(
    "UPDATE sdk_messages SET send_status = 'consumed' WHERE session_id = ? AND sdk_uuid = ?"
  ).run(input.sessionId, entry.messageUuid!);
  expect(guard()!).not.toThrow();
});
