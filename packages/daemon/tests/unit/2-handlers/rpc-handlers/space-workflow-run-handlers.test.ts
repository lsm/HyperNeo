import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { SpaceWorkflowRun, SpaceTask, WorkflowHookStateSnapshot } from '@hyperneo/shared';
import {
  setupSpaceWorkflowRunHandlers,
  type SpaceWorkflowRunTaskManagerFactory,
} from '../../../../src/lib/rpc-handlers/space-workflow-run-handlers.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository.ts';
import type { SpaceTaskManager } from '../../../../src/lib/tasks/task-manager.ts';
import type { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { QUEUED_RETRYABLE_ACTION_STATE_KEY } from '../../../../src/lib/hooks/hook-engine.ts';

type RequestHandler = (data: unknown) => Promise<unknown>;

const NOW = Date.now();

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

function createMockWorkflowManager(): SpaceWorkflowManager {
  return {} as unknown as SpaceWorkflowManager;
}

function createMockRunRepo(run: SpaceWorkflowRun | null = mockRun): SpaceWorkflowRunRepository {
  return {
    getRun: mock(() => run),
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

describe('space-workflow-run-handlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus;
  let workflowManager: SpaceWorkflowManager;
  let runRepo: SpaceWorkflowRunRepository;
  let taskManagerFactory: SpaceWorkflowRunTaskManagerFactory;
  let taskManager: SpaceTaskManager;

  function setup(
    opts: {
      run?: SpaceWorkflowRun | null;
      tasks?: SpaceTask[];
      hookStateRepo?: WorkflowHookStateRepository;
      isQueuedRetryOwner?: (runId: string, sessionId: string) => boolean;
      isQueuedRetryRestorePending?: (sessionId: string) => boolean;
    } = {}
  ) {
    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    internalEventBus = createMockInternalEventBus();
    workflowManager = createMockWorkflowManager();
    const resolvedRun = 'run' in opts ? opts.run : mockRun;
    runRepo = createMockRunRepo(resolvedRun ?? null);
    taskManager = createMockTaskManager(opts.tasks ?? []);
    taskManagerFactory = mock(() => taskManager);

    setupSpaceWorkflowRunHandlers(
      hub,
      workflowManager,
      runRepo,
      taskManagerFactory,
      internalEventBus,
      createMockArtifactRepo(),
      opts.hookStateRepo ?? createMockHookStateRepo(),
      opts.isQueuedRetryOwner ?? (() => true),
      opts.isQueuedRetryRestorePending ?? (() => true)
    );
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  beforeEach(() => setup());

  describe('spaceWorkflowRun.retryHook', () => {
    it('preserves a queued action when its in-memory retry timer is unavailable', async () => {
      const queuedAction = {
        actionKey: 'persisted-retry',
        hookId: 'hook-1',
        methodName: 'send_message',
        args: { target: 'Review', message: 'ready' },
        meta: {
          taskId: 'task-1',
          nodeId: 'node-1',
          sessionId: 'session-1',
          agentName: 'Coder',
        },
        isFollowUp: false,
        nextRetryAt: Date.now() - 1,
        retryAfterMs: 5,
        queuedAt: Date.now() - 10,
      };
      const snapshot: WorkflowHookStateSnapshot = {
        runId: 'run-1',
        hookId: 'hook-1',
        version: 1,
        localState: { [QUEUED_RETRYABLE_ACTION_STATE_KEY]: queuedAction },
        lastResult: { type: 'retryable_block', reason: 'waiting' },
        retryCount: 1,
        nextRetryAt: queuedAction.nextRetryAt,
        voteMaps: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const hookStateRepo = {
        get: mock(() => snapshot),
        update: mock(() => ({ ...snapshot, version: 2 })),
      } as unknown as WorkflowHookStateRepository;
      setup({ hookStateRepo });

      await expect(
        call('spaceWorkflowRun.retryHook', { runId: 'run-1', hookId: 'hook-1' })
      ).rejects.toThrow('retry runtime is not ready');
      expect(hookStateRepo.update).not.toHaveBeenCalled();
      expect(snapshot.localState[QUEUED_RETRYABLE_ACTION_STATE_KEY]).toEqual(queuedAction);
    });

    it.each([
      ['a replaced owner', false, true],
      ['a completed restoration that did not schedule it', true, false],
    ])('releases a queued action for %s', async (_case, isOwner, restorePending) => {
      const queuedAction = {
        actionKey: 'persisted-retry',
        hookId: 'hook-1',
        methodName: 'send_message',
        args: { target: 'Review', message: 'ready' },
        meta: {
          taskId: 'task-1',
          nodeId: 'node-1',
          sessionId: 'session-1',
          agentName: 'Coder',
        },
        isFollowUp: false,
        nextRetryAt: Date.now() - 1,
        retryAfterMs: 5,
        queuedAt: Date.now() - 10,
      };
      const snapshot: WorkflowHookStateSnapshot = {
        runId: 'run-1',
        hookId: 'hook-1',
        version: 1,
        localState: { [QUEUED_RETRYABLE_ACTION_STATE_KEY]: queuedAction },
        lastResult: { type: 'retryable_block', reason: 'waiting' },
        retryCount: 1,
        nextRetryAt: queuedAction.nextRetryAt,
        voteMaps: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const update = mock(() => ({
        ...snapshot,
        version: 2,
        localState: { [QUEUED_RETRYABLE_ACTION_STATE_KEY]: null },
      }));
      const hookStateRepo = {
        get: mock(() => snapshot),
        update,
      } as unknown as WorkflowHookStateRepository;
      setup({
        hookStateRepo,
        isQueuedRetryOwner: () => isOwner,
        isQueuedRetryRestorePending: () => restorePending,
      });

      await expect(
        call('spaceWorkflowRun.retryHook', { runId: 'run-1', hookId: 'hook-1' })
      ).resolves.toBeDefined();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]?.[2]).toMatchObject({
        localState: { [QUEUED_RETRYABLE_ACTION_STATE_KEY]: null },
        lastResult: { type: 'allow' },
      });
    });
  });
});
