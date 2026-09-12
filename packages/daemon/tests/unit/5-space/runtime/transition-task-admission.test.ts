import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  admitCaller,
  loadTask,
  rejectActiveDirectAttempt,
  resolveOwner,
  type SpaceTransitionAdmissionDependencies,
} from '../../../../src/lib/space/operations/transition-task-admission';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { createTestSession } from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let spaces: SpaceRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;
let notifyStandalone: ReturnType<typeof mock>;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaces = new SpaceRepository(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  spaceId = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' }).id;
  notifyStandalone = mock(() => {});
});
afterEach(() => db.close());

function deps(
  overrides: Partial<SpaceTransitionAdmissionDependencies> = {}
): SpaceTransitionAdmissionDependencies {
  return {
    db,
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    notifyStandalone,
    ...overrides,
  };
}

const rpc = { source: 'rpc' as const };

function worker(id: string, memberSpaceId?: string) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      context: memberSpaceId ? { spaceId: memberSpaceId } : {},
    },
    { enforceWorkspaceOwnership: false }
  );
  return { source: 'mcp' as const, sessionId: id };
}

describe('resolveOwner', () => {
  test('a missing task gives null', () => {
    expect(resolveOwner({ taskId: 'missing', status: 'open' }, deps())).toEqual({ reason: null });
  });

  test('a standalone task transitions and reports the updated row', () => {
    const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});
    const result = resolveOwner({ taskId: task.id, status: 'in_progress' }, deps());
    expect(result).toMatchObject({
      reason: expect.objectContaining({ id: task.id, status: 'in_progress' }),
    });
    const row = db.prepare('SELECT status FROM space_tasks WHERE id = ?').get(task.id) as {
      status: string;
    };
    expect(row.status).toBe('in_progress');
    expect(notifyStandalone).toHaveBeenCalledTimes(1);
  });

  test('a standalone task requesting a Space-only status is unsupported', () => {
    const task = createStandaloneTask(db, { title: 'Solo' }, undefined, () => {});
    const result = resolveOwner({ taskId: task.id, status: 'review' }, deps());
    expect(result).toEqual({ reason: 'unsupported_status' });
    expect(notifyStandalone).not.toHaveBeenCalled();
  });

  test('a Space task passes its spaceId through', () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    expect(resolveOwner({ taskId: task.id, status: 'in_progress' }, deps())).toEqual({
      value: spaceId,
    });
  });
});

describe('admitCaller', () => {
  test('rpc callers are admitted', () => {
    expect(admitCaller(spaceId, rpc, deps())).toEqual({ value: spaceId });
  });

  test('an mcp worker session in the owning Space is admitted', () => {
    const caller = worker('member', spaceId);
    expect(admitCaller(spaceId, caller, deps())).toEqual({ value: spaceId });
  });

  test('an mcp session scoped to another Space is rejected', () => {
    const caller = worker('outsider', 'other-space');
    expect(admitCaller(spaceId, caller, deps())).toEqual({ reason: null });
  });
});

describe('loadTask', () => {
  test('a missing task gives null', async () => {
    const result = await loadTask(spaceId, { taskId: 'missing', status: 'open' }, deps());
    expect(result).toEqual({ reason: null });
  });

  test('a present task gives the owned task', async () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    const result = await loadTask(spaceId, { taskId: task.id, status: 'open' }, deps());
    expect(result).toMatchObject({ value: { spaceId, task: { id: task.id } } });
  });
});

describe('rejectActiveDirectAttempt', () => {
  test.each(['reserved', 'running'] as const)(
    'a task with a %s direct attempt is rejected',
    (phase) => {
      const task = tasks.createTask({ spaceId, title: 'T', description: '' });
      attempts.select(task.id);
      attempts.claim(task.id, 'attempt', 'worker');
      if (phase === 'running') attempts.activate('attempt', 'worker');
      expect(rejectActiveDirectAttempt({ spaceId, task }, deps())).toEqual({
        reason: 'unsupported_status',
      });
    }
  );

  test('a task without an active attempt passes through unchanged', () => {
    const task = tasks.createTask({ spaceId, title: 'T', description: '' });
    expect(rejectActiveDirectAttempt({ spaceId, task }, deps())).toEqual({
      value: { spaceId, task },
    });
  });
});
