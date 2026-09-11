import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  createDirectTaskWorkerResolver,
  requireDirectTaskWorkerIdentity,
} from '../../../../src/lib/space/runtime/direct-task-worker-identity';
import { resolveSpaceMcpSessionPolicy } from '../../../../src/lib/space/runtime/space-mcp-session-policy';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;
let taskId: string;
let resolve: ReturnType<typeof createDirectTaskWorkerResolver>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt-1', 'worker-1');
  persist('worker-1');
  resolve = createDirectTaskWorkerResolver({
    getSession: (id) => sessions.getSession(id),
    getTask: (id) => tasks.getTask(id),
    getActiveAttempt: (id) => attempts.getActive(id),
  });
});
afterEach(() => db.close());

function persist(id: string, type: Session['type'] = 'worker') {
  sessions.createSession(
    { ...createTestSession(id), type, workspacePath: '/repo', context: { spaceId, taskId } },
    { enforceWorkspaceOwnership: false }
  );
}

test('reserved and running workers resolve from persisted evidence with distinct ownership', () => {
  expect(resolve('worker-1')).toEqual({
    role: 'direct_task_worker',
    owner: 'direct-task-executor',
    isWorkflowWorker: false,
    sessionId: 'worker-1',
    spaceId,
    taskId,
    attemptId: 'attempt-1',
    generation: 1,
    phase: 'reserved',
  });
  attempts.activate('attempt-1', 'worker-1');
  tasks.updateTask(taskId, { taskAgentSessionId: 'worker-1' });
  expect(resolve('worker-1')).toMatchObject({ phase: 'running', owner: 'direct-task-executor' });
});

test('stopped and replaced attempts cannot retain execution identity', () => {
  attempts.stop('attempt-1', 'worker-1', 'cancelled');
  expect(resolve('worker-1')).toBeNull();
  attempts.claim(taskId, 'attempt-2', 'worker-2');
  persist('worker-2');
  expect(resolve('worker-1')).toBeNull();
  expect(resolve('worker-2')).toMatchObject({ attemptId: 'attempt-2', generation: 2 });
});

test.each(['space_chat', 'space_task_agent', 'lobby'] as const)(
  'session type %s cannot inherit direct-worker identity',
  (type) => {
    sessions.updateSession('worker-1', { type });
    expect(resolve('worker-1')).toBeNull();
  }
);

test.each(['archived', 'ended'] as const)(
  'inactive session %s is not an execution owner',
  (status) => {
    sessions.updateSession('worker-1', { status });
    expect(resolve('worker-1')).toBeNull();
  }
);

test('ordinary Space membership remains separate from stopped execution ownership', () => {
  const before = resolveSpaceMcpSessionPolicy(sessions.getSession('worker-1')!);
  expect(before).toMatchObject({
    role: 'ad_hoc_member',
    isWorkflowWorker: false,
    attachCoordinatorTools: false,
  });
  attempts.stop('attempt-1', 'worker-1', 'stopped');
  expect(resolve('worker-1')).toBeNull();
  expect(resolveSpaceMcpSessionPolicy(sessions.getSession('worker-1')!)).toEqual(before);
});

test('missing rows, wrong caller ID and mismatched persisted context fail closed', () => {
  expect(resolve('missing')).toBeNull();
  for (const context of [
    { spaceId },
    { spaceId, taskId: 'missing' },
    { spaceId: 'other', taskId },
    { taskId },
  ]) {
    sessions.updateSession('worker-1', { context });
    expect(resolve('worker-1')).toBeNull();
  }
  sessions.updateSession('worker-1', { context: { spaceId, taskId } });
  expect(
    requireDirectTaskWorkerIdentity('forged-id', {
      session: sessions.getSession('worker-1'),
      task: tasks.getTask(taskId),
      attempt: attempts.getActive(taskId),
    })
  ).toEqual({ reason: null });
});

test('workflow ownership and another task session pointer reject direct identity', () => {
  tasks.updateTask(taskId, { taskAgentSessionId: 'other' });
  expect(resolve('worker-1')).toBeNull();
  tasks.updateTask(taskId, { taskAgentSessionId: null });
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE space_tasks SET workflow_run_id = ? WHERE id = ?').run('run', taskId);
  expect(resolve('worker-1')).toBeNull();
});

test('pure gate rejects stopped or mismatched attempts even from an inconsistent lookup', () => {
  const session = sessions.getSession('worker-1');
  const task = tasks.getTask(taskId);
  const original = attempts.getActive(taskId)!;
  for (const attempt of [
    { ...original, taskId: 'other' },
    { ...original, sessionId: 'other' },
    { ...original, phase: 'stopped' as const },
  ]) {
    expect(requireDirectTaskWorkerIdentity('worker-1', { session, task, attempt })).toEqual({
      reason: null,
    });
  }
  expect(
    requireDirectTaskWorkerIdentity('worker-1', { session, task: null, attempt: original })
  ).toEqual({ reason: null });
});
