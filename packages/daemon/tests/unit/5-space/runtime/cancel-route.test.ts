import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  resolveCancellationRoute,
  supersedeReservedAttempt,
} from '../../../../src/lib/space/operations/cancel-route';

let db: Database;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  tasks = new SpaceTaskRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
});
afterEach(() => db.close());

function createTask() {
  return tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
}

type AttemptState = 'none' | 'reserved' | 'running' | 'stopped';

function setupAttempt(taskId: string, state: AttemptState): DirectTaskAttempt | null {
  if (state === 'none') return null;
  attempts.select(taskId);
  const reserved = attempts.claim(taskId, `attempt-${taskId}`, 'worker-session');
  if (!reserved) throw new Error('claim failed');
  if (state === 'reserved') return reserved;
  const running = attempts.activate(reserved.id, reserved.sessionId);
  if (!running) throw new Error('activate failed');
  if (state === 'running') return running;
  const stopped = attempts.stop(running.id, running.sessionId, 'cancelled');
  if (!stopped) throw new Error('stop failed');
  return stopped;
}

test.each([
  ['workflow run set takes priority over an active attempt', 'reserved', 'wf-1', null, 'workflow'],
  ['no attempt resolves plain', 'none', null, null, 'plain'],
  [
    'reserved attempt with no session on the task resolves reserved',
    'reserved',
    null,
    null,
    'reserved',
  ],
  [
    'reserved attempt with a retained task session still resolves reserved',
    'reserved',
    null,
    'worker-session',
    'reserved',
  ],
  ['running attempt resolves direct', 'running', null, null, 'direct'],
  [
    'stopped attempt with a retained task session resolves plain',
    'stopped',
    null,
    'worker-session',
    'plain',
  ],
] as const)('%s', (_label, attemptState, workflowRunId, taskAgentSessionId, expectedKind) => {
  const taskId = createTask();
  const attempt = setupAttempt(taskId, attemptState);
  const route = resolveCancellationRoute(db, { id: taskId, workflowRunId, taskAgentSessionId });
  expect(route.kind).toBe(expectedKind);
  if (route.kind === 'reserved' || route.kind === 'direct')
    expect(route.attempt.id).toBe(attempt!.id);
});

test('a reserved attempt is retired, and a second call returns false and leaves the stopped attempt unchanged', () => {
  const attempt = setupAttempt(createTask(), 'reserved')!;
  expect(supersedeReservedAttempt(db, attempt)).toBe(true);
  const stopped = attempts.get(attempt.id);
  expect(stopped?.phase).toBe('stopped');
  expect(supersedeReservedAttempt(db, attempt)).toBe(false);
  expect(attempts.get(attempt.id)).toEqual(stopped);
  expect(attempts.activate(attempt.id, attempt.sessionId)).toBeNull();
  expect(attempts.getActive(attempt.taskId)).toBeNull();
});

test('an attempt already stopped by the normal flow, with its leftover stop request row, returns false untouched', () => {
  const attempt = setupAttempt(createTask(), 'reserved')!;
  attempts.requestStop(attempt.id, attempt.sessionId, 'done');
  const stoppedNormally = attempts.stop(attempt.id, attempt.sessionId, 'done');
  expect(stoppedNormally?.phase).toBe('stopped');
  expect(supersedeReservedAttempt(db, attempt)).toBe(false);
  expect(attempts.get(attempt.id)).toEqual(stoppedNormally);
});

test('a running attempt is not reserved and returns false, untouched', () => {
  const attempt = setupAttempt(createTask(), 'running')!;
  expect(supersedeReservedAttempt(db, attempt)).toBe(false);
  expect(attempts.get(attempt.id)?.phase).toBe('running');
});
