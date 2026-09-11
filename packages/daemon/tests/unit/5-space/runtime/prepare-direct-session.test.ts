import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Session, SpaceTask } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { runMigration248 } from '../../../../src/storage/schema/m248-direct-task-execution';
import { createSpaceTables } from '../../helpers/space-test-db';
import {
  createDormantDirectSessionPreparer,
  matchesDirectPreparedSession,
  requireReservedDirectTask,
} from '../../../../src/lib/space/runtime/prepare-direct-session';

let sql: Database;
let attempts: DirectTaskExecutionRepository;
let tasks: SpaceTaskRepository;
let spaces: SpaceRepository;
let task: SpaceTask;
let records: Map<string, Session>;
let cached: AgentSession | null;
let load: ReturnType<typeof mock>;
let cleanup: ReturnType<typeof mock>;
let persist: ReturnType<typeof mock>;
let unregister: ReturnType<typeof mock>;
function makeAgent(row: Session) {
  return {
    getSessionData: () => row,
    isQueryActiveOrStarting: () => false,
    cleanup,
  } as unknown as AgentSession;
}
function preparer() {
  return createDormantDirectSessionPreparer({
    attempts,
    tasks,
    getSpace: (id) => spaces.getSpace(id),
    defaultModel: 'test-model',
    db: { getSession: (id) => records.get(id) ?? null, createSession: persist },
    sessionManager: {
      getCachedSession: () => cached,
      getSessionForControl: load,
      unregisterSession: unregister,
    },
  });
}
beforeEach(() => {
  sql = new Database(':memory:');
  createSpaceTables(sql);
  runMigration248(sql);
  spaces = new SpaceRepository(sql);
  const space = spaces.createSpace({ name: 'Space', slug: 'space', workspacePath: '/repo' });
  tasks = new SpaceTaskRepository(sql);
  task = tasks.createTask({ spaceId: space.id, title: 'Task', description: '' });
  attempts = new DirectTaskExecutionRepository(sql);
  attempts.select(task.id);
  attempts.claim(task.id, 'attempt', 'direct-session');
  records = new Map();
  cached = null;
  cleanup = mock(async () => {});
  persist = mock((row: Session) => {
    records.set(row.id, row);
  });
  load = mock(async (id: string) => cached ?? (cached = makeAgent(records.get(id)!)));
  unregister = mock(async (_id: string, expected: AgentSession) => {
    if (cached === expected) cached = null;
  });
});
afterEach(() => sql.close());

test('factory is inert; a claim survives crash before create and retries reuse its row/object', async () => {
  const prepare = preparer();
  expect(persist).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  const first = await prepare('attempt');
  const second = await prepare('attempt');
  expect(first).toEqual(second);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(records.get('direct-session')).toMatchObject({
    type: 'worker',
    context: { taskId: task.id, spaceId: task.spaceId },
  });
  expect(attempts.get('attempt')?.phase).toBe('reserved');
  expect(cleanup).not.toHaveBeenCalled();
});

test('retry after persistence but before registration reuses the existing record', async () => {
  load.mockResolvedValueOnce(null);
  expect(await preparer()('attempt')).toBe('direct_session_unavailable');
  expect(records.size).toBe(1);
  expect(await preparer()('attempt')).toHaveProperty('session');
  expect(persist).toHaveBeenCalledTimes(1);
});

test('foreign persisted session is neither overwritten nor loaded', async () => {
  const row = AgentSession.createSessionFromInit(
    { sessionId: 'direct-session', type: 'worker', workspacePath: '/other' },
    'test-model'
  );
  records.set(row.id, row);
  expect(await preparer()('attempt')).toBe('direct_session_conflict');
  expect(records.get(row.id)).toBe(row);
  expect(load).not.toHaveBeenCalled();
});

test.each(['cancelled', 'archived', 'stopped', 'foreign'] as const)(
  'loss during control load: %s cleans only new dormant object',
  async (loss) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    load.mockImplementation(async (id: string) => {
      cached = makeAgent(records.get(id)!);
      entered();
      await pending;
      return cached;
    });
    const result = preparer()('attempt');
    await started;
    if (loss === 'stopped') attempts.stop('attempt', 'direct-session', 'cancelled');
    else if (loss === 'foreign')
      cached = makeAgent({ ...records.get('direct-session')!, context: { taskId: 'foreign' } });
    else tasks.updateTask(task.id, { status: loss });
    release();
    expect(await result).toBe('direct_attempt_unavailable');
    expect(cleanup).toHaveBeenCalledTimes(loss === 'foreign' ? 0 : 1);
    expect(unregister).toHaveBeenCalledTimes(loss === 'foreign' ? 0 : 1);
    expect(records.size).toBe(1);
  }
);

test('pure admission rejects missing, active and wrong-generation identities', () => {
  const attempt = attempts.get('attempt')!;
  const space = spaces.getSpace(task.spaceId)!;
  expect(requireReservedDirectTask(null, attempt, true, task, space)).toHaveProperty('reason');
  expect(
    requireReservedDirectTask(attempt, { ...attempt, generation: 9 }, true, task, space)
  ).toHaveProperty('reason');
  expect(
    requireReservedDirectTask({ ...attempt, phase: 'running' }, attempt, true, task, space)
  ).toHaveProperty('reason');
  const candidate = { attempt, task, workspacePath: '/repo' };
  const row = AgentSession.createSessionFromInit(
    {
      sessionId: attempt.sessionId,
      type: 'worker',
      workspacePath: '/repo',
      context: { taskId: task.id, spaceId: task.spaceId },
    },
    'test-model'
  );
  expect(matchesDirectPreparedSession(row, candidate)).toBe(true);
  expect(
    matchesDirectPreparedSession(
      { ...row, context: { taskId: 'foreign', spaceId: task.spaceId } },
      candidate
    )
  ).toBe(false);
});

test.each(['', '   ', null])(
  'blank task workspace %s uses shared Space fallback',
  async (workspacePath) => {
    tasks.updateTask(task.id, { workspacePath });
    expect(await preparer()('attempt')).toHaveProperty('session');
    expect(records.get('direct-session')?.workspacePath).toBe('/repo');
  }
);

test.each(['archived', 'ended'] as const)(
  'non-active persisted session %s is rejected on retry and after load',
  async (status) => {
    await preparer()('attempt');
    const row = records.get('direct-session')!;
    records.set(row.id, { ...row, status });
    load.mockClear();
    expect(await preparer()('attempt')).toBe('direct_session_conflict');
    expect(load).not.toHaveBeenCalled();
    records.set(row.id, row);
    cached = null;
    load.mockImplementation(async () => {
      records.set(row.id, { ...row, status });
      cached = makeAgent(records.get(row.id)!);
      return cached;
    });
    expect(await preparer()('attempt')).toBe('direct_attempt_unavailable');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(records.get(row.id)?.status).toBe(status);
  }
);
