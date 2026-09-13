import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
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
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { type MailboxEntry } from '../../../../src/lib/mailbox/entry';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
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
let templateDirectory: string;
let templatePath: string;
const input = { sessionId: 'worker', attemptId: 'attempt', generation: 1 };
beforeAll(() => {
  templateDirectory = mkdtempSync(join(tmpdir(), 'direct-kickoff-template-'));
  templatePath = join(templateDirectory, 'template.sqlite');
  const template = new Database(':memory:');
  try {
    template.exec('PRAGMA foreign_keys = ON');
    runMigrations(template, () => {});
    createTables(template);
    template.exec(`VACUUM INTO '${templatePath}'`);
  } finally {
    template.close();
  }
});
afterAll(() => {
  rmSync(templateDirectory, { recursive: true, force: true });
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'direct-kickoff-'));
  copyFileSync(templatePath, join(directory, 'db.sqlite'));
  db = new Database(join(directory, 'db.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
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

function jobFor(id: string) {
  return jobs.getLatestByPayload(MAILBOX_LANE, { id });
}
function job() {
  return jobFor(entry.id);
}
function receiptCount() {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM direct_task_kickoff_dispatches').get() as {
      count: number;
    }
  ).count;
}

test('recovery enqueues frozen IDs once and another connection retains the existing retry budget', () => {
  const first = reconcile(input);
  expect(first).toMatchObject({ kind: 'enqueued' });
  expect(job()?.payload).toEqual(entry);
  expect(job()?.maxRetries).toBe(entry.policy.maxAttempts - 1);
  db.prepare('UPDATE job_queue SET retry_count = 2 WHERE id = ?').run(job()!.id);
  const peer = new Database(join(directory, 'db.sqlite'));
  try {
    const recovered = createDirectKickoffReconciler(peer)(input);
    expect(recovered).toEqual({ kind: 'existing', jobId: job()!.id, status: 'pending' });
    expect(job()?.retryCount).toBe(2);
    expect(receiptCount()).toBe(1);
  } finally {
    peer.close();
  }
});

test.each(['pending', 'processing', 'completed', 'failed', 'dead'] as const)(
  'existing %s jobs are adopted without re-enqueueing',
  (status) => {
    enqueueMailboxEntry(jobs, entry);
    const existingId = job()!.id;
    db.prepare('UPDATE job_queue SET status = ?, retry_count = 3 WHERE id = ?').run(
      status,
      existingId
    );
    expect(reconcile(input)).toEqual({ kind: 'existing', jobId: existingId, status });
    expect(job()?.retryCount).toBe(3);
    expect(receiptCount()).toBe(1);
  }
);

test.each(['completed', 'failed', 'dead'] as const)(
  'pruned %s dispatch never gains a new retry budget',
  (status) => {
    reconcile(input);
    db.prepare('UPDATE job_queue SET status = ?, completed_at = 1 WHERE id = ?').run(
      status,
      job()!.id
    );
    expect(jobs.cleanup(Date.now())).toBe(1);
    expect(reconcile(input)).toEqual({ kind: 'blocked', reason: 'missing_job' });
    expect(job()).toBeNull();
  }
);

test.each(['consumed', 'failed'] as const)(
  'SDK %s settlement prevents enqueue even without a job',
  (status) => {
    db.prepare(`INSERT INTO sdk_messages(id, session_id, message_type, sdk_message, timestamp, sdk_uuid, send_status, consumed_seq)
    VALUES ('message', ?, 'user', ?, ?, ?, ?, ?)`).run(
      input.sessionId,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Frozen task prompt' } }),
      new Date().toISOString(),
      entry.messageUuid!,
      status,
      status === 'consumed' ? 1 : null
    );
    expect(reconcile(input)).toEqual({ kind: 'settled', status });
    expect(job()).toBeNull();
    expect(receiptCount()).toBe(1);
    db.prepare('DELETE FROM sdk_messages WHERE id = ?').run('message');
    expect(reconcile(input)).toEqual({ kind: 'blocked', reason: 'missing_job' });
  }
);

test('expired intent keeps its original identity and never enqueues', () => {
  const expired = { ...entry, id: createUlid(Date.now() - entry.policy.ttlMs - 10) };
  db.prepare('UPDATE direct_task_kickoff_intents SET entry = ? WHERE attempt_id = ?').run(
    JSON.stringify(expired),
    input.attemptId
  );
  expect(reconcile(input)).toEqual({ kind: 'blocked', reason: 'expired' });
  expect(jobFor(expired.id)).toBeNull();
  expect(job()).toBeNull();
  expect(receiptCount()).toBe(0);
});

test.each(['stale', 'stop', 'paused', 'deleted', 'reserved'] as const)(
  '%s ownership creates neither job nor receipt',
  (state) => {
    if (state === 'stop') attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
    if (state === 'paused') new SpaceRepository(db).pauseSpace(spaceId);
    if (state === 'deleted') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
    if (state === 'reserved')
      db.prepare("UPDATE direct_task_execution_attempts SET phase = 'reserved' WHERE id = ?").run(
        input.attemptId
      );
    expect(reconcile(state === 'stale' ? { ...input, generation: 2 } : input)).toBeNull();
    expect(job()).toBeNull();
    expect(receiptCount()).toBe(0);
  }
);

test('receipt insertion failure rolls back the mailbox enqueue', () => {
  db.exec(
    "CREATE TRIGGER reject_dispatch BEFORE INSERT ON direct_task_kickoff_dispatches BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END"
  );
  expect(() => reconcile(input)).toThrow('receipt unavailable');
  expect(job()).toBeNull();
  expect(receiptCount()).toBe(0);
  db.exec('DROP TRIGGER reject_dispatch');
  expect(reconcile(input)).toMatchObject({ kind: 'enqueued' });
});

test('conflicting stored entry payload is not treated as the frozen kickoff', () => {
  enqueueMailboxEntry(jobs, {
    ...entry,
    message: { ...entry.message, message: { content: 'Changed prompt' } },
  });
  expect(reconcile(input)).toEqual({ kind: 'blocked', reason: 'conflict' });
  expect(job()?.payload.message).not.toEqual(entry.message);
});

test('missing frozen intent returns its explicit blocked outcome without writes', () => {
  db.prepare('DELETE FROM direct_task_kickoff_intents WHERE attempt_id = ?').run(input.attemptId);
  expect(reconcile(input)).toEqual({ kind: 'blocked', reason: 'invalid_intent' });
  expect(job()).toBeNull();
  expect(receiptCount()).toBe(0);
});
