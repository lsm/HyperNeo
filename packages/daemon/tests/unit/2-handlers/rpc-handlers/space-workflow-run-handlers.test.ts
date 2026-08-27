import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { Space, SpaceWorkflow, SpaceWorkflowRun, SpaceTask } from '@hyperneo/shared';
import {
  setupSpaceWorkflowRunHandlers,
  type SpaceWorkflowRunTaskManagerFactory,
} from '../../../../src/lib/rpc-handlers/space-workflow-run-handlers.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository.ts';
import type { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';
import type { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import type { WorkflowRunArtifactCacheRepository } from '../../../../src/storage/repositories/workflow-run-artifact-cache-repository.ts';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';

type RequestHandler = (data: unknown) => Promise<unknown>;

const NOW = Date.now();

const mockSpace: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/tmp/test-workspace',
  name: 'Test Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
};

const mockWorkflow: SpaceWorkflow = {
  id: 'workflow-1',
  spaceId: 'space-1',
  name: 'Test Workflow',
  nodes: [{ id: 'step-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
  startNodeId: 'step-1',
  tags: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const mockRun: SpaceWorkflowRun = {
  id: 'run-1',
  spaceId: 'space-1',
  workflowId: 'workflow-1',
  title: 'Test Run',
  status: 'in_progress',
  startedAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const mockTask: SpaceTask = {
  id: 'task-1',
  spaceId: 'space-1',
  taskNumber: 1,
  title: 'Step One',
  description: '',
  status: 'open',
  priority: 'normal',
  labels: [],
  workflowRunId: 'run-1',
  dependsOn: [],
  result: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publish: mock(async () => ({ delivered: 0, failures: [] })),
    publishAsync: mock(() => {}),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
  return {
    getSpace: mock(async () => space),
  } as unknown as SpaceManager;
}

function createMockWorkflowManager(
  workflows: SpaceWorkflow[] = [mockWorkflow],
  singleWorkflow: SpaceWorkflow | null = mockWorkflow
): SpaceWorkflowManager {
  return {
    listWorkflows: mock(() => workflows),
    getWorkflow: mock(() => singleWorkflow),
  } as unknown as SpaceWorkflowManager;
}

function createMockRunRepo(
  run: SpaceWorkflowRun | null = mockRun,
  runs: SpaceWorkflowRun[] = [mockRun]
): SpaceWorkflowRunRepository {
  return {
    getRun: mock(() => run),
    listBySpace: mock(() => runs),
    updateStatus: mock((id: string, status: string) =>
      run ? { ...run, id, status: status as SpaceWorkflowRun['status'] } : null
    ),
    transitionStatus: mock((id: string, status: string) =>
      run ? { ...run, id, status: status as SpaceWorkflowRun['status'] } : null
    ),
  } as unknown as SpaceWorkflowRunRepository;
}

function createMockHookStateRepo(): WorkflowHookStateRepository {
  return {
    get: mock(() => null),
    ensure: mock((_runId: string, _hookId: string, defaults: Record<string, unknown> = {}) => ({
      runId: _runId,
      hookId: _hookId,
      version: 0,
      localState: defaults,
      lastResult: undefined,
      retryCount: 0,
      nextRetryAt: undefined,
      voteMaps: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    listByRun: mock(() => []),
    update: mock(() => null),
  } as unknown as WorkflowHookStateRepository;
}

function createMockRuntime(run: SpaceWorkflowRun = mockRun): SpaceRuntime {
  return {
    startWorkflowRun: mock(async () => ({ run, tasks: [mockTask] })),
    start: mock(() => {}),
    stop: mock(() => {}),
    executeTick: mock(async () => {}),
  } as unknown as SpaceRuntime;
}

function createMockRuntimeService(
  space: Space | null = mockSpace,
  runtime: SpaceRuntime = createMockRuntime()
): SpaceRuntimeService {
  return {
    createOrGetRuntime: mock(async (spaceId: string) => {
      if (!space) throw new Error(`Space not found: ${spaceId}`);
      return runtime;
    }),
    cancelWorkflowRun: mock(async () => ({ ...mockRun, status: 'cancelled' as const })),
    notifyRunResumed: mock(() => {}),
    start: mock(() => {}),
    stop: mock(() => {}),
    stopRuntime: mock(() => {}),
  } as unknown as SpaceRuntimeService;
}

function createMockTaskManager(tasks: SpaceTask[] = []): SpaceTaskManager {
  return {
    listTasksByWorkflowRun: mock(async () => tasks),
    cancelTask: mock(async (taskId: string) => ({
      ...mockTask,
      id: taskId,
      status: 'cancelled' as const,
    })),
  } as unknown as SpaceTaskManager;
}

function createMockSpaceTaskRepo(tasks: SpaceTask[] = [mockTask]): SpaceTaskRepository {
  return {
    listByWorkflowRun: mock(() => tasks),
    getTask: mock((taskId: string) => tasks.find((task) => task.id === taskId) ?? null),
  } as unknown as SpaceTaskRepository;
}

function createMockSpaceWorktreeManager(worktreePath: string | null = null): SpaceWorktreeManager {
  return {
    getTaskWorktreePath: mock(async () => worktreePath),
  } as unknown as SpaceWorktreeManager;
}

function createMockArtifactRepo(): WorkflowRunArtifactRepository {
  return {
    upsert: mock(() => ({
      id: 'artifact-1',
      runId: 'run-1',
      kind: 'generic',
      data: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    listByRun: mock(() => []),
    deleteByRun: mock(() => 0),
  } as unknown as WorkflowRunArtifactRepository;
}

function createMockArtifactCacheRepo(): WorkflowRunArtifactCacheRepository {
  return {
    get: mock(() => null),
    upsert: mock(() => ({
      id: 'cache-1',
      runId: 'run-1',
      taskId: '',
      cacheKey: 'gateArtifacts',
      status: 'ok',
      data: {},
      error: null,
      syncedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    listByRun: mock(() => []),
    deleteByRun: mock(() => 0),
    deleteByRunTask: mock(() => 0),
  } as unknown as WorkflowRunArtifactCacheRepository;
}

function createMockJobQueue(): JobQueueRepository {
  return {
    enqueue: mock(() => ({
      id: 'job-1',
      queue: 'spaceWorkflowRun.syncGateArtifacts',
      payload: {},
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runAt: Date.now(),
      priority: 0,
    })),
    listJobs: mock(() => []),
  } as unknown as JobQueueRepository;
}

describe('space-workflow-run-handlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus;
  let spaceManager: SpaceManager;
  let workflowManager: SpaceWorkflowManager;
  let runRepo: SpaceWorkflowRunRepository;
  let runtimeService: SpaceRuntimeService;
  let runtime: SpaceRuntime;
  let taskManagerFactory: SpaceWorkflowRunTaskManagerFactory;
  let taskManager: SpaceTaskManager;
  let spaceTaskRepo: SpaceTaskRepository;
  let spaceWorktreeManager: SpaceWorktreeManager;

  function setup(
    opts: {
      space?: Space | null;
      workflows?: SpaceWorkflow[];
      singleWorkflow?: SpaceWorkflow | null;
      run?: SpaceWorkflowRun | null;
      runs?: SpaceWorkflowRun[];
      tasks?: SpaceTask[];
      worktreePath?: string | null;
    } = {}
  ) {
    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    internalEventBus = createMockInternalEventBus();
    const resolvedSpace = 'space' in opts ? opts.space : mockSpace;
    spaceManager = createMockSpaceManager(resolvedSpace ?? null);
    workflowManager = createMockWorkflowManager(
      opts.workflows ?? [mockWorkflow],
      opts.singleWorkflow !== undefined ? opts.singleWorkflow : mockWorkflow
    );
    const resolvedRun = 'run' in opts ? opts.run : mockRun;
    runRepo = createMockRunRepo(resolvedRun ?? null, opts.runs ?? [mockRun]);
    runtime = createMockRuntime(resolvedRun ?? mockRun);
    runtimeService = createMockRuntimeService(resolvedSpace ?? null, runtime);
    taskManager = createMockTaskManager(opts.tasks ?? []);
    taskManagerFactory = mock(() => taskManager);
    spaceTaskRepo = createMockSpaceTaskRepo([mockTask]);
    spaceWorktreeManager = createMockSpaceWorktreeManager(opts.worktreePath ?? null);

    setupSpaceWorkflowRunHandlers(
      hub,
      spaceManager,
      workflowManager,
      runRepo,
      runtimeService,
      taskManagerFactory,
      internalEventBus,
      spaceTaskRepo,
      spaceWorktreeManager,
      createMockArtifactRepo(),
      createMockArtifactCacheRepo(),
      createMockJobQueue(),
      createMockHookStateRepo()
    );
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  beforeEach(() => setup());

  describe('spaceWorkflowRun.start', () => {
    it('throws if spaceId is missing', async () => {
      await expect(call('spaceWorkflowRun.start', { title: 'My Run' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws if title is missing', async () => {
      await expect(call('spaceWorkflowRun.start', { spaceId: 'space-1' })).rejects.toThrow(
        'title is required'
      );
    });

    it('throws if title is empty string', async () => {
      await expect(
        call('spaceWorkflowRun.start', { spaceId: 'space-1', title: '   ' })
      ).rejects.toThrow('title is required');
    });

    it('throws if space not found', async () => {
      setup({ space: null });
      await expect(
        call('spaceWorkflowRun.start', { spaceId: 'missing', title: 'Test' })
      ).rejects.toThrow('Space not found: missing');
    });

    it('throws if provided workflowId not found', async () => {
      setup({ singleWorkflow: null });
      await expect(
        call('spaceWorkflowRun.start', {
          spaceId: 'space-1',
          title: 'Test',
          workflowId: 'bad-wf',
        })
      ).rejects.toThrow('Workflow not found: bad-wf');
    });

    it('throws if provided workflowId belongs to a different space', async () => {
      const otherWorkflow: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-other',
        spaceId: 'space-99',
      };
      setup({ singleWorkflow: otherWorkflow });
      await expect(
        call('spaceWorkflowRun.start', {
          spaceId: 'space-1',
          title: 'Test',
          workflowId: 'wf-other',
        })
      ).rejects.toThrow('Workflow not found: wf-other');
    });

    it('throws if no workflows exist (auto-select mode)', async () => {
      setup({ workflows: [], singleWorkflow: null });
      await expect(
        call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Test' })
      ).rejects.toThrow('No workflows found for space: space-1');
    });

    it('creates run via runtime (event emission is owned by SpaceRuntimeService callbacks)', async () => {
      const result = await call('spaceWorkflowRun.start', {
        spaceId: 'space-1',
        title: 'My Run',
        description: 'Some context',
      });

      expect(result).toEqual({ run: mockRun });
      expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
        'space-1',
        'workflow-1',
        'My Run',
        'Some context'
      );
      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).not.toHaveBeenCalled();
    });

    it('auto-selects first workflow when workflowId not provided', async () => {
      await call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Auto' });
      expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
        'space-1',
        'workflow-1',
        'Auto',
        undefined
      );
    });

    it('uses provided workflowId when given', async () => {
      await call('spaceWorkflowRun.start', {
        spaceId: 'space-1',
        title: 'Explicit WF',
        workflowId: 'workflow-1',
      });
      expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
        'space-1',
        'workflow-1',
        'Explicit WF',
        undefined
      );
    });

    it('throws if provided workflowId is disabled', async () => {
      const disabledWorkflow = { ...mockWorkflow, disabled: true };
      setup({ singleWorkflow: disabledWorkflow });
      await expect(
        call('spaceWorkflowRun.start', {
          spaceId: 'space-1',
          title: 'Test',
          workflowId: 'workflow-1',
        })
      ).rejects.toThrow('Workflow is disabled: workflow-1');
    });

    it('auto-select skips disabled workflows', async () => {
      const enabledWf = { ...mockWorkflow, id: 'wf-enabled', name: 'Enabled' };
      const disabledWf = { ...mockWorkflow, id: 'wf-disabled', name: 'Disabled', disabled: true };
      setup({ workflows: [disabledWf, enabledWf], singleWorkflow: enabledWf });
      await call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Auto' });
      expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
        'space-1',
        'wf-enabled',
        'Auto',
        undefined
      );
    });

    it('auto-select prefers a default-tagged workflow over the first by created_at', async () => {
      const legacyRow = {
        ...mockWorkflow,
        id: 'wf-legacy',
        name: 'Coding Workflow',
        tags: ['coding'],
      };
      const stableRow = {
        ...mockWorkflow,
        id: 'wf-stable',
        name: 'Coding',
        tags: ['coding', 'default'],
      };
      setup({ workflows: [legacyRow, stableRow], singleWorkflow: stableRow });
      await call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Auto' });
      expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
        'space-1',
        'wf-stable',
        'Auto',
        undefined
      );
    });

    it('auto-select throws when all workflows are disabled', async () => {
      const disabledWf = { ...mockWorkflow, disabled: true };
      setup({ workflows: [disabledWf], singleWorkflow: disabledWf });
      await expect(
        call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Auto' })
      ).rejects.toThrow('No workflows found for space: space-1');
    });

    it('does not pass goalId to startWorkflowRun (removed)', async () => {
      await call('spaceWorkflowRun.start', {
        spaceId: 'space-1',
        title: 'Goal Run',
        goalId: 'goal-rpc-123',
      });
      expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
        'space-1',
        'workflow-1',
        'Goal Run',
        undefined
      );
    });
  });

  describe('spaceWorkflowRun.list', () => {
    it('throws if spaceId is missing', async () => {
      await expect(call('spaceWorkflowRun.list', {})).rejects.toThrow('spaceId is required');
    });

    it('throws if space not found', async () => {
      setup({ space: null });
      await expect(call('spaceWorkflowRun.list', { spaceId: 'missing' })).rejects.toThrow(
        'Space not found: missing'
      );
    });

    it('returns all runs for the space', async () => {
      const result = await call('spaceWorkflowRun.list', { spaceId: 'space-1' });
      expect(result).toEqual({ runs: [mockRun] });
    });

    it('filters runs by status when provided', async () => {
      const completedRun: SpaceWorkflowRun = { ...mockRun, id: 'run-2', status: 'done' };
      setup({ runs: [mockRun, completedRun] });

      const result = (await call('spaceWorkflowRun.list', {
        spaceId: 'space-1',
        status: 'in_progress',
      })) as { runs: SpaceWorkflowRun[] };

      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].id).toBe('run-1');
    });

    it('returns empty list when no runs match status filter', async () => {
      const result = (await call('spaceWorkflowRun.list', {
        spaceId: 'space-1',
        status: 'cancelled',
      })) as { runs: SpaceWorkflowRun[] };

      expect(result.runs).toHaveLength(0);
    });
  });

  describe('spaceWorkflowRun.get', () => {
    it('throws if id is missing', async () => {
      await expect(call('spaceWorkflowRun.get', {})).rejects.toThrow('id is required');
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(call('spaceWorkflowRun.get', { id: 'missing-run' })).rejects.toThrow(
        'WorkflowRun not found: missing-run'
      );
    });

    it('returns the run', async () => {
      const result = await call('spaceWorkflowRun.get', { id: 'run-1' });
      expect(result).toEqual({ run: mockRun });
    });

    it('returns the run without spaceId filter', async () => {
      const result = await call('spaceWorkflowRun.get', { id: 'run-1' });
      expect(result).toEqual({ run: mockRun });
    });

    it('throws if spaceId does not match run.spaceId (ownership check)', async () => {
      await expect(
        call('spaceWorkflowRun.get', { id: 'run-1', spaceId: 'space-other' })
      ).rejects.toThrow('WorkflowRun not found: run-1');
    });

    it('succeeds when spaceId matches run.spaceId', async () => {
      const result = await call('spaceWorkflowRun.get', { id: 'run-1', spaceId: 'space-1' });
      expect(result).toEqual({ run: mockRun });
    });
  });

  describe('spaceWorkflowRun.cancel', () => {
    it('throws if id is missing', async () => {
      await expect(call('spaceWorkflowRun.cancel', {})).rejects.toThrow('id is required');
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(call('spaceWorkflowRun.cancel', { id: 'missing-run' })).rejects.toThrow(
        'WorkflowRun not found: missing-run'
      );
    });

    it('returns success immediately if already cancelled', async () => {
      const cancelledRun: SpaceWorkflowRun = { ...mockRun, status: 'cancelled' };
      setup({ run: cancelledRun });

      const result = await call('spaceWorkflowRun.cancel', { id: 'run-1' });
      expect(result).toEqual({ success: true });
      expect(runRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('throws if trying to cancel a succeeded run', async () => {
      const doneRun: SpaceWorkflowRun = { ...mockRun, status: 'done' };
      setup({ run: doneRun });

      await expect(call('spaceWorkflowRun.cancel', { id: 'run-1' })).rejects.toThrow(
        'Cannot cancel a succeeded workflow run'
      );
    });

    it('delegates cancellation to the runtime service', async () => {
      setup({ tasks: [] });

      const result = await call('spaceWorkflowRun.cancel', { id: 'run-1' });
      expect(result).toEqual({ success: true });

      expect(runtimeService.cancelWorkflowRun).toHaveBeenCalledWith('space-1', 'run-1');
      expect(runRepo.transitionStatus).not.toHaveBeenCalled();
      expect(taskManager.cancelTask).not.toHaveBeenCalled();
    });

    it('does not cancel tasks in the RPC handler when delegating to runtime', async () => {
      const inProgressTask: SpaceTask = {
        ...mockTask,
        id: 'task-2',
        status: 'in_progress',
      };
      setup({ tasks: [mockTask, inProgressTask] });

      await call('spaceWorkflowRun.cancel', { id: 'run-1' });

      expect(runtimeService.cancelWorkflowRun).toHaveBeenCalledWith('space-1', 'run-1');
      expect(taskManagerFactory).not.toHaveBeenCalled();
      expect(taskManager.cancelTask).not.toHaveBeenCalled();
      expect(runRepo.transitionStatus).not.toHaveBeenCalled();
    });
  });

  describe('spaceWorkflowRun.getGateArtifacts — worktree resolution', () => {
    it('throws if runId is missing', async () => {
      setup();
      await expect(call('spaceWorkflowRun.getGateArtifacts', {})).rejects.toThrow(
        'runId is required'
      );
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(
        call('spaceWorkflowRun.getGateArtifacts', { runId: 'nonexistent' })
      ).rejects.toThrow('WorkflowRun not found: nonexistent');
    });

    it('throws if no workspace path found (no task worktree and no space workspacePath)', async () => {
      const spaceWithoutWorkspace: Space = { ...mockSpace, workspacePath: '' };
      setup({ space: spaceWithoutWorkspace, worktreePath: null });
      await expect(call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' })).rejects.toThrow(
        'No workspace path found for run: run-1'
      );
    });

    it('uses taskId directly when provided (skips listByWorkflowRun)', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager('/tmp/specific-task-worktree');
      const mockTaskRepo = createMockSpaceTaskRepo([mockTask]);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
        taskId: 'task-1',
      }).catch(() => {});

      expect(mockTaskRepo.listByWorkflowRun).not.toHaveBeenCalled();
      expect(mockWorktreeManager.getTaskWorktreePath).toHaveBeenCalledWith('space-1', 'task-1');
    });

    it('uses task worktree path when available (not root workspace)', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager('/tmp/task-worktree');
      const mockTaskRepo = createMockSpaceTaskRepo([mockTask]);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' }).catch(() => {});

      expect(mockTaskRepo.listByWorkflowRun).toHaveBeenCalledWith('run-1');
      expect(mockWorktreeManager.getTaskWorktreePath).toHaveBeenCalledWith('space-1', 'task-1');
    });

    it('falls back to root workspace path when no task worktree exists', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager(null);
      const mockTaskRepo = createMockSpaceTaskRepo([mockTask]);
      const mockSpaceMgr = createMockSpaceManager(mockSpace);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        mockSpaceMgr,
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' }).catch(() => {});

      expect(mockWorktreeManager.getTaskWorktreePath).toHaveBeenCalledWith('space-1', 'task-1');
      expect(mockSpaceMgr.getSpace).toHaveBeenCalled();
    });

    it('rejects a taskId whose task belongs to another run before any worktree lookup', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager('/foreign/worktree');
      const foreignTask = { ...mockTask, id: 'task-foreign', workflowRunId: 'run-other' };
      const mockTaskRepo = createMockSpaceTaskRepo([mockTask, foreignTask]);
      const mockSpaceMgr = createMockSpaceManager(mockSpace);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        mockSpaceMgr,
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
        taskId: 'task-foreign',
      }).catch(() => {});

      expect(mockWorktreeManager.getTaskWorktreePath).not.toHaveBeenCalled();
      expect(mockSpaceMgr.getSpace).toHaveBeenCalled();
    });

    it('falls back to root workspace when run has no tasks', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager(null);
      const mockTaskRepo = createMockSpaceTaskRepo([]);
      const mockSpaceMgr = createMockSpaceManager(mockSpace);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        mockSpaceMgr,
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' }).catch(() => {});

      expect(mockWorktreeManager.getTaskWorktreePath).not.toHaveBeenCalled();
      expect(mockSpaceMgr.getSpace).toHaveBeenCalled();
    });
  });

  describe('spaceWorkflowRun.getFileDiff — worktree resolution', () => {
    it('throws if runId is missing', async () => {
      setup();
      await expect(
        call('spaceWorkflowRun.getFileDiff', { filePath: 'src/foo.ts' })
      ).rejects.toThrow('runId is required');
    });

    it('throws if filePath is missing', async () => {
      setup();
      await expect(call('spaceWorkflowRun.getFileDiff', { runId: 'run-1' })).rejects.toThrow(
        'filePath is required'
      );
    });

    it('throws if filePath is absolute', async () => {
      setup();
      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'run-1', filePath: '/absolute/path.ts' })
      ).rejects.toThrow('filePath must be a relative path within the worktree');
    });

    it('throws if filePath contains path traversal', async () => {
      setup();
      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'run-1', filePath: '../outside.ts' })
      ).rejects.toThrow('filePath must be a relative path within the worktree');
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'nonexistent', filePath: 'src/foo.ts' })
      ).rejects.toThrow('WorkflowRun not found: nonexistent');
    });

    it('uses taskId directly when provided (skips listByWorkflowRun)', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager('/tmp/specific-task-worktree');
      const mockTaskRepo = createMockSpaceTaskRepo([mockTask]);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        taskId: 'task-1',
        filePath: 'src/foo.ts',
      }).catch(() => {});

      expect(mockTaskRepo.listByWorkflowRun).not.toHaveBeenCalled();
      expect(mockWorktreeManager.getTaskWorktreePath).toHaveBeenCalledWith('space-1', 'task-1');
    });

    it('falls back to tasks[0] worktree when no taskId provided', async () => {
      const mockWorktreeManager = createMockSpaceWorktreeManager('/tmp/task-worktree');
      const mockTaskRepo = createMockSpaceTaskRepo([mockTask]);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/foo.ts',
      }).catch(() => {});

      expect(mockTaskRepo.listByWorkflowRun).toHaveBeenCalledWith('run-1');
      expect(mockWorktreeManager.getTaskWorktreePath).toHaveBeenCalledWith('space-1', 'task-1');
    });

    it('throws if no workspace path found (no task worktree and no space workspacePath)', async () => {
      const spaceWithoutWorkspace: Space = { ...mockSpace, workspacePath: '' };
      const mockWorktreeManager = createMockSpaceWorktreeManager(null);
      const mockTaskRepo = createMockSpaceTaskRepo([]);

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(spaceWithoutWorkspace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        mockTaskRepo,
        mockWorktreeManager,
        createMockArtifactRepo(),
        createMockArtifactCacheRepo(),
        createMockJobQueue(),
        createMockHookStateRepo()
      );

      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'run-1', filePath: 'src/foo.ts' })
      ).rejects.toThrow('No workspace path found for run: run-1');
    });
  });

  describe('spaceWorkflowRun.getGateArtifacts — cache-first', () => {
    function setupWithRepos(opts: {
      cachedRow?: {
        data: Record<string, unknown>;
        status: 'ok' | 'syncing' | 'error';
        syncedAt: number;
      } | null;
    }) {
      const cacheRepo = {
        get: mock(() =>
          opts.cachedRow
            ? {
                id: 'c1',
                runId: 'run-1',
                taskId: '',
                cacheKey: 'gateArtifacts',
                status: opts.cachedRow.status,
                data: opts.cachedRow.data,
                error: null,
                syncedAt: opts.cachedRow.syncedAt,
                createdAt: opts.cachedRow.syncedAt,
                updatedAt: opts.cachedRow.syncedAt,
              }
            : null
        ),
        upsert: mock(() => ({})),
        listByRun: mock(() => []),
        deleteByRun: mock(() => 0),
        deleteByRunTask: mock(() => 0),
      } as unknown as WorkflowRunArtifactCacheRepository;

      const jobQueueRepo = {
        enqueue: mock(() => ({ id: 'j1' })),
        listJobs: mock(() => []),
      } as unknown as JobQueueRepository;

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        createMockSpaceTaskRepo([mockTask]),
        createMockSpaceWorktreeManager('/tmp/fake-worktree'),
        createMockArtifactRepo(),
        cacheRepo,
        jobQueueRepo,
        createMockHookStateRepo()
      );

      return { cacheRepo, jobQueueRepo };
    }

    it('returns fresh cached data without enqueuing a sync job', async () => {
      const { cacheRepo, jobQueueRepo } = setupWithRepos({
        cachedRow: {
          data: { files: [{ path: 'a.ts', additions: 1, deletions: 0 }] },
          status: 'ok',
          syncedAt: Date.now(),
        },
      });

      const result = (await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
      })) as {
        files: unknown[];
        cached: boolean;
        status: string;
      };

      expect(result.cached).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.files).toHaveLength(1);
      expect(cacheRepo.get).toHaveBeenCalled();
      expect(jobQueueRepo.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues a refresh job when cached data is stale', async () => {
      const { jobQueueRepo } = setupWithRepos({
        cachedRow: {
          data: { files: [] },
          status: 'ok',
          syncedAt: Date.now() - 120_000,
        },
      });

      await call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' });

      expect(jobQueueRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: 'spaceWorkflowRun.syncGateArtifacts',
          payload: expect.objectContaining({ runId: 'run-1' }),
        })
      );
    });

    it('still returns stale cached data while the refresh runs', async () => {
      setupWithRepos({
        cachedRow: {
          data: { files: [{ path: 'stale.ts', additions: 1, deletions: 0 }] },
          status: 'ok',
          syncedAt: Date.now() - 120_000,
        },
      });

      const result = (await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
      })) as { files: unknown[]; cached: boolean };

      expect(result.cached).toBe(true);
      expect(result.files).toHaveLength(1);
    });

    it('enqueues a sync job when no cache row exists (falls through to sync probe)', async () => {
      const { jobQueueRepo } = setupWithRepos({ cachedRow: null });

      await call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' }).catch(() => {});

      expect(jobQueueRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ queue: 'spaceWorkflowRun.syncGateArtifacts' })
      );
    });

    it('skips enqueue when an equivalent pending job already exists', async () => {
      const cacheRepo = {
        get: mock(() => null),
        upsert: mock(() => ({})),
        listByRun: mock(() => []),
        deleteByRun: mock(() => 0),
        deleteByRunTask: mock(() => 0),
      } as unknown as WorkflowRunArtifactCacheRepository;

      const jobQueueRepo = {
        enqueue: mock(() => ({ id: 'should-not-be-called' })),
        listJobs: mock(() => [
          {
            id: 'existing',
            queue: 'spaceWorkflowRun.syncGateArtifacts',
            payload: { runId: 'run-1' },
          },
        ]),
      } as unknown as JobQueueRepository;

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        createMockSpaceTaskRepo([mockTask]),
        createMockSpaceWorktreeManager('/tmp/fake-worktree'),
        createMockArtifactRepo(),
        cacheRepo,
        jobQueueRepo,
        createMockHookStateRepo()
      );

      await call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' }).catch(() => {});

      expect(jobQueueRepo.listJobs).toHaveBeenCalled();
      expect(jobQueueRepo.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('spaceWorkflowRun.getFileDiff — cache truncation', () => {
    it('returns truncated:true when cached diff exceeds size limit', async () => {
      const largePayload = 'x'.repeat(150 * 1024);
      const cacheRepo = {
        get: mock(() => ({
          id: 'c1',
          runId: 'run-1',
          taskId: '',
          cacheKey: 'fileDiff:src/big.ts',
          status: 'ok',
          data: {
            diff: largePayload.slice(0, 100 * 1024),
            additions: 0,
            deletions: 0,
            filePath: 'src/big.ts',
            truncated: true,
            originalSize: largePayload.length,
          },
          error: null,
          syncedAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
        upsert: mock(() => ({})),
        listByRun: mock(() => []),
        deleteByRun: mock(() => 0),
        deleteByRunTask: mock(() => 0),
      } as unknown as WorkflowRunArtifactCacheRepository;

      const jobQueueRepo = {
        enqueue: mock(() => ({})),
        listJobs: mock(() => []),
      } as unknown as JobQueueRepository;

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;

      setupSpaceWorkflowRunHandlers(
        hub,
        createMockSpaceManager(mockSpace),
        createMockWorkflowManager(),
        createMockRunRepo(mockRun),

        createMockRuntimeService(),
        mock(() => createMockTaskManager()),
        createMockInternalEventBus(),
        createMockSpaceTaskRepo([mockTask]),
        createMockSpaceWorktreeManager('/tmp/fake-worktree'),
        createMockArtifactRepo(),
        cacheRepo,
        jobQueueRepo,
        createMockHookStateRepo()
      );

      const result = (await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/big.ts',
      })) as {
        truncated: boolean;
        originalSize: number;
        diff: string;
      };

      expect(result.truncated).toBe(true);
      expect(result.originalSize).toBe(150 * 1024);
      expect(result.diff.length).toBe(100 * 1024);
    });
  });
});
