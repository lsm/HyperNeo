import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import {
  createDatabaseDirectTaskQueryAdmission,
  createDirectTaskQueryAdmission,
  requireRunningDirectTaskQuery,
} from '../../../../src/lib/space/runtime/direct-task-query-admission';
import {
  loadDirectTaskWorkerEvidence,
  requireDirectTaskWorkerIdentity,
} from '../../../../src/lib/space/runtime/direct-task-worker-identity';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let spaces: SpaceRepository;
let spaceId: string;
let taskId: string;
let admit: ReturnType<typeof createDatabaseDirectTaskQueryAdmission>;
const input = { sessionId: 'worker', attemptId: 'attempt', generation: 1 };

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  sessions.createSession(
    { ...createTestSession(input.sessionId), type: 'worker', context: { spaceId, taskId } },
    { enforceWorkspaceOwnership: false }
  );
  attempts.select(taskId);
  attempts.claim(taskId, input.attemptId, input.sessionId);
  admit = createDatabaseDirectTaskQueryAdmission(db);
});
afterEach(() => db.close());

function makeRunning() {
  attempts.activate(input.attemptId, input.sessionId);
  tasks.updateTask(taskId, { status: 'in_progress', taskAgentSessionId: input.sessionId });
}

test('only a current running identity with an active owner is admitted without mutating it', () => {
  expect(admit(input)).toBeNull();
  makeRunning();
  const task = tasks.getTask(taskId);
  const attempt = attempts.get(input.attemptId);
  expect(admit(input)).toMatchObject({
    ...input,
    taskId,
    spaceId,
    phase: 'running',
    isWorkflowWorker: false,
  });
  expect(tasks.getTask(taskId)).toEqual(task);
  expect(attempts.get(input.attemptId)).toEqual(attempt);
  expect(admit({ ...input, attemptId: 'stale' })).toBeNull();
  expect(admit({ ...input, generation: 2 })).toBeNull();
  expect(admit({ ...input, sessionId: 'other' })).toBeNull();
});

test('a stop request created after an admission invalidates the next read without releasing ownership', () => {
  makeRunning();
  expect(admit(input)).not.toBeNull();
  attempts.requestStop(input.attemptId, input.sessionId, 'cancelled');
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(admit(input)).toBeNull();
});

test.each([
  'task_deleted',
  'space_deleted',
  'stopped',
  'archived',
  'ended',
  'wrong_space',
  'wrong_task',
  'coordinator',
] as const)('%s cannot use old expected identity or provenance for admission', (state) => {
  makeRunning();
  if (state === 'task_deleted') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
  if (state === 'space_deleted') db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
  if (state === 'stopped') attempts.stop(input.attemptId, input.sessionId, 'cancelled');
  if (state === 'archived' || state === 'ended')
    sessions.updateSession(input.sessionId, { status: state });
  if (state === 'wrong_space')
    sessions.updateSession(input.sessionId, { context: { spaceId: 'other', taskId } });
  if (state === 'wrong_task')
    sessions.updateSession(input.sessionId, { context: { spaceId, taskId: 'other' } });
  if (state === 'coordinator') sessions.updateSession(input.sessionId, { type: 'space_chat' });
  expect(attempts.hasSessionProvenance(input.sessionId)).toBe(true);
  expect(admit(input)).toBeNull();
});

test.each(['open', 'review', 'done', 'archived'] as const)(
  'task status %s rejects a running attempt',
  (status) => {
    makeRunning();
    tasks.updateTask(taskId, { status });
    expect(admit(input)).toBeNull();
  }
);

test.each(['no_pointer', 'wrong_pointer', 'archived_task', 'inactive_space', 'workflow'] as const)(
  '%s invalidates running admission',
  (state) => {
    makeRunning();
    if (state === 'no_pointer')
      db.prepare('UPDATE space_tasks SET task_agent_session_id = NULL WHERE id = ?').run(taskId);
    if (state === 'wrong_pointer') tasks.updateTask(taskId, { taskAgentSessionId: 'other' });
    if (state === 'archived_task')
      db.prepare('UPDATE space_tasks SET archived_at = 1 WHERE id = ?').run(taskId);
    if (state === 'inactive_space')
      db.prepare("UPDATE spaces SET status = 'archived' WHERE id = ?").run(spaceId);
    if (state === 'workflow') {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('UPDATE space_tasks SET workflow_run_id = ? WHERE id = ?').run('run', taskId);
    }
    expect(admit(input)).toBeNull();
  }
);

test('invalid identity stops the pipeline before Space and stop-request lookups', () => {
  const getSpace = mock(() => null);
  const isStopRequested = mock(() => false);
  const resolve = createDirectTaskQueryAdmission({
    getSession: () => null,
    getTask: () => null,
    getActiveAttempt: () => null,
    getSpace,
    isStopRequested,
  });
  expect(resolve(input)).toBeNull();
  expect(getSpace).not.toHaveBeenCalled();
  expect(isStopRequested).not.toHaveBeenCalled();
});

test('pure running gate rejects a mismatched Space and returns explicit null rejection', () => {
  makeRunning();
  const evidence = loadDirectTaskWorkerEvidence(
    input.sessionId,
    (id) => sessions.getSession(id),
    (id) => tasks.getTask(id),
    (id) => attempts.getActive(id)
  );
  const identity = requireDirectTaskWorkerIdentity(input.sessionId, evidence);
  if ('reason' in identity) throw new Error('Expected persisted identity');
  const state = { space: spaces.getSpace(spaceId), stopRequested: false };
  expect(requireRunningDirectTaskQuery(input, identity.value, evidence, state)).toEqual({
    value: identity.value,
  });
  expect(
    requireRunningDirectTaskQuery(input, identity.value, evidence, {
      ...state,
      space: { ...state.space!, id: 'other' },
    })
  ).toEqual({ reason: null });
});
