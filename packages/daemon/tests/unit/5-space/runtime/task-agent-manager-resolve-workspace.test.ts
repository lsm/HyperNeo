import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { configureLogger, LogLevel, subscribeToStructuredLogs } from '../../../../src/lib/logger';
import type { SpaceTask, Space } from '@hyperneo/shared';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { SpawnExecutionFlowDeps } from '../../../../src/lib/space/runtime/spawn-flow.ts';
import type { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';

describe('TaskAgentManager resolveWorkspacePath — spawn callback decision table (WS02a)', () => {
  const SPACE_ID = 'space-ws02a';
  const TASK_ID = 'task-ws02a';
  const TASK_TITLE = 'Pin workspace fallback';
  const TASK_NUMBER = 9;
  const SPACE_WORKSPACE = '/space/ws02a';
  const CREATED_PATH = '/space/ws02a/.hyperneo-worktrees/task-9-abc';
  const CACHED_PATH = '/space/ws02a/.hyperneo-worktrees/task-9-cached';
  const CREATE_ERROR = 'git worktree add failed';

  type Row = {
    name: string;
    cachedTaskWorktreePath: string | undefined;
    hasWorktreeManager: boolean;
    createResult: 'success' | 'fail' | 'n/a';
    expectedOutcome: { kind: 'path'; value: string } | { kind: 'error'; message: string };
    expectedCreateCalled: boolean;
    expectedCachedPath: string | undefined;
    expectedWarning: string;
  };

  let logEvents: Array<{ level: string; message: string }> = [];
  let unsubscribeLogs = () => {};

  beforeEach(() => {
    logEvents = [];
    unsubscribeLogs = subscribeToStructuredLogs((event) =>
      logEvents.push({ level: event.level, message: event.message })
    );
    configureLogger({ level: LogLevel.WARN });
  });

  afterEach(() => {
    configureLogger({ level: LogLevel.SILENT });
    unsubscribeLogs();
  });

  function makeTask(): SpaceTask {
    return {
      id: TASK_ID,
      spaceId: SPACE_ID,
      taskNumber: TASK_NUMBER,
      title: TASK_TITLE,
    } as unknown as SpaceTask;
  }

  function makeSpace(): Space {
    return { id: SPACE_ID, workspacePath: SPACE_WORKSPACE } as unknown as Space;
  }

  function makeManager(worktreeManager?: SpaceWorktreeManager): TaskAgentManager {
    const db = new BunDatabase(':memory:');
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      internalEventBus: { subscribe: () => () => {} },
      worktreeManager,
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
  }

  type BuildDeps = (state: {
    reservationHeld: boolean;
    reservedExecution: boolean;
  }) => SpawnExecutionFlowDeps;

  async function runRow(row: Row) {
    const createTaskWorktree = mock(async () => {
      if (row.createResult === 'fail') throw new Error(CREATE_ERROR);
      return { path: CREATED_PATH, slug: 'task-9-abc' };
    });

    const manager = makeManager(
      row.hasWorktreeManager
        ? ({ createTaskWorktree } as unknown as SpaceWorktreeManager)
        : undefined
    );

    const taskWorktreePaths = (manager as unknown as { taskWorktreePaths: Map<string, string> })
      .taskWorktreePaths;
    if (row.cachedTaskWorktreePath !== undefined) {
      taskWorktreePaths.set(TASK_ID, row.cachedTaskWorktreePath);
    }

    const deps = (
      manager as unknown as { buildSpawnExecutionFlowDeps: BuildDeps }
    ).buildSpawnExecutionFlowDeps({ reservationHeld: false, reservedExecution: false });

    if (row.expectedOutcome.kind === 'error') {
      await expect(deps.resolveWorkspacePath(makeTask(), makeSpace())).rejects.toThrow(
        row.expectedOutcome.message
      );
    } else {
      const workspacePath = await deps.resolveWorkspacePath(makeTask(), makeSpace());
      expect(workspacePath).toBe(row.expectedOutcome.value);
    }

    if (row.expectedCreateCalled) {
      expect(createTaskWorktree).toHaveBeenCalledTimes(1);
      expect(createTaskWorktree).toHaveBeenCalledWith(SPACE_ID, TASK_ID, TASK_TITLE, TASK_NUMBER);
    } else {
      expect(createTaskWorktree).not.toHaveBeenCalled();
    }

    expect(taskWorktreePaths.get(TASK_ID)).toBe(row.expectedCachedPath);

    if (row.expectedWarning) {
      expect(
        logEvents.some(
          (event) => event.level === 'warn' && event.message.includes(row.expectedWarning)
        )
      ).toBe(true);
    } else {
      expect(logEvents).toEqual([]);
    }
  }

  describe('empty cache — manager family', () => {
    test.each([
      {
        name: 'create succeeds and caches the created worktree path',
        cachedTaskWorktreePath: undefined,
        hasWorktreeManager: true,
        createResult: 'success',
        expectedOutcome: { kind: 'path', value: CREATED_PATH },
        expectedCreateCalled: true,
        expectedCachedPath: CREATED_PATH,
        expectedWarning: '',
      },
      {
        name: 'create fails and rejects the spawn instead of falling back to space workspace',
        cachedTaskWorktreePath: undefined,
        hasWorktreeManager: true,
        createResult: 'fail',
        expectedOutcome: {
          kind: 'error',
          message:
            'Task worktree creation failed for workflow task task-ws02a; refusing to spawn a node agent in the shared space workspace: git worktree add failed',
        },
        expectedCreateCalled: true,
        expectedCachedPath: undefined,
        expectedWarning: 'failing the spawn instead of falling back to the space workspace',
      },
    ] as Row[])('%s', async (row: Row) => {
      await runRow(row);
    });
  });

  describe('empty cache — no manager family', () => {
    test('runs directly in the space workspace', async () => {
      await runRow({
        name: 'no manager: runs directly in the space workspace',
        cachedTaskWorktreePath: undefined,
        hasWorktreeManager: false,
        createResult: 'n/a',
        expectedOutcome: { kind: 'path', value: SPACE_WORKSPACE },
        expectedCreateCalled: false,
        expectedCachedPath: undefined,
        expectedWarning: '',
      });
    });
  });

  describe('cached path family', () => {
    test.each([
      {
        name: 'reuses the cached path (manager present)',
        cachedTaskWorktreePath: CACHED_PATH,
        hasWorktreeManager: true,
        createResult: 'n/a',
        expectedOutcome: { kind: 'path', value: CACHED_PATH },
        expectedCreateCalled: false,
        expectedCachedPath: CACHED_PATH,
        expectedWarning: '',
      },
      {
        name: 'reuses the cached path (no manager)',
        cachedTaskWorktreePath: CACHED_PATH,
        hasWorktreeManager: false,
        createResult: 'n/a',
        expectedOutcome: { kind: 'path', value: CACHED_PATH },
        expectedCreateCalled: false,
        expectedCachedPath: CACHED_PATH,
        expectedWarning: '',
      },
    ] as Row[])('%s', async (row: Row) => {
      await runRow(row);
    });
  });
});

describe('TaskAgentManager getTaskWorktreePath — cache + durable fallback (WS10)', () => {
  const SPACE_ID = 'space-ws10';
  const TASK_ID = 'task-ws10';
  const STORED_PATH = '/space/ws10/.hyperneo-worktrees/task-10-abc';

  function makeManagerWithWorktree(overrides: {
    storedPath?: string | null;
    hasManager?: boolean;
  }): TaskAgentManager {
    const db = new BunDatabase(':memory:');
    const worktreeManager =
      overrides.hasManager === false
        ? undefined
        : ({
            getTaskWorktreePathSync: () =>
              overrides.storedPath === undefined ? null : overrides.storedPath,
          } as unknown as SpaceWorktreeManager);
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      internalEventBus: { subscribe: () => () => {} },
      taskRepo: {
        getTask: (taskId: string) =>
          taskId === TASK_ID ? ({ id: TASK_ID, spaceId: SPACE_ID } as unknown as SpaceTask) : null,
      },
      worktreeManager,
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
  }

  test('returns the in-memory cached path without consulting the worktree manager', () => {
    const manager = makeManagerWithWorktree({ storedPath: '/should/not/be/consulted' });
    const internal = manager as unknown as { taskWorktreePaths: Map<string, string> };
    internal.taskWorktreePaths.set(TASK_ID, STORED_PATH);

    expect(manager.getTaskWorktreePath(TASK_ID)).toBe(STORED_PATH);
  });

  test('falls back to the stored worktree row and caches it in memory', () => {
    const manager = makeManagerWithWorktree({ storedPath: STORED_PATH });
    const internal = manager as unknown as { taskWorktreePaths: Map<string, string> };
    expect(internal.taskWorktreePaths.has(TASK_ID)).toBe(false);

    expect(manager.getTaskWorktreePath(TASK_ID)).toBe(STORED_PATH);
    expect(internal.taskWorktreePaths.get(TASK_ID)).toBe(STORED_PATH);
  });

  test('returns undefined when no worktree manager exists', () => {
    const manager = makeManagerWithWorktree({ hasManager: false });

    expect(manager.getTaskWorktreePath(TASK_ID)).toBeUndefined();
  });

  test('returns undefined when the stored row is absent', () => {
    const manager = makeManagerWithWorktree({ storedPath: null });
    const internal = manager as unknown as { taskWorktreePaths: Map<string, string> };

    expect(manager.getTaskWorktreePath(TASK_ID)).toBeUndefined();
    expect(internal.taskWorktreePaths.has(TASK_ID)).toBe(false);
  });

  test('returns undefined when the task itself is not found', () => {
    const manager = makeManagerWithWorktree({ storedPath: STORED_PATH });

    expect(manager.getTaskWorktreePath('does-not-exist')).toBeUndefined();
  });
});
