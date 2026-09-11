import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import {
  readDirectKickoffIntent,
  recordDirectKickoffAtomically,
} from '../../../../src/lib/space/runtime/direct-kickoff-intent';
import { createDirectTaskFinalizer } from '../../../../src/lib/space/runtime/finalize-direct-attempt';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

let db: Database;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let sessions: SessionRepository;
let taskId: string;
let spaceId: string;
let getSessionForControl: ReturnType<typeof mock>;
let start: ReturnType<typeof createDirectTaskStarter>;
let onTaskReopened: ReturnType<typeof mock>;
let unregisterSession: ReturnType<typeof mock>;
const requestKey = 'request-one';
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
  attempts = new DirectTaskExecutionRepository(db);
  sessions = new SessionRepository(db);
  taskId = tasks.createTask({
    spaceId,
    title: 'Task',
    description: 'Do useful work',
    status: 'draft',
  }).id;
  getSessionForControl = mock(
    async (id: string) =>
      ({
        getSessionData: () => sessions.getSession(id)!,
        isQueryActiveOrStarting: () => false,
      }) as AgentSession
  );
  unregisterSession = mock(async () => {});
  onTaskReopened = mock(() => {});
  start = createDirectTaskStarter({
    onTaskReopened,
    db,
    defaultModel: 'claude-sonnet-4-6',
    sessionDb: {
      getSession: (id) => sessions.getSession(id),
      createSession: (session) =>
        sessions.createSession(session, { enforceWorkspaceOwnership: false }),
    },
    sessionManager: {
      getCachedSession: () => undefined,
      getSessionForControl,
      unregisterSession,
    },
  });
});
afterEach(() => db.close());
function mailCount() {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue = 'mailbox'").get() as { n: number }
  ).n;
}

test.each(['draft', 'open'] as const)(
  'starts %s tasks with one frozen durable kickoff and no workflow',
  async (status) => {
    if (status === 'open') tasks.updateTask(taskId, { status });
    const result = await start({ taskId, requestKey });
    expect(result.started).toBe(true);
    if (!result.started) throw new Error(result.reason);
    expect(tasks.getTask(taskId)).toMatchObject({
      status: 'in_progress',
      taskAgentSessionId: result.attempt.sessionId,
    });
    expect(tasks.getTask(taskId)?.workflowRunId).toBeUndefined();
    expect(result.attempt.phase).toBe('running');
    const kickoff = readDirectKickoffIntent(db, result.attempt.id)!;
    expect(
      new JobQueueRepository(db).getLatestByPayload('mailbox', { id: kickoff.id })?.payload
    ).toEqual(kickoff);
    expect(kickoff.message.message.content).toContain('Do useful work');
    expect(mailCount()).toBe(1);
    expect(await start({ taskId, requestKey })).toEqual(result);
    expect(mailCount()).toBe(1);
    expect(getSessionForControl).toHaveBeenCalledTimes(1);
  }
);
test('a failed load retains the same request identity for retry', async () => {
  getSessionForControl.mockResolvedValueOnce(null);
  expect((await start({ taskId, requestKey })).started).toBe(false);
  const reserved = attempts.getActive(taskId)!;
  expect(reserved.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(await start({ taskId, requestKey: 'other' })).toMatchObject({ started: false });
  const result = await start({ taskId, requestKey });
  expect(result).toMatchObject({
    started: true,
    attempt: { id: reserved.id, sessionId: reserved.sessionId, generation: reserved.generation },
  });
});
test('new kickoff, activation and dispatch roll back together for retry', async () => {
  db.exec(
    "CREATE TRIGGER reject_direct_mail BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' BEGIN SELECT RAISE(ABORT, 'reject dispatch'); END"
  );
  await expect(start({ taskId, requestKey })).rejects.toThrow('reject dispatch');
  const reserved = attempts.getActive(taskId)!;
  expect(readDirectKickoffIntent(db, reserved.id)).toBeNull();
  expect(reserved.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(tasks.getTask(taskId)?.taskAgentSessionId).toBeUndefined();
  expect(mailCount()).toBe(0);
  tasks.updateTask(taskId, { description: 'Changed later' });
  db.exec('DROP TRIGGER reject_direct_mail');
  expect((await start({ taskId, requestKey })).started).toBe(true);
  expect(readDirectKickoffIntent(db, reserved.id)?.message.message.content).toContain(
    'Changed later'
  );
  expect(mailCount()).toBe(1);
});
test('competing request keys cannot both claim or publish the draft', async () => {
  const results = await Promise.all([
    start({ taskId, requestKey }),
    start({ taskId, requestKey: 'other' }),
  ]);
  expect(results.filter((result) => result.started)).toHaveLength(1);
  expect(mailCount()).toBe(1);
});
test('stopped request cannot resurrect its attempt or publish a draft again', async () => {
  const result = await start({ taskId, requestKey });
  if (!result.started) throw new Error(result.reason);
  attempts.stop(result.attempt.id, result.attempt.sessionId, 'cancelled');
  tasks.updateTask(taskId, { status: 'open', taskAgentSessionId: null });
  expect((await start({ taskId, requestKey })).started).toBe(false);
  expect(attempts.getActive(taskId)).toBeNull();
  expect(mailCount()).toBe(1);
});
test('paused Space rejects selection and draft publication without creating a session', async () => {
  new SpaceRepository(db).pauseSpace(spaceId);
  expect((await start({ taskId, requestKey })).started).toBe(false);
  expect(tasks.getTask(taskId)?.status).toBe('draft');
  expect(attempts.isSelected(taskId)).toBe(false);
  expect(getSessionForControl).not.toHaveBeenCalled();
});
test('claim failure rolls draft publication and selection back', async () => {
  db.exec(
    "CREATE TRIGGER reject_direct_claim BEFORE INSERT ON direct_task_execution_attempts BEGIN SELECT RAISE(ABORT, 'reject claim'); END"
  );
  await expect(start({ taskId, requestKey })).rejects.toThrow('reject claim');
  expect(tasks.getTask(taskId)?.status).toBe('draft');
  expect(attempts.isSelected(taskId)).toBe(false);
  expect(getSessionForControl).not.toHaveBeenCalled();
});

test.each(['ended', 'workspace', 'receipt'] as const)(
  'idempotent retry rejects invalidated %s execution evidence',
  async (change) => {
    const result = await start({ taskId, requestKey });
    if (!result.started) throw new Error(result.reason);
    if (change === 'ended') sessions.updateSession(result.attempt.sessionId, { status: 'ended' });
    if (change === 'workspace')
      sessions.updateSession(result.attempt.sessionId, { workspacePath: '/other' });
    if (change === 'receipt') db.exec('DELETE FROM direct_task_kickoff_dispatches');
    expect((await start({ taskId, requestKey })).started).toBe(false);
    expect(mailCount()).toBe(1);
  }
);

test('concurrent retries of one request converge on the same running attempt', async () => {
  const [first, second] = await Promise.all([
    start({ taskId, requestKey }),
    start({ taskId, requestKey }),
  ]);
  expect(first.started).toBe(true);
  expect(second).toEqual(first);
  expect(mailCount()).toBe(1);
});

test('delayed same-request preparation never cleans up the activated shared session', async () => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanup = mock(async () => {});
  let shared: AgentSession | undefined;
  let loads = 0;
  getSessionForControl.mockImplementation(async (id: string) => {
    shared ??= {
      getSessionData: () => sessions.getSession(id)!,
      isQueryActiveOrStarting: () => false,
      cleanup,
    } as unknown as AgentSession;
    if (++loads === 2) await delayed;
    return shared;
  });
  const first = start({ taskId, requestKey });
  const second = start({ taskId, requestKey });
  const result = await first;
  expect(result.started).toBe(true);
  release();
  expect(await second).toEqual(result);
  expect(unregisterSession).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
  expect(mailCount()).toBe(1);
});

test.each(['dependency', 'paused'] as const)(
  'ineligible %s start does not freeze an expiring kickoff',
  async (cause) => {
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
      if (cause === 'dependency') tasks.updateTask(taskId, { dependsOn: [dependency.id] });
      else
        getSessionForControl.mockImplementationOnce(async (id: string) => {
          new SpaceRepository(db).pauseSpace(spaceId);
          return {
            getSessionData: () => sessions.getSession(id)!,
            isQueryActiveOrStarting: () => false,
            cleanup: async () => {},
          } as AgentSession;
        });
      expect((await start({ taskId, requestKey })).started).toBe(false);
      const reserved = attempts.getActive(taskId)!;
      expect(readDirectKickoffIntent(db, reserved.id)).toBeNull();
      expect(mailCount()).toBe(0);
      clock.mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
      tasks.updateTask(dependency.id, { status: 'done' });
      db.prepare('UPDATE spaces SET paused = 0 WHERE id = ?').run(spaceId);
      expect((await start({ taskId, requestKey })).started).toBe(true);
      expect(mailCount()).toBe(1);
    } finally {
      clock.mockRestore();
    }
  }
);
test('rejected activation retains a preexisting frozen intent without renewing it', async () => {
  getSessionForControl.mockResolvedValueOnce(null);
  await start({ taskId, requestKey });
  const attempt = attempts.getActive(taskId)!;
  const recorded = recordDirectKickoffAtomically(db, {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    message: {
      type: 'user',
      message: { content: 'Existing frozen prompt' },
      parent_tool_use_id: null,
    },
  });
  if (!recorded.recorded) throw new Error(recorded.reason);
  const dependency = tasks.createTask({ spaceId, title: 'Dependency', description: '' });
  tasks.updateTask(taskId, { dependsOn: [dependency.id] });
  expect((await start({ taskId, requestKey })).started).toBe(false);
  expect(readDirectKickoffIntent(db, attempt.id)).toEqual(recorded.entry);
  tasks.updateTask(dependency.id, { status: 'done' });
  expect((await start({ taskId, requestKey })).started).toBe(true);
  expect(readDirectKickoffIntent(db, attempt.id)).toEqual(recorded.entry);
});

async function finalizedAttempt(status: 'blocked' | 'cancelled' | 'stopped' | 'review') {
  const started = await start({ taskId, requestKey });
  if (!started.started) throw new Error(started.reason);
  let cached = {
    getSessionData: () => sessions.getSession(started.attempt.sessionId)!,
    getProcessingState: () => ({ status: 'idle' }),
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
    handleInterrupt: async () => {},
    cleanup: async () => {},
  } as unknown as AgentSession | null;
  const owner = Object.assign(Object.create(SessionManager.prototype), {
    directStopVerificationJobs: new Map(),
  }) as SessionManager;
  const result = await createDirectTaskFinalizer({
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
    attemptId: started.attempt.id,
    sessionId: started.attempt.sessionId,
    generation: started.attempt.generation,
    status,
    options: { blockReason: 'test' },
  });
  expect(result.finalized).toBe(true);
  return { attemptId: started.attempt.id, generation: started.attempt.generation };
}
test.each(['blocked', 'cancelled', 'stopped'] as const)(
  'retries verified %s with a fresh owner and idempotent request',
  async (status) => {
    const retryFrom = await finalizedAttempt(status);
    const request = { taskId, requestKey: 'retry-one', retryFrom };
    const result = await start(request);
    expect(result).toMatchObject({
      started: true,
      attempt: { generation: retryFrom.generation + 1 },
    });
    if (!result.started) throw new Error(result.reason);
    expect(result.attempt.id).not.toBe(retryFrom.attemptId);
    expect(tasks.getTask(taskId)).toMatchObject({
      status: 'in_progress',
      taskAgentSessionId: result.attempt.sessionId,
    });
    expect(tasks.getTask(taskId)?.blockReason).toBeNull();
    expect(await start(request)).toEqual(result);
    expect((await start({ ...request, requestKey: 'competing' })).started).toBe(false);
    expect(mailCount()).toBe(2);
    expect(onTaskReopened).toHaveBeenCalledTimes(status === 'stopped' ? 0 : 1);
  }
);
test.each(['generation', 'pointer', 'lifecycle', 'marker'] as const)(
  'rejects stale retry %s without reopening',
  async (change) => {
    const retryFrom = await finalizedAttempt('blocked');
    if (change === 'generation') retryFrom.generation++;
    if (change === 'pointer') tasks.updateTask(taskId, { taskAgentSessionId: null });
    if (change === 'lifecycle') {
      tasks.updateTask(taskId, { status: 'open' });
      tasks.updateTask(taskId, { status: 'blocked' });
    }
    if (change === 'marker')
      db.prepare("UPDATE direct_task_stop_requests SET finalization_state = 'superseded'").run();
    expect((await start({ taskId, requestKey: 'retry-one', retryFrom })).started).toBe(false);
    expect(tasks.getTask(taskId)?.status).toBe('blocked');
    expect(attempts.getActive(taskId)).toBeNull();
    expect(mailCount()).toBe(1);
  }
);
test('retry claim failure rolls back reopening and previous pointer cleanup', async () => {
  const retryFrom = await finalizedAttempt('cancelled');
  const previous = tasks.getTask(taskId);
  db.exec(
    "CREATE TRIGGER reject_retry BEFORE INSERT ON direct_task_execution_attempts BEGIN SELECT RAISE(ABORT, 'reject retry'); END"
  );
  await expect(start({ taskId, requestKey: 'retry-one', retryFrom })).rejects.toThrow(
    'reject retry'
  );
  expect(tasks.getTask(taskId)).toEqual(previous);
  expect(attempts.getActive(taskId)).toBeNull();
});
test('stopped earlier request cannot reopen a later finalized attempt', async () => {
  const retryFrom = await finalizedAttempt('blocked');
  expect((await start({ taskId, requestKey, retryFrom })).started).toBe(false);
  expect(tasks.getTask(taskId)?.status).toBe('blocked');
  expect(attempts.getActive(taskId)).toBeNull();
});

test('retry resumes its reserved owner after failed loading without another reopen', async () => {
  const retryFrom = await finalizedAttempt('stopped');
  const request = { taskId, requestKey: 'retry-one', retryFrom };
  getSessionForControl.mockResolvedValueOnce(null);
  expect((await start(request)).started).toBe(false);
  const reserved = attempts.getActive(taskId)!;
  expect(reserved.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(await start(request)).toMatchObject({
    started: true,
    attempt: { id: reserved.id, generation: reserved.generation },
  });
  expect(mailCount()).toBe(2);
});

test('reopen bookkeeping failure rolls back the new owner and task changes', async () => {
  const retryFrom = await finalizedAttempt('blocked');
  const previous = tasks.getTask(taskId);
  onTaskReopened.mockImplementation(() => {
    throw new Error('bookkeeping failed');
  });
  await expect(start({ taskId, requestKey: 'retry-one', retryFrom })).rejects.toThrow(
    'bookkeeping failed'
  );
  expect(tasks.getTask(taskId)).toEqual(previous);
  expect(attempts.getActive(taskId)).toBeNull();
  expect(mailCount()).toBe(1);
});

async function reviewRetryRequest(reason: string | null = '  Please revise  ') {
  const retryFrom = await finalizedAttempt('review');
  return {
    taskId,
    requestKey: 'review-retry',
    retryFrom,
    reviewRejection: {
      expectedPendingCompletionGeneration: tasks.getTask(taskId)!.pendingCompletionGeneration!,
      reason,
    },
  };
}
test('review rejection consumes exact checkpoint, preserves raw reason and starts one new attempt', async () => {
  const request = await reviewRetryRequest();
  tasks.updateTask(taskId, {
    result: 'Rejected result',
    reportedSummary: 'Rejected summary',
    approvalSource: 'human',
    approvedAt: 123,
    postApprovalSourceNodeId: 'old-node',
  });
  const result = await start(request);
  expect(result.started).toBe(true);
  expect(tasks.getTask(taskId)).toMatchObject({
    status: 'in_progress',
    pendingCheckpointType: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
    approvalReason: '  Please revise  ',
    result: null,
    reportedSummary: null,
    approvalSource: null,
    approvedAt: null,
    postApprovalSourceNodeId: null,
  });
  expect(await start(request)).toEqual(result);
  expect(
    (
      await start({
        ...request,
        reviewRejection: { ...request.reviewRejection, reason: 'Changed' },
      })
    ).started
  ).toBe(false);
  expect(mailCount()).toBe(2);
  expect(onTaskReopened).not.toHaveBeenCalled();
});
test('approval winning before rejection preserves approved review and stopped owner', async () => {
  const request = await reviewRetryRequest();
  const approved = tasks.updateTask(
    taskId,
    { status: 'approved' },
    'review',
    request.reviewRejection.expectedPendingCompletionGeneration
  );
  expect(approved).not.toBeNull();
  expect((await start(request)).started).toBe(false);
  expect(tasks.getTask(taskId)?.status).toBe('approved');
  expect(attempts.getActive(taskId)).toBeNull();
  expect(mailCount()).toBe(1);
});
test('rejection reserves before load and makes competing approval lose its CAS', async () => {
  const request = await reviewRetryRequest();
  getSessionForControl.mockImplementationOnce(async (id) => {
    expect(
      tasks.updateTask(
        taskId,
        { status: 'approved' },
        'review',
        request.reviewRejection.expectedPendingCompletionGeneration
      )
    ).toBeNull();
    return {
      getSessionData: () => sessions.getSession(id)!,
      isQueryActiveOrStarting: () => false,
    } as AgentSession;
  });
  expect((await start(request)).started).toBe(true);
  expect(mailCount()).toBe(2);
});
test('stale review generation cannot consume a resubmitted checkpoint', async () => {
  const request = await reviewRetryRequest();
  tasks.updateTask(taskId, {
    pendingCheckpointType: 'task_completion',
    pendingCompletionReason: 'New submission',
    status: 'review',
  });
  expect((await start(request)).started).toBe(false);
  expect(tasks.getTask(taskId)).toMatchObject({
    status: 'review',
    pendingCompletionReason: 'New submission',
  });
  expect(attempts.getActive(taskId)).toBeNull();
});
test('failed review retry claim restores checkpoint and raw reason', async () => {
  const request = await reviewRetryRequest();
  const before = tasks.getTask(taskId);
  db.exec(
    "CREATE TRIGGER reject_review_retry BEFORE INSERT ON direct_task_execution_attempts BEGIN SELECT RAISE(ABORT, 'reject review retry'); END"
  );
  await expect(start(request)).rejects.toThrow('reject review retry');
  expect(tasks.getTask(taskId)).toEqual(before);
  expect(attempts.getActive(taskId)).toBeNull();
});
test('review rejection retry after a failed load resumes reserved ownership and does not consume another generation', async () => {
  const request = await reviewRetryRequest(null);
  getSessionForControl.mockResolvedValueOnce(null);
  expect((await start(request)).started).toBe(false);
  const reserved = attempts.getActive(taskId)!;
  const generation = tasks.getTask(taskId)?.pendingCompletionGeneration;
  expect(tasks.getTask(taskId)).toMatchObject({
    status: 'open',
    approvalReason: null,
    pendingCheckpointType: null,
  });
  expect(await start(request)).toMatchObject({ started: true, attempt: { id: reserved.id } });
  expect(tasks.getTask(taskId)?.pendingCompletionGeneration).toBe(generation);
});
