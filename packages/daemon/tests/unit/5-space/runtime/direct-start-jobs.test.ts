import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  JobQueueRepository,
  type Job,
} from '../../../../src/storage/repositories/job-queue-repository';
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import {
  createDirectStartRequester,
  createDirectStartJobHandler,
} from '../../../../src/lib/space/runtime/direct-start-jobs';
import {
  readDirectStartRequest,
  DIRECT_TASK_START,
} from '../../../../src/lib/space/runtime/direct-start-request';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import { createDirectTaskFinalizer } from '../../../../src/lib/space/runtime/finalize-direct-attempt';
import { readDirectKickoffIntent } from '../../../../src/lib/space/runtime/direct-kickoff-intent';

let db: Database;
let jobs: JobQueueRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
let load: ReturnType<typeof mock>;
let start: ReturnType<typeof createDirectTaskStarter>;
let request: ReturnType<typeof createDirectStartRequester>;
const inputKey = 'one';
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  jobs = new JobQueueRepository(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  taskId = tasks.createTask({ spaceId, title: 'Task', description: 'Do work', status: 'draft' }).id;
  load = mock(
    async (id: string) =>
      ({
        getSessionData: () => sessions.getSession(id)!,
        isQueryActiveOrStarting: () => false,
      }) as AgentSession
  );
  start = createDirectTaskStarter({
    db,
    defaultModel: 'claude-sonnet-4-6',
    sessionDb: {
      getSession: (id) => sessions.getSession(id),
      createSession: (session) =>
        sessions.createSession(session, { enforceWorkspaceOwnership: false }),
    },
    sessionManager: {
      getCachedSession: () => undefined,
      getSessionForControl: load,
      unregisterSession: async () => {},
    },
  });
  request = createDirectStartRequester({ db, jobQueue: jobs });
});
afterEach(() => db.close());
function acceptedJob() {
  const ack = request({ taskId, requestKey: inputKey });
  if (!ack.accepted || !ack.jobId) throw new Error('expected receipt');
  return jobs.getJob(ack.jobId)!;
}
function count() {
  return (db.prepare('SELECT COUNT(*) AS n FROM direct_task_start_requests').get() as { n: number })
    .n;
}

test('ack atomically publishes, reserves and freezes job before loading any session', async () => {
  const job = acceptedJob();
  const reserved = attempts.getActive(taskId)!;
  expect(reserved.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(load).not.toHaveBeenCalled();
  expect(readDirectStartRequest(db, reserved.id)).toEqual({
    input: { taskId, requestKey: inputKey },
    jobId: job.id,
  });
  expect(request({ taskId, requestKey: inputKey })).toEqual({ accepted: true, jobId: job.id });
  expect(count()).toBe(1);
  expect(await createDirectStartJobHandler(db, start, jobs)(job)).toMatchObject({ started: true });
  expect(request({ taskId, requestKey: inputKey })).toEqual({ accepted: true, jobId: job.id });
  expect(await createDirectStartJobHandler(db, start, jobs)(job)).toMatchObject({ started: true });
  expect(load).toHaveBeenCalledTimes(1);
});
test('fresh handler resumes frozen request after failed session loading', async () => {
  const job = acceptedJob();
  load.mockResolvedValueOnce(null);
  await expect(createDirectStartJobHandler(db, start, jobs)(job)).rejects.toThrow(
    'Direct start remains unavailable'
  );
  expect(attempts.getActive(taskId)?.phase).toBe('reserved');
  expect(await createDirectStartJobHandler(db, start, jobs)(jobs.getJob(job.id)!)).toMatchObject({
    started: true,
  });
  expect(count()).toBe(1);
});
test('request queue failure rolls back draft publication and claim', () => {
  db.exec(
    "CREATE TRIGGER reject_start BEFORE INSERT ON job_queue WHEN NEW.queue='direct_task_start' BEGIN SELECT RAISE(ABORT,'queue failed'); END"
  );
  expect(() => acceptedJob()).toThrow('queue failed');
  expect(tasks.getTask(taskId)?.status).toBe('draft');
  expect(attempts.getActive(taskId)).toBeNull();
  expect(count()).toBe(0);
});
test('receipt failure rolls back the queued job and claim', () => {
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON direct_task_start_requests BEGIN SELECT RAISE(ABORT,'receipt failed'); END"
  );
  expect(() => acceptedJob()).toThrow('receipt failed');
  expect(attempts.getActive(taskId)).toBeNull();
  expect(jobs.getLatestByPayload(DIRECT_TASK_START, {})).toBeNull();
});
test('stale or unlinked jobs never invoke the starter', async () => {
  const job = acceptedJob();
  const run = mock(start);
  const handler = createDirectStartJobHandler(db, run, jobs);
  expect(await handler({ ...job, id: 'other' })).toMatchObject({ reason: 'superseded' });
  expect(await handler({ ...job, queue: 'wrong' })).toMatchObject({ reason: 'unlinked_job' });
  const old = attempts.getActive(taskId)!;
  attempts.stop(old.id, old.sessionId, 'cancelled');
  expect(await handler(job)).toMatchObject({ reason: 'superseded' });
  expect(run).not.toHaveBeenCalled();
});
test('pruned job receipt is not silently recreated by duplicate request', () => {
  const job = acceptedJob();
  db.prepare('DELETE FROM job_queue WHERE id=?').run(job.id);
  expect(request({ taskId, requestKey: inputKey })).toEqual({ accepted: true, jobId: job.id });
  expect(jobs.getJob(job.id)).toBeNull();
  expect(count()).toBe(1);
});
test('review rejection job retains admitted feedback after checkpoint is consumed', async () => {
  const initial = await start({ taskId, requestKey: 'initial' });
  if (!initial.started) throw new Error(initial.reason);
  let cached = {
    getSessionData: () => sessions.getSession(initial.attempt.sessionId)!,
    getProcessingState: () => ({ status: 'idle' }),
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
    handleInterrupt: async () => {},
    cleanup: async () => {},
  } as unknown as AgentSession | null;
  const owner = Object.assign(Object.create(SessionManager.prototype), {
    directStopVerificationJobs: new Map(),
  }) as SessionManager;
  const done = await createDirectTaskFinalizer({
    db,
    sessionManager: {
      coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
      getCachedSession: () => cached,
      isSessionLoading: () => false,
      unregisterSession: async () => {
        cached = null;
      },
    },
  })({
    attemptId: initial.attempt.id,
    sessionId: initial.attempt.sessionId,
    generation: initial.attempt.generation,
    status: 'review',
  });
  expect(done.finalized).toBe(true);
  const ack = request({
    taskId,
    requestKey: 'rejected',
    retryFrom: { attemptId: initial.attempt.id, generation: initial.attempt.generation },
    reviewRejection: {
      expectedPendingCompletionGeneration: tasks.getTask(taskId)!.pendingCompletionGeneration!,
      reason: '  Fix edge case  ',
    },
  });
  if (!ack.accepted || !ack.jobId) throw new Error('expected retry receipt');
  expect(tasks.getTask(taskId)?.pendingCheckpointType).toBeNull();
  tasks.updateTask(taskId, { approvalReason: 'Mutated note' });
  const result = await createDirectStartJobHandler(db, start, jobs)(jobs.getJob(ack.jobId)!);
  expect(result).toMatchObject({ started: true });
  const current = attempts.getActive(taskId)!;
  expect(readDirectKickoffIntent(db, current.id)?.message.message.content).toContain(
    '  Fix edge case  '
  );
});

async function waitForIdle(processor: JobQueueProcessor) {
  for (let i = 0; i < 100 && processor.snapshot().inFlightTotal > 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(processor.snapshot().inFlightTotal).toBe(0);
}
test('dependency readiness defers same claimed job beyond retry budget then starts once', async () => {
  const dependency = tasks.createTask({
    spaceId: tasks.getTask(taskId)!.spaceId,
    title: 'Dependency',
    description: '',
  });
  tasks.updateTask(taskId, { dependsOn: [dependency.id] });
  const job = acceptedJob();
  const processor = new JobQueueProcessor(jobs, { maxConcurrent: 1 });
  processor.register(DIRECT_TASK_START, createDirectStartJobHandler(db, start, jobs));
  try {
    for (let i = 0; i < job.maxRetries + 3; i++) {
      jobs.reschedulePending(job.id, Date.now() - 1);
      expect(await processor.tick()).toBe(1);
      await waitForIdle(processor);
      expect(jobs.getJob(job.id)).toMatchObject({ status: 'pending', retryCount: 0 });
      expect(count()).toBe(1);
    }
    tasks.updateTask(dependency.id, { status: 'done' });
    jobs.reschedulePending(job.id, Date.now() - 1);
    expect(await processor.tick()).toBe(1);
    await waitForIdle(processor);
    expect(jobs.getJob(job.id)).toMatchObject({ status: 'completed', retryCount: 0 });
    expect(attempts.getActive(taskId)?.phase).toBe('running');
  } finally {
    await processor.stop();
  }
});

test('stale claim cannot defer a replacement job claim', async () => {
  const job = acceptedJob();
  const [old] = jobs.dequeue(DIRECT_TASK_START, 1);
  expect(jobs.requeue(job.id, Date.now() - 1, old.claimToken)).not.toBeNull();
  const [replacement] = jobs.dequeue(DIRECT_TASK_START, 1);
  const unavailable = async () => ({ started: false as const, reason: 'not_ready' });
  expect(await createDirectStartJobHandler(db, unavailable, jobs)(old)).toMatchObject({
    reason: 'superseded_claim',
  });
  expect(jobs.getJob(job.id)).toEqual(replacement);
});
