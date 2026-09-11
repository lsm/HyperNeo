import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createDirectKickoffRecorder } from '../../../../src/lib/space/runtime/direct-kickoff-intent';
import { createDirectKickoffReconciler } from '../../../../src/lib/space/runtime/reconcile-direct-kickoff';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { type MailboxEntry } from '../../../../src/lib/mailbox/entry';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let directory: string;
let jobs: JobQueueRepository;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let taskId: string;
let spaceId: string;
let entry: MailboxEntry;
let reconcile: ReturnType<typeof createDirectKickoffReconciler>;
const input = { sessionId: 'worker', attemptId: 'attempt', generation: 1 };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'direct-kickoff-'));
  db = new Database(join(directory, 'db.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  new SessionRepository(db).createSession(
    {
      ...createTestSession(input.sessionId),
      type: 'worker',
      workspacePath: '/repo',
      context: { spaceId, taskId },
    },
    { enforceWorkspaceOwnership: false }
  );
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
  attempts.claim(taskId, input.attemptId, input.sessionId);
  const recorded = createDirectKickoffRecorder(db)({
    ...input,
    message: { type: 'user', message: { content: 'Frozen task prompt' }, parent_tool_use_id: null },
  });
  if (!recorded.recorded) throw new Error('Expected frozen intent');
  entry = recorded.entry;
  attempts.activate(input.attemptId, input.sessionId);
  tasks.updateTask(taskId, { status: 'in_progress', taskAgentSessionId: input.sessionId });
  jobs = new JobQueueRepository(db);
  reconcile = createDirectKickoffReconciler(db);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function service() {
  return Object.assign(Object.create(SpaceRuntimeService.prototype), {
    config: { db },
    started: false,
    resumeStalledRecoveryPromise: Promise.resolve(),
    runtime: { start: mock(() => {}), recoverStalledRunsForSpace: mock(async () => {}) },
    subscribeToSpaceEvents: mock(() => {}),
    provisionExistingSpaces: mock(async () => {}),
    recoverPendingOutcomeNotifications: mock(async () => {}),
    recoverStalledWorkflowRuns: mock(async () => {}),
  }) as SpaceRuntimeService;
}
function job() {
  return jobs.getLatestByPayload(MAILBOX_LANE, { id: entry.id });
}

test('startup reconciles activated attempts with missing dispatch without loading sessions', async () => {
  const svc = service();
  svc.start();
  await svc.ready();
  expect(job()?.payload).toEqual(entry);
  const first = job()!;
  svc.recoverDirectKickoffs();
  expect(job()?.id).toBe(first.id);
});
test('Space resume invokes reconciliation after workflow recovery and limits ownership scope', async () => {
  const svc = service();
  svc.recoverStalledWorkflowRunsAfterSpaceResume('unrelated-space');
  await (svc as unknown as { resumeStalledRecoveryPromise: Promise<void> })
    .resumeStalledRecoveryPromise;
  expect(job()).toBeNull();
  svc.recoverStalledWorkflowRunsAfterSpaceResume(spaceId);
  await (svc as unknown as { resumeStalledRecoveryPromise: Promise<void> })
    .resumeStalledRecoveryPromise;
  expect(job()?.payload).toEqual(entry);
});
test.each(['paused', 'stopped', 'reserved'] as const)(
  'scan cannot dispatch a %s attempt',
  (state) => {
    if (state === 'paused') new SpaceRepository(db).pauseSpace(spaceId);
    if (state === 'stopped') attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
    if (state === 'reserved')
      db.prepare("UPDATE direct_task_execution_attempts SET phase = 'reserved'").run();
    service().recoverDirectKickoffs();
    expect(job()).toBeNull();
  }
);
test.each(['processing', 'completed', 'dead'] as const)(
  'scan retains %s job and retry history',
  (status) => {
    reconcile(input);
    const original = job()!;
    db.prepare('UPDATE job_queue SET status = ?, retry_count = 3 WHERE id = ?').run(
      status,
      original.id
    );
    service().recoverDirectKickoffs();
    expect(job()).toMatchObject({
      id: original.id,
      status,
      retryCount: 3,
      maxRetries: original.maxRetries,
    });
    db.prepare('DELETE FROM job_queue WHERE id = ?').run(original.id);
    service().recoverDirectKickoffs();
    expect(job()).toBeNull();
  }
);
test('one corrupt intent does not prevent another running attempt from recovering', () => {
  db.prepare("UPDATE direct_task_kickoff_intents SET entry = 'invalid'").run();
  const nextTask = tasks.createTask({ spaceId, title: 'Other', description: '' });
  new SessionRepository(db).createSession(
    {
      ...createTestSession('other-worker'),
      type: 'worker',
      workspacePath: '/repo',
      context: { spaceId, taskId: nextTask.id },
    },
    { enforceWorkspaceOwnership: false }
  );
  attempts.select(nextTask.id);
  attempts.claim(nextTask.id, 'other-attempt', 'other-worker');
  const recorded = createDirectKickoffRecorder(db)({
    attemptId: 'other-attempt',
    sessionId: 'other-worker',
    message: entry.message,
  });
  if (!recorded.recorded) throw new Error('Expected other intent');
  attempts.activate('other-attempt', 'other-worker');
  tasks.updateTask(nextTask.id, { status: 'in_progress', taskAgentSessionId: 'other-worker' });
  service().recoverDirectKickoffs(spaceId);
  expect(job()).toBeNull();
  expect(jobs.getLatestByPayload(MAILBOX_LANE, { id: recorded.entry.id })).not.toBeNull();
});
