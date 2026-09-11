import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import { readDirectKickoffIntent } from '../../../../src/lib/space/runtime/direct-kickoff-intent';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

let db: Database;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let sessions: SessionRepository;
let taskId: string;
let spaceId: string;
let getSessionForControl: ReturnType<typeof mock>;
let start: ReturnType<typeof createDirectTaskStarter>;
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
test('activation and dispatch roll back together, preserving the frozen prompt for retry', async () => {
  db.exec(
    "CREATE TRIGGER reject_direct_mail BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' BEGIN SELECT RAISE(ABORT, 'reject dispatch'); END"
  );
  await expect(start({ taskId, requestKey })).rejects.toThrow('reject dispatch');
  const reserved = attempts.getActive(taskId)!;
  const frozen = readDirectKickoffIntent(db, reserved.id)!;
  expect(reserved.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(tasks.getTask(taskId)?.taskAgentSessionId).toBeUndefined();
  expect(mailCount()).toBe(0);
  tasks.updateTask(taskId, { description: 'Changed later' });
  db.exec('DROP TRIGGER reject_direct_mail');
  expect((await start({ taskId, requestKey })).started).toBe(true);
  expect(readDirectKickoffIntent(db, reserved.id)).toEqual(frozen);
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
