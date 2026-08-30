import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type Mock,
  mock,
  test,
} from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  McpServerConfig,
  ModelInfo,
  Session,
  Space,
  SpaceGoalOutcomeNotification,
  SpaceLongHorizonAgent,
  SpaceWorkerAgent,
} from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { clearModelsCache, setModelsCache } from '../../../../src/lib/model-service.ts';
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../../src/lib/providers/registry.ts';
import type { SessionManager } from '../../../../src/lib/session-manager.ts';
import {
  LONG_HORIZON_AGENT_BUILTIN_TOOLS,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
} from '../../../../src/lib/space/agents/long-horizon-agent-tools.ts';
import {
  encodeActorIdComponent,
  longTermAgentSessionId,
} from '../../../../src/lib/space/long-term-agent-session.ts';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceAgentManager as AgentMgr } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceManager as SpaceMgr } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceWorkflowManager as WorkflowMgr } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeServiceConfig } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import type { SpaceAgentInboxMessageRecord } from '../../../../src/storage/repositories/space-agent-inbox-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import type { SpaceGoalOutcomeNotificationRepository } from '../../../../src/storage/repositories/space-goal-outcome-notification-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskRepository as SpaceTaskRepo } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceWorkflowRunRepository as SpaceWorkflowRunRepo } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as StorageDatabase } from '../../../../src/storage/database';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import {
  createTestInternalEventBus,
  createTestDb,
  createTestSession,
} from '../../../helpers/database.ts';

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

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
  return {
    getSpace: mock(async () => space),
    listSpaces: mock(async () => []),
  } as unknown as SpaceManager;
}

function buildConfig(
  spaceManager: SpaceManager,
  tickIntervalMs = 60_000
): SpaceRuntimeServiceConfig {
  return {
    db: {} as BunDatabase,
    spaceManager,
    spaceAgentManager: {} as SpaceAgentManager,
    spaceWorkflowManager: {} as SpaceWorkflowManager,
    workflowRunRepo: {} as SpaceWorkflowRunRepository,
    taskRepo: {} as SpaceTaskRepository,
    nodeExecutionRepo: makeNoopNodeExecutionRepo(),
    tickIntervalMs,
  };
}

function makeNoopNodeExecutionRepo(): NodeExecutionRepository {
  return {
    getByAgentSessionId: mock(() => null),
    getById: mock(() => null),
  } as unknown as NodeExecutionRepository;
}

function buildLongHorizonAgent(
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id: 'lh-agent-1',
    spaceId: 'space-1',
    handle: 'researcher',
    displayName: 'Researcher',
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: '',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: { mode: 'inherit', tools: [] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as SpaceLongHorizonAgent;
}

describe('SpaceRuntimeService', () => {
  let spaceManager: SpaceManager;
  let service: SpaceRuntimeService;

  const previousConsumptionTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
  beforeAll(() => {
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '50';
  });
  afterAll(() => {
    if (previousConsumptionTimeout === undefined) {
      delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
    } else {
      process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previousConsumptionTimeout;
    }
  });

  beforeEach(() => {
    spaceManager = createMockSpaceManager(mockSpace);
    service = new SpaceRuntimeService(buildConfig(spaceManager));
  });

  describe('createOrGetRuntime()', () => {
    test('throws if space not found', async () => {
      const noSpaceManager = createMockSpaceManager(null);
      const svc = new SpaceRuntimeService(buildConfig(noSpaceManager));

      await expect(svc.createOrGetRuntime('missing-space')).rejects.toThrow(
        'Space not found: missing-space'
      );
    });

    test('starts runtime and returns a SpaceRuntime instance', async () => {
      const runtime = await service.createOrGetRuntime('space-1');

      expect(runtime).toBeDefined();
      expect(typeof runtime.start).toBe('function');
      expect(typeof runtime.stop).toBe('function');
      expect(typeof runtime.executeTick).toBe('function');
    });

    test('auto-starts the service when not yet started', async () => {
      expect((service as unknown as { started: boolean }).started).toBe(false);
      await service.createOrGetRuntime('space-1');
      expect((service as unknown as { started: boolean }).started).toBe(true);
    });

    test('returns the same runtime object on repeated calls', async () => {
      const runtime1 = await service.createOrGetRuntime('space-1');
      const runtime2 = await service.createOrGetRuntime('space-1');

      expect(runtime1).toBe(runtime2);
    });

    test('returns same runtime for different space IDs (shared runtime)', async () => {
      const space2Manager = {
        getSpace: mock(async (id: string) =>
          id === 'space-2' ? { ...mockSpace, id: 'space-2' } : mockSpace
        ),
      } as unknown as SpaceManager;
      const svc = new SpaceRuntimeService(buildConfig(space2Manager));

      const runtime1 = await svc.createOrGetRuntime('space-1');
      const runtime2 = await svc.createOrGetRuntime('space-2');

      expect(runtime1).toBe(runtime2);
    });
  });

  describe('stopRuntime()', () => {
    test('is a no-op — does not throw', () => {
      expect(() => service.stopRuntime('space-1')).not.toThrow();
      expect(() => service.stopRuntime('nonexistent')).not.toThrow();
    });

    test('does not stop the service (shared runtime remains running)', async () => {
      service.start();
      service.stopRuntime('space-1');
      expect((service as unknown as { started: boolean }).started).toBe(true);
    });
  });

  describe('stopActiveWork() — park semantics', () => {
    function makeRecordingRepos(
      tasks: Array<{ id: string; status: string }>,
      runs: Array<{ id: string; status: string }> = []
    ) {
      const updateCalls: Array<{ taskId: string; updates: unknown }> = [];
      const transitionCalls: Array<{ runId: string; status: string }> = [];
      const mockTaskRepo = {
        listBySpace: () => tasks,
        updateTask: (taskId: string, updates: unknown) => {
          updateCalls.push({ taskId, updates });
        },
      } as unknown as SpaceTaskRepository;
      const mockWorkflowRunRepo = {
        listBySpace: () => runs,
        transitionStatus: (runId: string, status: string) => {
          transitionCalls.push({ runId, status });
        },
      } as unknown as SpaceWorkflowRunRepository;
      return { mockTaskRepo, mockWorkflowRunRepo, updateCalls, transitionCalls };
    }

    function spyRuntime(svc: SpaceRuntimeService) {
      const runtime = (
        svc as unknown as {
          runtime: {
            holdSpaceDeliveries: (spaceId: string) => void;
            parkInFlightExecutionsForSpace: (spaceId: string) => void;
            clearRunInterests: (runId: string) => void;
          };
        }
      ).runtime;
      const runtimeCalls: string[] = [];
      const originalHold = runtime.holdSpaceDeliveries.bind(runtime);
      runtime.holdSpaceDeliveries = (spaceId: string) => {
        runtimeCalls.push(`holdDeliveries:${spaceId}`);
        return originalHold(spaceId);
      };
      runtime.parkInFlightExecutionsForSpace = (spaceId: string) => {
        runtimeCalls.push(`park:${spaceId}`);
      };
      runtime.clearRunInterests = (runId: string) => {
        runtimeCalls.push(`clearRunInterests:${runId}`);
      };
      return runtimeCalls;
    }

    test('cleans up in_progress, open, and rate-limited tasks with reason stopped and never writes task status', async () => {
      const tasks = [
        { id: 't1', status: 'in_progress' },
        { id: 't2', status: 'open' },
        { id: 't3', status: 'rate_limited' },
        { id: 't4', status: 'review' },
        { id: 't5', status: 'done' },
        { id: 't6', status: 'blocked' },
      ];
      const { mockTaskRepo, mockWorkflowRunRepo, updateCalls } = makeRecordingRepos(tasks);
      const cleanupCalls: Array<{ taskId: string; reason: string }> = [];
      const mockTaskAgentManager = {
        cleanup: async (taskId: string, reason: string) => {
          cleanupCalls.push({ taskId, reason });
        },
        listLiveSessionTaskIdsForSpace: () => [],
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async () => [],
      } as unknown as TaskAgentManager;

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(mockTaskAgentManager);
      const runtimeCalls = spyRuntime(svc);

      await svc.stopActiveWork('space-1');

      expect(cleanupCalls.map((c) => c.taskId).sort()).toEqual(['t1', 't2', 't3']);
      expect(cleanupCalls.every((c) => c.reason === 'stopped')).toBe(true);
      expect(updateCalls).toHaveLength(0);
      expect(runtimeCalls).toEqual(['holdDeliveries:space-1', 'park:space-1']);
    });

    test('interrupts live sub-sessions regardless of task status via space-wide enumeration', async () => {
      const tasks = [
        { id: 't1', status: 'in_progress' },
        { id: 'review-task', status: 'review' },
        { id: 'blocked-task', status: 'blocked' },
        { id: 'done-task', status: 'done' },
      ];
      const { mockTaskRepo, mockWorkflowRunRepo, updateCalls } = makeRecordingRepos(tasks);
      const cleanupCalls: Array<{ taskId: string; reason: string }> = [];
      const verifiedStopCalls: string[][] = [];
      const mockTaskAgentManager = {
        cleanup: async (taskId: string, reason: string) => {
          cleanupCalls.push({ taskId, reason });
        },
        listLiveSessionTaskIdsForSpace: () => ['review-task', 'blocked-task', 'done-task'],
        getSubSessionIdsForTasks: (taskIds: string[]) =>
          taskIds.map((taskId) => `space:space-1:task:${taskId}:exec:exec-1`),
        stopSessionsVerified: async (sessionIds: string[]) => {
          verifiedStopCalls.push(sessionIds);
          return sessionIds.map((sessionId) => ({ sessionId, stopped: true }));
        },
      } as unknown as TaskAgentManager;

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(mockTaskAgentManager);
      spyRuntime(svc);

      await svc.stopActiveWork('space-1');

      expect(cleanupCalls.map((c) => c.taskId).sort()).toEqual([
        'blocked-task',
        'done-task',
        'review-task',
        't1',
      ]);
      expect(cleanupCalls.every((c) => c.reason === 'stopped')).toBe(true);
      expect(verifiedStopCalls).toHaveLength(1);
      expect(verifiedStopCalls[0]?.slice().sort()).toEqual([
        'space:space-1:task:blocked-task:exec:exec-1',
        'space:space-1:task:done-task:exec:exec-1',
        'space:space-1:task:review-task:exec:exec-1',
        'space:space-1:task:t1:exec:exec-1',
      ]);
      expect(updateCalls).toHaveLength(0);
    });

    test('never transitions workflow run statuses or clears run interests', async () => {
      const { mockTaskRepo, mockWorkflowRunRepo, updateCalls, transitionCalls } =
        makeRecordingRepos(
          [{ id: 't1', status: 'in_progress' }],
          [
            { id: 'run-1', status: 'in_progress' },
            { id: 'run-2', status: 'blocked' },
            { id: 'run-3', status: 'pending' },
          ]
        );
      const mockTaskAgentManager = {
        cleanup: async () => {},
        listLiveSessionTaskIdsForSpace: () => [],
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async () => [],
      } as unknown as TaskAgentManager;

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(mockTaskAgentManager);
      const runtimeCalls = spyRuntime(svc);

      await svc.stopActiveWork('space-1');

      expect(transitionCalls).toHaveLength(0);
      expect(runtimeCalls.some((c) => c.startsWith('clearRunInterests:'))).toBe(false);
      expect(runtimeCalls).toContain('park:space-1');
      expect(updateCalls).toHaveLength(0);
    });

    test('a real TaskAgentManager holds zero live sub-sessions for the space after stop', async () => {
      const tamDb = new BunDatabase(':memory:');
      const unregistered: string[] = [];
      const realTam = new TaskAgentManager({
        db: { getDatabase: () => tamDb },
        internalEventBus: { subscribe: () => () => {} },
        sessionManager: {
          getCachedSession: () => null,
          unregisterSession: async (sessionId: string) => {
            unregistered.push(sessionId);
          },
        },
      } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
      const internals = realTam as unknown as {
        subSessions: Map<string, Map<string, AgentSession>>;
      };
      const fakeSession = {
        handleInterrupt: async () => {},
        cleanup: async () => {},
        getProcessingState: () => ({ status: 'idle' }),
        isInterruptInProgress: () => false,
        getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
        processExitedPromise: null,
      } as unknown as AgentSession;
      internals.subSessions.set(
        'review-task',
        new Map([['space:space-1:task:review-task:exec:exec-1', fakeSession]])
      );
      internals.subSessions.set(
        'blocked-task',
        new Map([['space:space-1:task:blocked-task:exec:exec-2', fakeSession]])
      );
      internals.subSessions.set(
        'other-space-task',
        new Map([['space:space-9:task:other-space-task:exec:exec-3', fakeSession]])
      );

      const { mockTaskRepo, mockWorkflowRunRepo } = makeRecordingRepos([
        { id: 't1', status: 'in_progress' },
        { id: 'review-task', status: 'review' },
      ]);

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(realTam);
      spyRuntime(svc);

      await svc.stopActiveWork('space-1');

      expect(realTam.listLiveSessionTaskIdsForSpace('space-1')).toEqual([]);
      expect(realTam.listLiveSessionTaskIdsForSpace('space-9')).toEqual(['other-space-task']);
      expect(unregistered.sort()).toEqual([
        'space:space-1:task:blocked-task:exec:exec-2',
        'space:space-1:task:review-task:exec:exec-1',
      ]);
    });

    test('swallows cleanup errors so a single stuck task does not block the stop', async () => {
      const cleanupCalls: string[] = [];
      const { mockTaskRepo, mockWorkflowRunRepo } = makeRecordingRepos([
        { id: 'ok-1', status: 'in_progress' },
        { id: 'broken', status: 'in_progress' },
        { id: 'ok-2', status: 'in_progress' },
      ]);
      const mockTaskAgentManager = {
        cleanup: async (taskId: string) => {
          cleanupCalls.push(taskId);
          if (taskId === 'broken') throw new Error('boom');
        },
        listLiveSessionTaskIdsForSpace: () => [],
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async () => [],
      } as unknown as TaskAgentManager;

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(mockTaskAgentManager);

      await expect(svc.stopActiveWork('space-1')).resolves.toBeUndefined();
      expect(cleanupCalls.sort()).toEqual(['broken', 'ok-1', 'ok-2']);
    });

    test('surfaces verified-stop failures without throwing and still runs bookkeeping cleanup', async () => {
      const { mockTaskRepo, mockWorkflowRunRepo } = makeRecordingRepos([
        { id: 't1', status: 'in_progress' },
        { id: 't2', status: 'open' },
      ]);
      const order: string[] = [];
      const cleanupCalls: string[] = [];
      const mockTaskAgentManager = {
        cleanup: async (taskId: string) => {
          order.push(`cleanup:${taskId}`);
          cleanupCalls.push(taskId);
        },
        listLiveSessionTaskIdsForSpace: () => [],
        getSubSessionIdsForTasks: () => ['sess-leaky'],
        stopSessionsVerified: async () => {
          order.push('stopSessionsVerified');
          return [
            {
              sessionId: 'sess-leaky',
              stopped: false,
              detail: "still alive: processing state 'processing'",
            },
          ];
        },
      } as unknown as TaskAgentManager;

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(mockTaskAgentManager);
      const runtimeCalls = spyRuntime(svc);

      await expect(svc.stopActiveWork('space-1')).resolves.toBeUndefined();

      expect(order.indexOf('stopSessionsVerified')).toBeLessThan(order.indexOf('cleanup:t1'));
      expect(cleanupCalls.sort()).toEqual(['t1', 't2']);
      expect(runtimeCalls).toContain('park:space-1');
    });

    test('a verified-stop rejection does not abort the stop or skip cleanup', async () => {
      const { mockTaskRepo, mockWorkflowRunRepo } = makeRecordingRepos([
        { id: 't1', status: 'in_progress' },
      ]);
      const cleanupCalls: string[] = [];
      const mockTaskAgentManager = {
        cleanup: async (taskId: string) => {
          cleanupCalls.push(taskId);
        },
        listLiveSessionTaskIdsForSpace: () => [],
        getSubSessionIdsForTasks: () => ['sess-1'],
        stopSessionsVerified: async () => {
          throw new Error('interrupt machinery exploded');
        },
      } as unknown as TaskAgentManager;

      const svc = new SpaceRuntimeService({
        ...buildConfig(spaceManager),
        taskRepo: mockTaskRepo,
        workflowRunRepo: mockWorkflowRunRepo,
      });
      svc.setTaskAgentManager(mockTaskAgentManager);
      spyRuntime(svc);

      await expect(svc.stopActiveWork('space-1')).resolves.toBeUndefined();
      expect(cleanupCalls).toEqual(['t1']);
    });
  });

  describe('setTaskAgentManager()', () => {
    test('method exists and is callable', () => {
      expect(typeof service.setTaskAgentManager).toBe('function');
    });

    test('accepts a TaskAgentManager without throwing', () => {
      const mockManager = {} as TaskAgentManager;
      expect(() => service.setTaskAgentManager(mockManager)).not.toThrow();
    });

    test('delegates to the underlying SpaceRuntime', () => {
      const mockManager = {} as TaskAgentManager;
      const runtime = (
        service as unknown as { runtime: { config: { taskAgentManager?: TaskAgentManager } } }
      ).runtime;
      expect(runtime.config.taskAgentManager).toBeUndefined();
      service.setTaskAgentManager(mockManager);
      expect(runtime.config.taskAgentManager).toBe(mockManager);
    });

    test('config.taskAgentManager is passed to SpaceRuntime when provided at construction', () => {
      const mockManager = {} as TaskAgentManager;
      const config: SpaceRuntimeServiceConfig = {
        ...buildConfig(spaceManager),
        taskAgentManager: mockManager,
      };
      const svc = new SpaceRuntimeService(config);
      const runtime = (
        svc as unknown as { runtime: { config: { taskAgentManager?: TaskAgentManager } } }
      ).runtime;
      expect(runtime.config.taskAgentManager).toBe(mockManager);
    });
  });

  describe('start() / stop()', () => {
    test('start() sets started to true', () => {
      expect((service as unknown as { started: boolean }).started).toBe(false);
      service.start();
      expect((service as unknown as { started: boolean }).started).toBe(true);
    });

    test('start() is idempotent — calling twice is safe', () => {
      service.start();
      service.start();
      expect((service as unknown as { started: boolean }).started).toBe(true);
    });

    test('stop() sets started to false', async () => {
      service.start();
      await service.stop();
      expect((service as unknown as { started: boolean }).started).toBe(false);
    });

    test('stop() is idempotent — calling twice is safe', async () => {
      service.start();
      await service.stop();
      await service.stop();
      expect((service as unknown as { started: boolean }).started).toBe(false);
    });

    test('stop() on a never-started service is safe', async () => {
      await expect(service.stop()).resolves.toBeUndefined();
    });

    test('can restart after stop', async () => {
      service.start();
      await service.stop();
      service.start();
      expect((service as unknown as { started: boolean }).started).toBe(true);

      const runtime = await service.createOrGetRuntime('space-1');
      expect(runtime).toBeDefined();
    });

    test('start() runs recoverStalledWorkflowRuns after provisioning, before ready() resolves (Task #120)', async () => {
      const order: string[] = [];

      const svc = new SpaceRuntimeService(buildConfig(spaceManager));

      const originalProvision = (
        svc as unknown as { provisionExistingSpaces: () => Promise<void> }
      ).provisionExistingSpaces.bind(svc);
      (svc as unknown as { provisionExistingSpaces: () => Promise<void> }).provisionExistingSpaces =
        async () => {
          await new Promise((r) => setTimeout(r, 0));
          order.push('provision');
          await originalProvision();
        };

      const originalRecover = svc.recoverStalledWorkflowRuns.bind(svc);
      svc.recoverStalledWorkflowRuns = async () => {
        order.push('recover');
        await originalRecover();
      };

      svc.start();
      await svc.ready();

      expect(order).toEqual(['provision', 'recover']);

      await svc.stop();
    });

    test('recoverStalledWorkflowRuns swallows errors from underlying runtime (start() never rejects)', async () => {
      const svc = new SpaceRuntimeService(buildConfig(spaceManager));
      const runtime = (svc as unknown as { runtime: { recoverStalledRuns: () => Promise<void> } })
        .runtime;
      runtime.recoverStalledRuns = async () => {
        throw new Error('explode');
      };

      await expect(svc.recoverStalledWorkflowRuns()).resolves.toBeUndefined();

      svc.start();
      await expect(svc.ready()).resolves.toBeUndefined();

      await svc.stop();
    });

    test('space resume hook schedules recovery only for the resumed space', async () => {
      const svc = new SpaceRuntimeService(buildConfig(spaceManager));
      const calls: string[] = [];
      const runtime = (
        svc as unknown as {
          runtime: {
            recoverStalledRunsForSpace: (spaceId: string) => Promise<void>;
          };
        }
      ).runtime;
      runtime.recoverStalledRunsForSpace = async (spaceId: string) => {
        calls.push(spaceId);
      };

      svc.recoverStalledWorkflowRunsAfterSpaceResume('space-1');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual(['space-1']);
    });

    test('space resume recovery calls are serialized', async () => {
      const svc = new SpaceRuntimeService(buildConfig(spaceManager));
      const calls: string[] = [];
      let releaseFirst!: () => void;
      const firstRecovery = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const runtime = (
        svc as unknown as {
          runtime: {
            recoverStalledRunsForSpace: (spaceId: string) => Promise<void>;
          };
        }
      ).runtime;
      runtime.recoverStalledRunsForSpace = async (spaceId: string) => {
        calls.push(`start:${spaceId}`);
        if (spaceId === 'space-1') await firstRecovery;
        calls.push(`finish:${spaceId}`);
      };

      svc.recoverStalledWorkflowRunsAfterSpaceResume('space-1');
      svc.recoverStalledWorkflowRunsAfterSpaceResume('space-2');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual(['start:space-1']);

      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual(['start:space-1', 'finish:space-1', 'start:space-2', 'finish:space-2']);
    });
  });

  describe('setupSpaceAgentSession()', () => {
    function makeSession() {
      return {
        setRuntimeMcpServers: mock(() => {}),
        mergeRuntimeMcpServers: mock(() => {}),
        setRuntimeSystemPrompt: mock(() => {}),
        updateConfig: mock(async () => {}),
        resetQuery: mock(async () => ({ success: true })),
        restart: mock(async () => {}),
        getSessionData: mock(() => ({ id: 'session-1', metadata: {}, config: {} }) as Session),
      } as unknown as AgentSession;
    }

    function makeSessionManager(session: AgentSession | null = makeSession()): SessionManager {
      return {
        getSessionAsync: mock(async () => session),
        createSession: mock(async () => 'space:chat:space-1'),
        listSessions: mock(() => [] as Session[]),
        registerSessionResetSubscriber: mock(() => () => {}),
      } as unknown as SessionManager;
    }

    function makeWorkflowManager(): SpaceWorkflowManager {
      return {
        listWorkflows: mock(() => []),
      } as unknown as SpaceWorkflowManager;
    }

    function makeAgentManager(): SpaceAgentManager {
      return {
        listBySpaceId: mock(() => []),
      } as unknown as SpaceAgentManager;
    }

    function buildConfigWithSession(
      sessionManager: SessionManager,
      spaceManager: SpaceManager = createMockSpaceManager(),
      internalEventBus?: SpaceRuntimeServiceConfig['internalEventBus']
    ): SpaceRuntimeServiceConfig {
      return {
        db: {} as BunDatabase,
        spaceManager,
        spaceAgentManager: makeAgentManager(),
        spaceWorkflowManager: makeWorkflowManager(),
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
        internalEventBus,
      };
    }

    async function buildDurableDeliveryReactiveDb(): Promise<{
      reactiveDb: SpaceRuntimeServiceConfig['reactiveDb'];
      saveUserMessage: ReturnType<typeof mock>;
      db: StorageDatabase;
    }> {
      const db = await createTestDb();
      const reactiveDb = { db } as unknown as SpaceRuntimeServiceConfig['reactiveDb'];
      return { reactiveDb, saveUserMessage: mock(() => 'db-msg'), db };
    }

    function seedSessionForDelivery(db: StorageDatabase, sessionId: string): void {
      const session = createTestSession(sessionId);
      session.type = 'space_chat';
      db.createSession(session);
    }

    test('attaches MCP server and system prompt to the space:chat session (merge, not replace)', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

      await svc.setupSpaceAgentSession(mockSpace);

      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith(`space:chat:${mockSpace.id}`);
      expect(session.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      expect(session.setRuntimeMcpServers).not.toHaveBeenCalled();
      const [mcpArg] = (
        session.mergeRuntimeMcpServers as Mock<typeof session.mergeRuntimeMcpServers>
      ).mock.calls[0];
      expect(mcpArg).toHaveProperty('space-agent-tools');
      expect(typeof session.onMissingSpaceChatMcpServers).toBe('function');

      expect(session.setRuntimeSystemPrompt).toHaveBeenCalledTimes(1);
      const [promptArg] = (
        session.setRuntimeSystemPrompt as Mock<typeof session.setRuntimeSystemPrompt>
      ).mock.calls[0];
      expect(typeof promptArg).toBe('string');
      expect(promptArg.length).toBeGreaterThan(0);
    });

    describe('space-actions dispatcher attach (HYPERNEO_SPACE_ACTIONS_DISPATCHER)', () => {
      const FLAG = 'HYPERNEO_SPACE_ACTIONS_DISPATCHER';
      const previous = process.env[FLAG];
      afterEach(() => {
        if (previous === undefined) delete process.env[FLAG];
        else process.env[FLAG] = previous;
      });

      test('coordinator: attaches space-actions by default; omits it when the flag is off', async () => {
        const session = makeSession();
        const sessionManager = makeSessionManager(session);
        const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

        process.env[FLAG] = '0';
        await svc.setupSpaceAgentSession(mockSpace);
        delete process.env[FLAG];
        await svc.setupSpaceAgentSession(mockSpace);

        const mergeMock = session.mergeRuntimeMcpServers as Mock<
          typeof session.mergeRuntimeMcpServers
        >;
        const [firstArg] = mergeMock.mock.calls[0];
        expect(firstArg).toHaveProperty('space-agent-tools');
        expect(firstArg).not.toHaveProperty('space-actions');
        const [secondArg] = mergeMock.mock.calls[1];
        expect(secondArg).toHaveProperty('space-agent-tools');
        expect(secondArg).toHaveProperty('space-actions');
      });
    });

    test('provisions the coordinator space:chat session with the 24-tool sdkToolsPreset (Task #794)', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

      await svc.setupSpaceAgentSession(mockSpace);

      expect(session.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          sdkToolsPreset: [...LONG_HORIZON_AGENT_BUILTIN_TOOLS],
        })
      );
    });

    test('does not rewrite sdkToolsPreset when the coordinator preset is already set (idempotent)', async () => {
      const session = makeSession();
      (session.getSessionData as Mock<typeof session.getSessionData>).mockReturnValue({
        id: 'session-1',
        metadata: {},
        config: { sdkToolsPreset: [...LONG_HORIZON_AGENT_BUILTIN_TOOLS] },
      } as Session);
      const sessionManager = makeSessionManager(session);
      const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

      await svc.setupSpaceAgentSession(mockSpace);

      expect(session.updateConfig).not.toHaveBeenCalled();
    });

    test('missing Space chat MCP callback re-runs setup and re-attaches tools', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

      await svc.setupSpaceAgentSession(mockSpace);
      expect(session.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      expect(typeof session.onMissingSpaceChatMcpServers).toBe('function');

      await session.onMissingSpaceChatMcpServers?.('space:chat:space-1', ['space-agent-tools']);

      expect(sessionManager.getSessionAsync).toHaveBeenCalledTimes(2);
      expect(session.mergeRuntimeMcpServers).toHaveBeenCalledTimes(2);
      const [repairedMcpArg] = (
        session.mergeRuntimeMcpServers as Mock<typeof session.mergeRuntimeMcpServers>
      ).mock.calls[1];
      expect(repairedMcpArg).toHaveProperty('space-agent-tools');
    });

    test('no-op when session does not exist in DB', async () => {
      const sessionManager = makeSessionManager(null);
      const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

      await expect(svc.setupSpaceAgentSession(mockSpace)).resolves.toBeUndefined();
    });

    test('no-op when sessionManager is not configured', async () => {
      const svc = new SpaceRuntimeService(buildConfig(createMockSpaceManager()));

      await expect(svc.setupSpaceAgentSession(mockSpace)).resolves.toBeUndefined();
    });

    test('flushes pending Space Agent messages for active runs after provisioning', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);

      const activeRun = { id: 'run-flush-wiring', status: 'in_progress', spaceId: mockSpace.id };
      const workflowRunRepo = {
        getActiveRuns: mock(() => [activeRun]),
      } as unknown as SpaceWorkflowRunRepository;

      const flushCalls: Array<{ spaceId: string; runId: string }> = [];
      const mockTaskAgentManager = {
        flushPendingMessagesForSpaceAgent: mock(async (spaceId: string, runId: string) => {
          flushCalls.push({ spaceId, runId });
        }),
      } as unknown as TaskAgentManager;

      const config: SpaceRuntimeServiceConfig = {
        ...buildConfigWithSession(sessionManager),
        workflowRunRepo,
      };
      const svc = new SpaceRuntimeService(config);
      svc.setTaskAgentManager(mockTaskAgentManager);

      await svc.setupSpaceAgentSession(mockSpace);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(flushCalls).toHaveLength(1);
      expect(flushCalls[0]).toEqual({ spaceId: mockSpace.id, runId: activeRun.id });
    });

    test('start() provisions existing spaces', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      const spaceMgr: SpaceManager = {
        getSpace: mock(async () => mockSpace),
        listSpaces: mock(async () => [mockSpace]),
      } as unknown as SpaceManager;
      const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager, spaceMgr));

      svc.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(spaceMgr.listSpaces).toHaveBeenCalled();
      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith(`space:chat:${mockSpace.id}`);

      await svc.stop();
    });

    test('start() subscribes to space.created events when internalEventBus provided', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      const internalEventBus = {
        subscribe: mock(() => () => {}),
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['internalEventBus'];
      const config: SpaceRuntimeServiceConfig = {
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(), internalEventBus),
      };
      const svc = new SpaceRuntimeService(config);

      svc.start();

      const onCalls = (internalEventBus.subscribe as Mock<typeof internalEventBus.subscribe>).mock
        .calls;
      const spaceCreatedCall = onCalls.find(([event]) => event === 'space.created');
      expect(spaceCreatedCall).toBeDefined();

      await svc.stop();
    });

    test('session.reset re-provisions reset Space chats before query replay', async () => {
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      let resetHandler:
        | ((event: { sessionId: string; session: Session; restartQuery: boolean }) => Promise<void>)
        | undefined;
      const sessionManagerWithSubscriber = {
        ...sessionManager,
        registerSessionResetSubscriber: mock((handler: typeof resetHandler) => {
          resetHandler = handler;
          return () => {};
        }),
      } as unknown as SessionManager;
      const internalEventBus = {
        subscribe: mock(() => () => {}),
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['internalEventBus'];
      const config: SpaceRuntimeServiceConfig = {
        ...buildConfigWithSession(
          sessionManagerWithSubscriber,
          createMockSpaceManager(),
          internalEventBus
        ),
      };
      const svc = new SpaceRuntimeService(config);

      svc.start();
      expect(resetHandler).toBeDefined();

      await resetHandler?.({
        sessionId: 'space:chat:space-1',
        session: {
          id: 'space:chat:space-1',
          type: 'space_chat',
          context: { spaceId: 'space-1' },
        } as Session,
        restartQuery: true,
      });

      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith('space:chat:space-1');
      expect(session.mergeRuntimeMcpServers).toHaveBeenCalled();
      const [mcpArg] = (
        session.mergeRuntimeMcpServers as Mock<typeof session.mergeRuntimeMcpServers>
      ).mock.calls.at(-1)!;
      expect(mcpArg).toHaveProperty('space-agent-tools');
      expect(typeof session.onMissingSpaceChatMcpServers).toBe('function');
      expect(session.setRuntimeSystemPrompt).toHaveBeenCalled();

      await svc.stop();
    });

    test('long-horizon delivery starts inactive session without worker inbox', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({
          id: sessionId,
          metadata: {},
          config: {},
        })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const inboxRepo = { enqueue: mock(() => ({ record: { id: 'queued-1' }, deduped: false })) };
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'mcp-agent',
          displayName: 'MCP Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: 'Do work.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
        getCoordinator: mock(() => null),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      const delivery = svc.longTermAgentDeliveryCallbacks();
      const deliveredSessionId = await delivery?.queueForActivation(
        {
          actorId: 'agent:lh-agent-1',
          kind: 'agent',
          spaceId: mockSpace.id,
          status: 'inactive',
        } as ActorRef,
        {
          messageId: 'message-1',
          spaceId: mockSpace.id,
          senderActorId: 'space:space-1:human:user-1',
          kind: 'message',
          body: 'hello',
          createdAt: Date.now(),
        } as MessageRecord
      );

      expect(deliveredSessionId).toBe(sessionId);
      expect(inboxRepo.enqueue).not.toHaveBeenCalled();
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'message-1')?.sendStatus).toBe(
        'enqueued'
      );
      db.close();
    });

    test('long-term Space agent sessions use the agent name as title', async () => {
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({
          id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
          metadata: {},
          config: {},
        })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => longTermAgentSessionId(mockSpace.id, 'agent-1'));
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const spaceManager = createMockSpaceManager(mockSpace);
      const spaceAgentManager = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'agent-1',
          spaceId: mockSpace.id,
          name: 'Researcher',
          customPrompt: null,
        })),
        listBySpaceId: mock(() => []),
      } as unknown as SpaceAgentManager;
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, longTermAgentSessionId(mockSpace.id, 'agent-1'));
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, spaceManager),
        reactiveDb,
        spaceAgentManager,
        spaceAgentInboxRepo: {} as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      const delivery = svc.longTermAgentDeliveryCallbacks();
      await delivery?.deliverToSession(
        {
          actorId: 'agent:agent-1',
          kind: 'agent',
          spaceId: mockSpace.id,
          status: 'active',
        } as ActorRef,
        {
          messageId: 'message-1',
          spaceId: mockSpace.id,
          senderActorId: 'space:space-1:human:user-1',
          kind: 'message',
          body: 'hello',
          createdAt: Date.now(),
        } as MessageRecord
      );

      expect(sessionManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Researcher' })
      );
      db.close();
    });

    test('long-horizon event sessions preserve converted agent tool restrictions', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({
          id: sessionId,
          metadata: {},
          config: {},
        })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'restricted-agent',
          displayName: 'Restricted Agent',
          templateKey: 'migration.legacy_space_agent',
          status: 'active',
          sessionId: null,
          instructions: 'Use limited tools.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: 'openrouter',
          settingSources: ['project'],
          toolPermissions: { tools: ['Read', 'Edit'] },
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
        getCoordinator: mock(() => null),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      const result = await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-1',
      });

      expect(result).toEqual({ delivered: true });
      expect(sessionManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            provider: 'openrouter',
            settingSources: ['project'],
            disallowedTools: ['Bash', 'Write', 'MultiEdit', 'NotebookEdit'],
            agent: 'restricted-agent',
            agents: {
              'restricted-agent': expect.objectContaining({
                disallowedTools: ['Bash', 'Write', 'MultiEdit', 'NotebookEdit'],
                prompt: 'Use limited tools.',
              }),
            },
          }),
        })
      );
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')?.sendStatus).toBe(
        'enqueued'
      );
      db.close();
    });

    test('deliverLongHorizonAgentNag reports consumed when the nag is consumed', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'lh-agent-1',
          displayName: 'LH Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: '',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: ['project'],
          toolPermissions: { tools: [] },
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
        getCoordinator: mock(() => null),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });
      const result = await svc.deliverLongHorizonAgentNag({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'You have been idle.',
        idempotencyKey: 'inactivity-nag:lh-agent-1:100:0',
      });
      expect(result).toBe('accepted');
      expect(
        db.getSDKMessageRepo().getDeliveryContent(sessionId, 'inactivity-nag:lh-agent-1:100:0')
          ?.sendStatus
      ).toBe('enqueued');
      db.close();
    });

    test('deliverLongHorizonAgentNag returns pre_admission_failure for an inactive agent', async () => {
      const sessionManager = makeSessionManager(null);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          status: 'paused',
          sessionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        longHorizonAgentRepo,
      });
      const result = await svc.deliverLongHorizonAgentNag({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'nag',
        idempotencyKey: 'k',
      });
      expect(result).toBe('pre_admission_failure');
    });

    test('deliverLongHorizonAgentNag returns pre_admission_failure when the space is not wakeable', async () => {
      const sessionManager = makeSessionManager(null);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          status: 'active',
          sessionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(
          sessionManager,
          createMockSpaceManager({ ...mockSpace, paused: true })
        ),
        longHorizonAgentRepo,
      });
      const result = await svc.deliverLongHorizonAgentNag({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'nag',
        idempotencyKey: 'k',
      });
      expect(result).toBe('pre_admission_failure');
    });

    test('deliverLongHorizonAgentNag returns pre_admission_failure when the config revision moved on', async () => {
      const sessionManager = makeSessionManager(null);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          status: 'active',
          sessionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const inactivityConfigRepo = {
        getByAgent: mock(() => ({ enabled: true, configRevision: 2 })),
      } as unknown as SpaceRuntimeServiceConfig['inactivityConfigRepo'];
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        longHorizonAgentRepo,
        inactivityConfigRepo,
      });
      const result = await svc.deliverLongHorizonAgentNag({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'nag',
        idempotencyKey: 'k',
        expectedConfigRevision: 1,
      });
      expect(result).toBe('pre_admission_failure');
    });

    test('deliverLongHorizonAgentNag revalidates the config revision after session resolution', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'lh-agent-1',
          displayName: 'LH Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: '',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: ['project'],
          toolPermissions: { tools: [] },
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
        getCoordinator: mock(() => null),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      let configCalls = 0;
      const inactivityConfigRepo = {
        getByAgent: mock(() => {
          configCalls += 1;
          return { enabled: true, configRevision: configCalls === 1 ? 1 : 2 };
        }),
      } as unknown as SpaceRuntimeServiceConfig['inactivityConfigRepo'];
      const { reactiveDb } = await buildDurableDeliveryReactiveDb();
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
        inactivityConfigRepo,
      });
      const result = await svc.deliverLongHorizonAgentNag({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'nag',
        idempotencyKey: 'k',
        expectedConfigRevision: 1,
      });
      expect(result).toBe('pre_admission_failure');
      expect(configCalls).toBeGreaterThanOrEqual(2);
    });

    test('long-horizon event sessions forward scoped Bash entries so the scope hook installs', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({
          id: sessionId,
          metadata: {},
          config: {},
        })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'scoped-agent',
          displayName: 'Scoped Agent',
          templateKey: 'migration.legacy_space_agent',
          status: 'active',
          sessionId: null,
          instructions: 'Read-only gh inspection only.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: { tools: ['Read', 'Bash(gh pr view:*)', 'Bash(jq:*)'] },
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      const result = await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-1',
      });

      expect(result).toEqual({ delivered: true });
      expect(sessionManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            allowedTools: ['Bash(gh pr view:*)', 'Bash(jq:*)'],
            disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
          }),
        })
      );
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')?.sendStatus).toBe(
        'enqueued'
      );
      db.close();
    });

    test('long-horizon event sessions leave model unset for custom provider defaults', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({
          id: sessionId,
          metadata: {},
          config: {},
        })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'provider-default-agent',
          displayName: 'Provider Default Agent',
          templateKey: 'migration.legacy_space_agent',
          status: 'active',
          sessionId: null,
          instructions: 'Use provider defaults.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: 'openrouter',
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-1',
      });

      const createSessionArg = (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mock.calls[0]![0] as { config: Partial<Session['config']> };
      expect(createSessionArg.config.provider).toBe('openrouter');
      expect(createSessionArg.config.model).toBeUndefined();
      expect(createSessionArg.config.sdkToolsPreset).toEqual([...LONG_HORIZON_AGENT_BUILTIN_TOOLS]);
      expect(createSessionArg.config.sdkToolsPreset).not.toEqual(
        expect.objectContaining({ type: 'preset' })
      );
      db.close();
    });

    test('long-horizon event sessions refresh existing config before delivery', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const sessionData = {
        id: sessionId,
        metadata: {},
        config: {
          model: 'claude-old',
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: 'Old instructions.',
          },
          sdkToolsPreset: ['Read'],
          allowedTools: ['Read'],
          disallowedTools: ['Edit'],
        },
      } as Session;
      const existingSession = {
        ...makeSession(),
        getSessionData: mock(() => sessionData),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(existingSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'restricted-agent',
          displayName: 'Restricted Agent',
          templateKey: 'migration.legacy_space_agent',
          status: 'active',
          sessionId,
          instructions: 'Use updated tools.',
          autonomyLevel: null,
          model: 'claude-new',
          thinkingLevel: null,
          provider: 'openrouter',
          settingSources: ['project'],
          toolPermissions: { tools: ['Read', 'Edit'] },
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      const result = await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-1',
      });

      expect(result).toEqual({ delivered: true });
      expect(existingSession.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-new',
          provider: 'openrouter',
          settingSources: ['project'],
          systemPrompt: expect.objectContaining({
            append: expect.stringContaining('Use updated tools.'),
          }),
          sdkToolsPreset: [...LONG_HORIZON_AGENT_BUILTIN_TOOLS],
          disallowedTools: ['Bash', 'Write', 'MultiEdit', 'NotebookEdit'],
          agent: 'restricted-agent',
          agents: {
            'restricted-agent': expect.objectContaining({
              disallowedTools: ['Bash', 'Write', 'MultiEdit', 'NotebookEdit'],
              prompt: 'Use updated tools.',
            }),
          },
        })
      );
      expect(existingSession.resetQuery).toHaveBeenCalledWith({ restartQuery: false });
      expect(existingSession.restart).toHaveBeenCalledWith(
        expect.objectContaining({ beforeStart: expect.any(Function) })
      );
      const updateCall = (existingSession.updateConfig as Mock).mock.calls[0]![0] as {
        systemPrompt: { append: string };
      };
      expect(updateCall.systemPrompt.append).toContain('Use updated tools.');
      expect(updateCall.systemPrompt.append).toContain(LONG_HORIZON_SCHEDULING_GUARDRAIL);
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')?.sendStatus).toBe(
        'enqueued'
      );
      db.close();
    });

    test('long-horizon delivery terminalizes the persisted row if durable enqueue throws', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'mcp-agent',
          displayName: 'MCP Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: 'Do work.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];

      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();

      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      await expect(
        (
          svc as unknown as {
            deliverLongHorizonExternalEvent(args: {
              spaceId: string;
              agentId: string;
              message: string;
              idempotencyKey: string;
            }): Promise<{ delivered: boolean }>;
          }
        ).deliverLongHorizonExternalEvent({
          spaceId: mockSpace.id,
          agentId: 'lh-agent-1',
          message: 'event payload',
          idempotencyKey: 'delivery-1',
        })
      ).rejects.toThrow();

      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')).toBeNull();
      db.close();
    });

    test('long-horizon crash-retry does not re-save or re-drive a terminal message', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'mcp-agent',
          displayName: 'MCP Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: 'Do work.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];

      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      db.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: 'delivery-1',
          session_id: sessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
          message: { role: 'user', content: [{ type: 'text', text: 'event payload' }] },
        },
        'enqueued'
      );
      db.getSDKMessageRepo().markDeliveryConsumedByUuid(sessionId, 'delivery-1');

      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      const result = await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-1',
      });

      expect(result).toEqual({ delivered: true });
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')?.sendStatus).toBe(
        'consumed'
      );
      const job = db
        .getDatabase()
        .prepare(
          `SELECT id FROM job_queue WHERE queue = 'message_delivery'
             AND json_extract(payload, '$.messageUuid') = 'delivery-1'`
        )
        .get();
      expect(job).toBeNull();
      db.close();
    });

    test('long-horizon crash-retry rejects a consumed id reused with different content', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'mcp-agent',
          displayName: 'MCP Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: 'Do work.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      db.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: 'delivery-1',
          session_id: sessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
          message: { role: 'user', content: [{ type: 'text', text: 'original payload' }] },
        },
        'enqueued'
      );
      db.getSDKMessageRepo().markDeliveryConsumedByUuid(sessionId, 'delivery-1');

      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      await expect(
        (
          svc as unknown as {
            deliverLongHorizonExternalEvent(args: {
              spaceId: string;
              agentId: string;
              message: string;
              idempotencyKey: string;
            }): Promise<{ delivered: boolean }>;
          }
        ).deliverLongHorizonExternalEvent({
          spaceId: mockSpace.id,
          agentId: 'lh-agent-1',
          message: 'conflicting payload',
          idempotencyKey: 'delivery-1',
        })
      ).rejects.toThrow('different content');
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')?.sendStatus).toBe(
        'consumed'
      );
      db.close();
    });

    test('long-horizon crash-retry reopens a failed row and re-enqueues it', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'mcp-agent',
          displayName: 'MCP Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: 'Do work.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];

      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      db.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: 'delivery-1',
          session_id: sessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
          message: { role: 'user', content: [{ type: 'text', text: 'event payload' }] },
        },
        'enqueued'
      );
      db.getSDKMessageRepo().markDeliveryFailedByUuid(sessionId, 'delivery-1');

      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      const result = await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-1',
      });

      expect(result).toEqual({ delivered: true });
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-1')?.sendStatus).toBe(
        'enqueued'
      );
      const job = db
        .getDatabase()
        .prepare(
          `SELECT id FROM job_queue WHERE queue = 'message_delivery'
             AND json_extract(payload, '$.messageUuid') = 'delivery-1'`
        )
        .get();
      expect(job).toBeDefined();
      db.close();
    });

    test('long-horizon delivery not consumed within the timeout rejects — no premature delivered (Codex P1)', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'lh-agent-1');
      const createdSession = {
        ...makeSession(),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} })),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
      const sessionManager = makeSessionManager(null);
      (
        sessionManager.createSession as Mock<typeof sessionManager.createSession>
      ).mockImplementation(async () => sessionId);
      (sessionManager.getSessionAsync as Mock<typeof sessionManager.getSessionAsync>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdSession);
      const longHorizonAgentRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({
          id: 'lh-agent-1',
          spaceId: mockSpace.id,
          handle: 'mcp-agent',
          displayName: 'MCP Agent',
          templateKey: null,
          status: 'active',
          sessionId: null,
          instructions: 'Do work.',
          autonomyLevel: null,
          model: null,
          thinkingLevel: null,
          provider: null,
          settingSources: null,
          toolPermissions: {},
          createdAt: NOW,
          updatedAt: NOW,
        })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const svc = new SpaceRuntimeService({
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(mockSpace)),
        reactiveDb,
        longHorizonAgentRepo,
      });

      const result = await (
        svc as unknown as {
          deliverLongHorizonExternalEvent(args: {
            spaceId: string;
            agentId: string;
            message: string;
            idempotencyKey: string;
          }): Promise<{ delivered: boolean }>;
        }
      ).deliverLongHorizonExternalEvent({
        spaceId: mockSpace.id,
        agentId: 'lh-agent-1',
        message: 'event payload',
        idempotencyKey: 'delivery-timeout',
      });

      expect(result).toEqual({ delivered: true });
      expect(
        db.getSDKMessageRepo().getDeliveryContent(sessionId, 'delivery-timeout')?.sendStatus
      ).toBe('enqueued');
      db.close();
    });

    test('session.reset re-provisions reset long-term Space agents before query replay', async () => {
      const agentSession = makeSession();
      const sessionManager = makeSessionManager(agentSession);
      let resetHandler:
        | ((event: { sessionId: string; session: Session; restartQuery: boolean }) => Promise<void>)
        | undefined;
      const sessionManagerWithSubscriber = {
        ...sessionManager,
        registerSessionResetSubscriber: mock((handler: typeof resetHandler) => {
          resetHandler = handler;
          return () => {};
        }),
      } as unknown as SessionManager;
      const internalEventBus = {
        subscribe: mock(() => () => {}),
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['internalEventBus'];
      const config: SpaceRuntimeServiceConfig = {
        ...buildConfigWithSession(
          sessionManagerWithSubscriber,
          createMockSpaceManager(),
          internalEventBus
        ),
      };
      const svc = new SpaceRuntimeService(config);
      const longTermSessionId = longTermAgentSessionId(mockSpace.id, 'agent-1');

      svc.start();
      expect(resetHandler).toBeDefined();

      await resetHandler?.({
        sessionId: longTermSessionId,
        session: {
          id: longTermSessionId,
          type: 'worker',
          context: { spaceId: mockSpace.id },
          metadata: {
            promptProvenance: {
              source: 'test',
              hash: 'hash',
              agentId: 'agent-1',
              agentName: 'Long Term',
            },
          },
        } as Session,
        restartQuery: true,
      });

      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith(longTermSessionId);
      expect(agentSession.mergeRuntimeMcpServers).toHaveBeenCalled();
      const [mcpArg] = (
        agentSession.mergeRuntimeMcpServers as Mock<typeof agentSession.mergeRuntimeMcpServers>
      ).mock.calls.at(-1)!;
      expect(mcpArg).toHaveProperty('space-agent-tools');
      expect(typeof agentSession.onMissingMemberSpaceMcpServers).toBe('function');

      await svc.stop();
    });

    test('stop() unsubscribes from space.created events', async () => {
      const unsubFn = mock(() => {});
      const session = makeSession();
      const sessionManager = makeSessionManager(session);
      const internalEventBus = {
        subscribe: mock(() => unsubFn as unknown as () => void),
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['internalEventBus'];
      const config: SpaceRuntimeServiceConfig = {
        ...buildConfigWithSession(sessionManager, createMockSpaceManager(), internalEventBus),
      };
      const svc = new SpaceRuntimeService(config);

      svc.start();
      await svc.stop();

      expect(unsubFn).toHaveBeenCalledTimes(10);
    });
  });

  describe('deliverGoalOutcomeWake()', () => {
    const notification: SpaceGoalOutcomeNotification = {
      id: 'notif-1',
      spaceId: mockSpace.id,
      goalId: 'goal-1',
      taskId: 'task-1',
      terminalGeneration: 1,
      goalRevision: 1,
      status: 'pending',
      payload: {
        summary: '',
        taskStatus: 'done',
        taskTitle: 'Task 1',
        goalTitle: 'Goal 1',
      },
      createdAt: NOW,
      updatedAt: NOW,
    };

    test('does not resolve an owner while goal outcome wakes are gated', async () => {
      const longHorizonAgentRepo = {
        getPrimaryGoalOwner: mock(() => null),
      } as unknown as SpaceLongHorizonAgentRepository;
      const goalService = {
        getGoal: mock(() => ({ id: notification.goalId, spaceId: notification.spaceId })),
      } as unknown as SpaceRuntimeServiceConfig['goalService'];
      const outcomeNotificationRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({ status: 'pending' })),
      } as unknown as SpaceGoalOutcomeNotificationRepository;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        longHorizonAgentRepo,
        goalService,
        outcomeNotificationRepo,
      });

      await svc.deliverGoalOutcomeWake(notification);

      expect(longHorizonAgentRepo.getPrimaryGoalOwner).not.toHaveBeenCalled();
    });

    test('resolves the owner when goal outcome wakes are enabled', async () => {
      const longHorizonAgentRepo = {
        getPrimaryGoalOwner: mock(() => ({ action: 'degraded' })),
        ensureCoordinator: mock(() => ({ id: 'coordinator-1' })),
        getById: mock(() => null),
      } as unknown as SpaceLongHorizonAgentRepository;
      const goalService = {
        getGoal: mock(() => ({ id: notification.goalId, spaceId: notification.spaceId })),
      } as unknown as SpaceRuntimeServiceConfig['goalService'];
      const outcomeNotificationRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => ({ status: 'pending' })),
      } as unknown as SpaceGoalOutcomeNotificationRepository;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        enableGoalOutcomeWake: true,
        longHorizonAgentRepo,
        goalService,
        outcomeNotificationRepo,
      });

      await svc.deliverGoalOutcomeWake(notification);

      expect(longHorizonAgentRepo.getPrimaryGoalOwner).toHaveBeenCalledWith(
        notification.goalId,
        notification.spaceId
      );
      expect(longHorizonAgentRepo.ensureCoordinator).toHaveBeenCalledWith(notification.spaceId);
    });

    test('routes a no-recipient wake to the coordinator', async () => {
      const longHorizonAgentRepo = {
        getPrimaryGoalOwner: mock(() => ({ action: 'no_recipient' })),
        ensureCoordinator: mock(() => ({ id: 'coordinator-1' })),
        getById: mock(() => null),
      } as unknown as SpaceLongHorizonAgentRepository;
      const goalService = {
        getGoal: mock(() => ({ id: notification.goalId, spaceId: notification.spaceId })),
      } as unknown as SpaceRuntimeServiceConfig['goalService'];
      const outcomeNotificationRepo = {
        getById: mock(() => ({ status: 'pending' })),
      } as unknown as SpaceGoalOutcomeNotificationRepository;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        enableGoalOutcomeWake: true,
        longHorizonAgentRepo,
        goalService,
        outcomeNotificationRepo,
      });

      await svc.deliverGoalOutcomeWake(notification);

      expect(longHorizonAgentRepo.ensureCoordinator).toHaveBeenCalledWith(notification.spaceId);
    });

    test('routes a noncanonical handle-coordinator wake to the Space chat session', async () => {
      const sessions = new Map<string, AgentSession>();
      sessions.set(`space:chat:${mockSpace.id}`, makeWakeSession(`space:chat:${mockSpace.id}`));
      const sessionManager = makeWakeSessionManager(sessions);
      const inboxRepo = { enqueue: mock(() => ({ record: { id: 'queued-1' }, deduped: false })) };
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, `space:chat:${mockSpace.id}`);
      const longHorizonAgentRepo = {
        getPrimaryGoalOwner: mock(() => ({ action: 'no_recipient' })),
        ensureCoordinator: mock(() => ({ id: 'coordinator-alt' })),
        getCoordinator: mock(() => ({ id: 'coordinator-alt' })),
        getById: mock(() =>
          buildLongHorizonAgent({ id: 'coordinator-alt', handle: 'coordinator' })
        ),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const goalService = {
        getGoal: mock(() => ({ id: notification.goalId, spaceId: notification.spaceId })),
      } as unknown as SpaceRuntimeServiceConfig['goalService'];
      const outcomeNotificationRepo = {
        getById: mock(() => ({
          id: notification.id,
          goalId: notification.goalId,
          spaceId: notification.spaceId,
          status: 'pending',
        })),
      } as unknown as SpaceGoalOutcomeNotificationRepository;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        sessionManager,
        enableGoalOutcomeWake: true,
        reactiveDb,
        longHorizonAgentRepo,
        goalService,
        outcomeNotificationRepo,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      await svc.deliverGoalOutcomeWake(notification);

      expect(
        db
          .getSDKMessageRepo()
          .getDeliveryContent(`space:chat:${mockSpace.id}`, 'goal-outcome:notif-1')?.sendStatus
      ).toBe('enqueued');
      expect(inboxRepo.enqueue).not.toHaveBeenCalled();
      db.close();
    });

    function makeWakeSession(sessionId: string): AgentSession {
      return {
        setRuntimeMcpServers: mock(() => {}),
        mergeRuntimeMcpServers: mock(() => {}),
        setRuntimeSystemPrompt: mock(() => {}),
        updateConfig: mock(async () => {}),
        resetQuery: mock(async () => ({ success: true })),
        getSessionData: mock(() => ({ id: sessionId, metadata: {}, config: {} }) as Session),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      } as unknown as AgentSession;
    }

    function makeWakeSessionManager(
      sessions: Map<string, AgentSession>,
      createdIds?: string[]
    ): SessionManager {
      return {
        getSessionAsync: mock(async (sessionId: string) => sessions.get(sessionId) ?? null),
        createSession: mock(async (...args: unknown[]) => {
          const sessionId =
            (args[0] as { sessionId?: string })?.sessionId ?? createdIds?.shift() ?? 'session-1';
          sessions.set(sessionId, makeWakeSession(sessionId));
          return sessionId;
        }),
        listSessions: mock(() => [] as Session[]),
        registerSessionResetSubscriber: mock(() => () => {}),
      } as unknown as SessionManager;
    }

    async function buildDurableDeliveryReactiveDb(): Promise<{
      reactiveDb: SpaceRuntimeServiceConfig['reactiveDb'];
      saveUserMessage: ReturnType<typeof mock>;
      db: StorageDatabase;
    }> {
      const db = await createTestDb();
      const reactiveDb = { db } as unknown as SpaceRuntimeServiceConfig['reactiveDb'];
      return { reactiveDb, saveUserMessage: mock(() => 'db-msg'), db };
    }

    function seedSessionForDelivery(db: StorageDatabase, sessionId: string): void {
      const session = createTestSession(sessionId);
      session.type = 'space_chat';
      db.createSession(session);
    }

    test('reroutes a wake rejected mid-provisioning to the new owner', async () => {
      const ownerA = { action: 'resolved', owner: { agentId: 'agent-a' } };
      const ownerB = { action: 'resolved', owner: { agentId: 'agent-b' } };
      let ownerCalls = 0;
      const sessions = new Map<string, AgentSession>();
      const sessionManager = makeWakeSessionManager(sessions);
      const inboxRepo = { enqueue: mock(() => ({ record: { id: 'queued-1' }, deduped: false })) };
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, longTermAgentSessionId(mockSpace.id, 'agent-b'));
      const longHorizonAgentRepo = {
        getPrimaryGoalOwner: mock(() => {
          ownerCalls += 1;
          return ownerCalls >= 3 ? ownerB : ownerA;
        }),
        getCoordinator: mock(() => null),
        getById: mock((id: string) => buildLongHorizonAgent({ id, handle: id, displayName: id })),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const goalService = {
        getGoal: mock(() => ({ id: notification.goalId, spaceId: notification.spaceId })),
      } as unknown as SpaceRuntimeServiceConfig['goalService'];
      const outcomeNotificationRepo = {
        getById: mock(() => ({
          id: notification.id,
          goalId: notification.goalId,
          spaceId: notification.spaceId,
          status: 'pending',
        })),
      } as unknown as SpaceGoalOutcomeNotificationRepository;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        sessionManager,
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: {
          listWorkflows: mock(() => []),
        } as unknown as SpaceWorkflowManager,
        enableGoalOutcomeWake: true,
        reactiveDb,
        longHorizonAgentRepo,
        goalService,
        outcomeNotificationRepo,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      await svc.deliverGoalOutcomeWake(notification);

      expect(
        db
          .getSDKMessageRepo()
          .getDeliveryContent(
            longTermAgentSessionId(mockSpace.id, 'agent-b'),
            'goal-outcome:notif-1'
          )?.sendStatus
      ).toBe('enqueued');
      expect(inboxRepo.enqueue).not.toHaveBeenCalled();
      db.close();
    });

    test('leaves a wake pending without queueing when it goes stale mid-provisioning', async () => {
      let notificationCalls = 0;
      const sessions = new Map<string, AgentSession>();
      const sessionManager = makeWakeSessionManager(sessions, [
        longTermAgentSessionId(mockSpace.id, 'lh-agent-1'),
      ]);
      const inboxRepo = { enqueue: mock(() => ({ record: { id: 'queued-1' }, deduped: false })) };
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      const longHorizonAgentRepo = {
        getPrimaryGoalOwner: mock(() => ({
          action: 'resolved',
          owner: { agentId: 'lh-agent-1' },
        })),
        getCoordinator: mock(() => null),
        getById: mock(() => buildLongHorizonAgent()),
        update: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const goalService = {
        getGoal: mock(() => ({ id: notification.goalId, spaceId: notification.spaceId })),
      } as unknown as SpaceRuntimeServiceConfig['goalService'];
      const outcomeNotificationRepo = {
        getCoordinator: mock(() => null),
        getById: mock(() => {
          notificationCalls += 1;
          const status = notificationCalls >= 3 ? 'acknowledged' : 'pending';
          return {
            id: notification.id,
            goalId: notification.goalId,
            spaceId: notification.spaceId,
            status,
          };
        }),
      } as unknown as SpaceGoalOutcomeNotificationRepository;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        sessionManager,
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: {
          listWorkflows: mock(() => []),
        } as unknown as SpaceWorkflowManager,
        enableGoalOutcomeWake: true,
        reactiveDb,
        longHorizonAgentRepo,
        goalService,
        outcomeNotificationRepo,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      await svc.deliverGoalOutcomeWake(notification);

      expect(inboxRepo.enqueue).not.toHaveBeenCalled();
      expect(
        db
          .getSDKMessageRepo()
          .getDeliveryContent(
            longTermAgentSessionId(mockSpace.id, 'lh-agent-1'),
            'goal-outcome:notif-1'
          )
      ).toBeNull();
      db.close();
    });
  });

  describe('flushLongTermAgentInbox() — settles on the mailbox terminal outcome', () => {
    const agentId = 'agent-1';
    const sessionId = longTermAgentSessionId(mockSpace.id, agentId);

    interface FlushTargetSession {
      getSessionData(): Session;
      ensureQueryStarted(): Promise<void>;
      messageQueue: { enqueueWithId: (id: string, message: string) => Promise<void> };
    }

    interface MockedInboxRepo {
      expireStale: Mock<() => number>;
      listPendingForAgent: Mock<
        (spaceId: string, targetAgentId: string) => SpaceAgentInboxMessageRecord[]
      >;
      markDelivered: Mock<(id: string, sessionId: string) => void>;
      markAttemptFailed: Mock<(id: string, error: string) => SpaceAgentInboxMessageRecord | null>;
    }

    async function buildDurableDeliveryReactiveDb(): Promise<{
      reactiveDb: SpaceRuntimeServiceConfig['reactiveDb'];
      db: StorageDatabase;
    }> {
      const db = await createTestDb();
      return { reactiveDb: { db } as unknown as SpaceRuntimeServiceConfig['reactiveDb'], db };
    }

    function seedSessionForDelivery(db: StorageDatabase, sid: string): void {
      const session = createTestSession(sid);
      session.type = 'space_chat';
      db.createSession(session);
    }

    function makeInboxRow(overrides: Partial<SpaceAgentInboxMessageRecord> = {}) {
      return {
        id: 'inbox-1',
        spaceId: mockSpace.id,
        targetAgentId: agentId,
        sourceActorId: 'agent:worker-1',
        sourceSessionId: null,
        message: 'catch up on the rolling goal',
        messageRecordJson: null,
        idempotencyKey: 'wake-1',
        attempts: 0,
        maxAttempts: 5,
        lastAttemptAt: null,
        lastError: null,
        status: 'pending',
        deliveredAt: null,
        deliveredSessionId: null,
        expiresAt: NOW + 60_000,
        createdAt: NOW,
        ...overrides,
      } as SpaceAgentInboxMessageRecord;
    }

    function makeInboxRepo(rows: SpaceAgentInboxMessageRecord[]): MockedInboxRepo {
      return {
        expireStale: mock(() => 0),
        listPendingForAgent: mock(() => rows),
        markDelivered: mock(() => {}),
        markAttemptFailed: mock(() => null),
      };
    }

    function makeFlushSession(sid: string): FlushTargetSession {
      return {
        getSessionData: mock(() => ({ id: sid, metadata: {}, config: {} }) as Session),
        ensureQueryStarted: mock(async () => {}),
        messageQueue: { enqueueWithId: mock(async () => {}) },
      };
    }

    async function runFlush(
      svc: SpaceRuntimeService,
      session: FlushTargetSession = makeFlushSession(sessionId)
    ): Promise<void> {
      await (
        svc as unknown as {
          flushLongTermAgentInbox: (actor: ActorRef, session: FlushTargetSession) => Promise<void>;
        }
      ).flushLongTermAgentInbox(
        {
          actorId: `agent:${encodeActorIdComponent(agentId)}`,
          kind: 'agent',
          spaceId: mockSpace.id,
          roles: ['space-agent'],
          status: 'inactive',
        },
        session
      );
    }

    test('keeps the inbox row pending at acceptance and delivers it once the mailbox consumes', async () => {
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const inboxRepo = makeInboxRepo([makeInboxRow()]);
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        reactiveDb,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      await runFlush(svc);

      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'wake-1')?.sendStatus).toBe(
        'enqueued'
      );
      expect(inboxRepo.markDelivered).not.toHaveBeenCalled();
      expect(inboxRepo.markAttemptFailed).not.toHaveBeenCalled();

      const enqueued = db
        .getSDKMessageRepo()
        .getMessageByStatusAndUuid(sessionId, 'enqueued', 'wake-1');
      if (!enqueued) throw new Error('expected an enqueued SDK row for wake-1');
      db.getSDKMessageRepo().updateMessageStatus([enqueued.dbId], 'consumed');

      await runFlush(svc);

      expect(inboxRepo.markDelivered).toHaveBeenCalledTimes(1);
      expect(inboxRepo.markDelivered).toHaveBeenCalledWith('inbox-1', sessionId);
      expect(inboxRepo.markAttemptFailed).not.toHaveBeenCalled();
      db.close();
    });

    test('marks the inbox row attempt-failed when the mailbox row dead-letters', async () => {
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const inboxRepo = makeInboxRepo([makeInboxRow()]);
      const internalEventBus = {
        subscribe: mock(() => () => {}),
        publish: mock(async (_topic: string, payload: { messageIds: string[]; status: string }) => {
          if (payload.status === 'enqueued') {
            db.getSDKMessageRepo().updateMessageStatus(payload.messageIds, 'failed');
          }
        }),
      } as unknown as SpaceRuntimeServiceConfig['internalEventBus'];
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        reactiveDb,
        internalEventBus,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      await runFlush(svc);

      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, 'wake-1')?.sendStatus).toBe(
        'failed'
      );
      expect(inboxRepo.markDelivered).not.toHaveBeenCalled();
      expect(inboxRepo.markAttemptFailed).toHaveBeenCalledTimes(1);
      expect(inboxRepo.markAttemptFailed).toHaveBeenCalledWith(
        'inbox-1',
        expect.stringContaining('wake-1')
      );
      db.close();
    });

    test('treats a dead-lettered overwrite of a consumed row as delivered', async () => {
      const { reactiveDb, db } = await buildDurableDeliveryReactiveDb();
      seedSessionForDelivery(db, sessionId);
      const inboxRepo = makeInboxRepo([makeInboxRow()]);
      db.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: 'wake-1',
          session_id: sessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'catch up on the rolling goal' }],
          },
        },
        'enqueued'
      );
      const sdkRepo = db.getSDKMessageRepo();
      const enqueued = sdkRepo.getMessageByStatusAndUuid(sessionId, 'enqueued', 'wake-1');
      if (!enqueued) throw new Error('expected an enqueued SDK row for wake-1');
      sdkRepo.updateMessageStatus([enqueued.dbId], 'consumed');
      sdkRepo.updateMessageStatus([enqueued.dbId], 'failed');

      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager(mockSpace)),
        reactiveDb,
        spaceAgentInboxRepo:
          inboxRepo as unknown as SpaceRuntimeServiceConfig['spaceAgentInboxRepo'],
      });

      await runFlush(svc);

      expect(sdkRepo.hasConsumptionEvidence(sessionId, 'wake-1')).toBe(true);
      expect(inboxRepo.markDelivered).toHaveBeenCalledTimes(1);
      expect(inboxRepo.markDelivered).toHaveBeenCalledWith('inbox-1', sessionId);
      expect(inboxRepo.markAttemptFailed).not.toHaveBeenCalled();
      db.close();
    });
  });

  describe('attachSpaceToolsToMemberSession()', () => {
    function makeMemberAgentSession(overrides: Partial<Session> = {}) {
      const sessionData = makeMemberSession(overrides);
      return {
        mergeRuntimeMcpServers: mock((additional: Record<string, McpServerConfig>) => {
          sessionData.config.mcpServers = {
            ...(sessionData.config.mcpServers ?? {}),
            ...additional,
          };
        }),
        setRuntimeMcpServers: mock(() => {}),
        setRuntimeSystemPrompt: mock(() => {}),
        getSessionData: mock(() => sessionData),
      } as unknown as AgentSession;
    }

    function makeSessionManager(agent: AgentSession | null): SessionManager {
      return {
        getSessionAsync: mock(async () => agent),
        listSessions: mock(() => [] as Session[]),
      } as unknown as SessionManager;
    }

    function buildMemberConfig(opts: {
      sessionManager: SessionManager;
      listSessionsResult?: Session[];
      dbPath?: string;
      nodeExecutionRepo?: Pick<NodeExecutionRepository, 'getByAgentSessionId' | 'getById'>;
      actorRegistryRepos?: SpaceRuntimeServiceConfig['actorRegistryRepos'];
      longHorizonAgentRepo?: SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
    }): SpaceRuntimeServiceConfig {
      if (opts.listSessionsResult) {
        (opts.sessionManager as unknown as { listSessions: Mock<() => Session[]> }).listSessions =
          mock(() => opts.listSessionsResult as Session[]);
      }
      return {
        db: {} as BunDatabase,
        dbPath: opts.dbPath,
        spaceManager: createMockSpaceManager(mockSpace),
        spaceAgentManager: {
          listBySpaceId: mock(() => []),
        } as unknown as SpaceAgentManager,
        spaceWorkflowManager: {
          listWorkflows: mock(() => []),
        } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        tickIntervalMs: 60_000,
        sessionManager: opts.sessionManager,
        nodeExecutionRepo:
          (opts.nodeExecutionRepo as NodeExecutionRepository | undefined) ??
          makeNoopNodeExecutionRepo(),
        actorRegistryRepos: opts.actorRegistryRepos,
        longHorizonAgentRepo: opts.longHorizonAgentRepo,
      };
    }

    function insertSession(db: BunDatabase, session: Session): void {
      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata,
						is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id,
						sdk_origin_path, available_commands, processing_state, archived_at, type, session_context)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, null, null, null, null, null, null, null, null, null, ?, ?)`
      ).run(
        session.id,
        session.title,
        session.workspacePath,
        session.createdAt,
        session.lastActiveAt,
        session.status,
        JSON.stringify(session.config),
        JSON.stringify(session.metadata),
        session.type ?? 'worker',
        session.context ? JSON.stringify(session.context) : null
      );
    }

    function makeMemberSession(overrides: Partial<Session> = {}): Session {
      return {
        id: 'worker-session-1',
        title: 'Worker',
        workspacePath: '/tmp/ws',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: { tools: {} },
        metadata: {},
        type: 'worker',
        context: { spaceId: mockSpace.id },
        ...overrides,
      } as unknown as Session;
    }

    test('attaches space-agent-tools to an ad-hoc Space member session', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

      await svc.attachSpaceToolsToMemberSession(makeMemberSession());

      const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
      expect(mergeMock).toHaveBeenCalledTimes(1);
      const [additional] = mergeMock.mock.calls[0];
      expect(additional).toHaveProperty('space-agent-tools');
      expect(additional).not.toHaveProperty('db-query');
      expect(agent.setRuntimeSystemPrompt).not.toHaveBeenCalled();
    });

    describe('space-actions dispatcher attach (HYPERNEO_SPACE_ACTIONS_DISPATCHER)', () => {
      const FLAG = 'HYPERNEO_SPACE_ACTIONS_DISPATCHER';
      const previous = process.env[FLAG];
      afterEach(() => {
        if (previous === undefined) delete process.env[FLAG];
        else process.env[FLAG] = previous;
      });

      test('member session: attaches space-actions by default; omits it when the flag is off', async () => {
        const agent = makeMemberAgentSession();
        const sessionManager = makeSessionManager(agent);
        const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

        process.env[FLAG] = '0';
        await svc.attachSpaceToolsToMemberSession(makeMemberSession());
        delete process.env[FLAG];
        await svc.attachSpaceToolsToMemberSession(makeMemberSession());

        const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
        const [firstArg] = mergeMock.mock.calls[0];
        expect(firstArg).toHaveProperty('space-agent-tools');
        expect(firstArg).not.toHaveProperty('space-actions');
        const [secondArg] = mergeMock.mock.calls[1];
        expect(secondArg).toHaveProperty('space-agent-tools');
        expect(secondArg).toHaveProperty('space-actions');
      });

      test('long-term agent session: attaches space-actions alongside when the flag is on', async () => {
        process.env[FLAG] = '1';
        const agent = makeMemberAgentSession({
          id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
          metadata: {
            promptProvenance: {
              source: 'test',
              hash: 'hash',
              agentId: 'agent-1',
              agentName: 'Long Term',
            },
          },
        });
        const sessionManager = makeSessionManager(agent);
        const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

        await (
          svc as unknown as {
            attachLongTermAgentMcpServersForSession(session: Session): Promise<void>;
          }
        ).attachLongTermAgentMcpServersForSession(agent.getSessionData());

        const serverNames = Object.keys(agent.getSessionData().config.mcpServers ?? {});
        expect(serverNames).toContain('space-agent-tools');
        expect(serverNames).toContain('space-actions');
      });
    });

    test('re-attaches the slot context reset policy onto the fresh session instance', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));
      const reattachSlotContextReset = mock(() => {});
      svc.setTaskAgentManager({
        reattachSlotContextReset,
      } as unknown as TaskAgentManager);

      await svc.attachSpaceToolsToMemberSession(makeMemberSession());

      expect(reattachSlotContextReset).toHaveBeenCalledTimes(1);
      expect(reattachSlotContextReset).toHaveBeenCalledWith(agent);
    });

    test('also attaches db-query when dbPath is configured', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);

      const dir = join(
        process.cwd(),
        'tmp',
        'test-space-tools',
        `db-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, 'test.db');
      const tmpDb = new BunDatabase(dbPath);
      tmpDb.close();

      try {
        const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager, dbPath }));

        await svc.attachSpaceToolsToMemberSession(makeMemberSession());

        const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
        expect(mergeMock).toHaveBeenCalledTimes(1);
        const [additional] = mergeMock.mock.calls[0];
        expect(additional).toHaveProperty('space-agent-tools');
        expect(additional).toHaveProperty('db-query');

        await svc.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('skips sessions outside Space policy', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

      await svc.attachSpaceToolsToMemberSession(
        makeMemberSession({ context: { roomId: 'room-1' } })
      );

      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
    });

    test('skips space_chat sessions (handled by setupSpaceAgentSession)', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

      await svc.attachSpaceToolsToMemberSession(
        makeMemberSession({ type: 'space_chat', id: `space:chat:${mockSpace.id}` })
      );

      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
    });

    test('skips workflow workers identified by node execution ownership', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const workflowSession = makeMemberSession({ id: 'opaque-workflow-worker' });
      const nodeExecutionRepo = {
        getByAgentSessionId: mock((sessionId: string) =>
          sessionId === workflowSession.id ? { id: 'exec-1' } : null
        ),
      };
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager, nodeExecutionRepo }));

      await svc.attachSpaceToolsToMemberSession(workflowSession);

      expect(nodeExecutionRepo.getByAgentSessionId).toHaveBeenCalledWith(workflowSession.id);
      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
    });

    test('self-suppresses for a session that belongs to a long-horizon agent (first-activation race)', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const racedSession = makeMemberSession({ id: 'lh-session-race' });
      const longHorizonAgentRepo = {
        listBySpaceId: mock(() => [{ sessionId: racedSession.id, status: 'active' }]),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const svc = new SpaceRuntimeService(
        buildMemberConfig({ sessionManager, longHorizonAgentRepo })
      );

      await svc.attachSpaceToolsToMemberSession(racedSession);

      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
    });

    test('still attaches for a genuine ad-hoc member when no LH agent claims the session', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const longHorizonAgentRepo = {
        listBySpaceId: mock(() => [{ sessionId: 'some-other-session', status: 'active' }]),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const svc = new SpaceRuntimeService(
        buildMemberConfig({ sessionManager, longHorizonAgentRepo })
      );

      await svc.attachSpaceToolsToMemberSession(makeMemberSession({ id: 'real-member' }));

      expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
    });

    test('start() attaches tools to existing member and long-term agent sessions listed by sessionManager', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const longTermSession = makeMemberSession({
        id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
        metadata: {
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: 'agent-1',
            agentName: 'Long Term',
          },
        },
      });
      const listed: Session[] = [
        makeMemberSession({ id: 'member-1' }),
        makeMemberSession({ id: 'member-2' }),
        longTermSession,
        makeMemberSession({ id: 'no-space', context: {} }),
      ];
      const svc = new SpaceRuntimeService(
        buildMemberConfig({ sessionManager, listSessionsResult: listed })
      );

      svc.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
      expect(mergeMock).toHaveBeenCalledTimes(3);
      expect(mergeMock.mock.calls[2][0]).toHaveProperty('space-agent-tools');

      await svc.stop();
    });

    test('start() does not reattach already-provisioned long-term agent sessions', async () => {
      const agent = makeMemberAgentSession({
        config: {
          tools: {},
          mcpServers: {
            'space-agent-tools': {} as McpServerConfig,
          },
        },
      });
      const sessionManager = makeSessionManager(agent);
      const longTermSession = makeMemberSession({
        id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
        metadata: {
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: 'agent-1',
            agentName: 'Long Term',
          },
        },
      });
      const svc = new SpaceRuntimeService(
        buildMemberConfig({
          sessionManager,
          listSessionsResult: [longTermSession],
          dbPath: '/tmp/test.db',
        })
      );

      svc.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();

      await svc.stop();
    });

    test('session repository includes persisted Space sessions only when requested', () => {
      const db = new BunDatabase(':memory:');
      createTables(db);
      try {
        const repo = new SessionRepository(db);
        const memberSession = makeMemberSession({ id: 'member-1' });
        const longTermSession = makeMemberSession({
          id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
          metadata: {
            promptProvenance: {
              source: 'test',
              hash: 'hash',
              agentId: 'agent-1',
              agentName: 'Long Term',
            },
          },
        });
        const nonSpaceSession = makeMemberSession({ id: 'plain-worker', context: undefined });
        insertSession(db, memberSession);
        insertSession(db, longTermSession);
        insertSession(db, nonSpaceSession);

        expect(repo.listSessions({ includeArchived: false }).map((session) => session.id)).toEqual([
          'plain-worker',
        ]);
        expect(
          repo
            .listSessions({ includeArchived: false, includeSpaceSessions: true })
            .map((session) => session.id)
            .sort()
        ).toEqual([longTermSession.id, memberSession.id, 'plain-worker'].sort());
      } finally {
        db.close();
      }
    });

    test('start() requests persisted Space sessions during daemon-restart reattach sweep', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const longTermSession = makeMemberSession({
        id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
        metadata: {
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: 'agent-1',
            agentName: 'Long Term',
          },
        },
      });
      const svc = new SpaceRuntimeService(
        buildMemberConfig({ sessionManager, listSessionsResult: [longTermSession] })
      );

      svc.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(sessionManager.listSessions).toHaveBeenCalledWith({
        includeArchived: false,
        includeSpaceSessions: true,
      });
      expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      expect(agent.getSessionData().config.mcpServers).toHaveProperty('space-agent-tools');

      await svc.stop();
    });

    test('start() derives long-term agent names from repository when metadata lacks agentName', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const longTermSession = makeMemberSession({
        id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
        metadata: {
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: 'agent-1',
          },
        },
      });
      const svc = new SpaceRuntimeService(
        buildMemberConfig({
          sessionManager,
          listSessionsResult: [longTermSession],
          actorRegistryRepos: {
            spaceRepo: {} as SpaceRuntimeServiceConfig['actorRegistryRepos']['spaceRepo'],
            sessionRepo: {} as SpaceRuntimeServiceConfig['actorRegistryRepos']['sessionRepo'],
            spaceAgentRepo: {
              getCoordinator: mock(() => null),
              getById: mock(() => ({ id: 'agent-1', spaceId: mockSpace.id, name: 'Repo Agent' })),
            } as unknown as SpaceRuntimeServiceConfig['actorRegistryRepos']['spaceAgentRepo'],
            workflowRepo: {} as SpaceRuntimeServiceConfig['actorRegistryRepos']['workflowRepo'],
            workflowRunRepo:
              {} as SpaceRuntimeServiceConfig['actorRegistryRepos']['workflowRunRepo'],
            nodeExecutionRepo: makeNoopNodeExecutionRepo(),
          },
        })
      );

      svc.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      const [mcpArg] = (agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>)
        .mock.calls[0];
      expect(mcpArg).toHaveProperty('space-agent-tools');

      await svc.stop();
    });

    test('sets onMissingMemberSpaceMcpServers self-heal callback on member sessions', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

      await svc.attachSpaceToolsToMemberSession(makeMemberSession());

      expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      expect(typeof (agent as unknown as AgentSession).onMissingMemberSpaceMcpServers).toBe(
        'function'
      );
    });

    test('onMissingMemberSpaceMcpServers self-heal callback re-attaches tools', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = makeSessionManager(agent);
      const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

      await svc.attachSpaceToolsToMemberSession(makeMemberSession());
      expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      expect(typeof (agent as unknown as AgentSession).onMissingMemberSpaceMcpServers).toBe(
        'function'
      );

      await (agent as unknown as AgentSession).onMissingMemberSpaceMcpServers?.(
        'worker-session-1',
        ['space-agent-tools']
      );

      expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(2);
    });

    test('long-term agent reattach preserves existing runtime MCP servers and avoids duplicate server names', async () => {
      const previous = process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER;
      process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER = '0';
      try {
        const preservedServer = { type: 'sdk', name: 'external-runtime' } as McpServerConfig;
        const agent = makeMemberAgentSession({
          id: longTermAgentSessionId(mockSpace.id, 'agent-1'),
          config: {
            tools: {},
            mcpServers: {
              'external-runtime': preservedServer,
            },
          },
          metadata: {
            promptProvenance: {
              source: 'test',
              hash: 'hash',
              agentId: 'agent-1',
              agentName: 'Long Term',
            },
          },
        });
        const sessionManager = makeSessionManager(agent);
        const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

        await (
          svc as unknown as {
            attachLongTermAgentMcpServersForSession(session: Session): Promise<void>;
          }
        ).attachLongTermAgentMcpServersForSession(agent.getSessionData());
        await (
          svc as unknown as {
            attachLongTermAgentMcpServersForSession(session: Session): Promise<void>;
          }
        ).attachLongTermAgentMcpServersForSession(agent.getSessionData());

        expect(agent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(2);
        const serverNames = Object.keys(agent.getSessionData().config.mcpServers ?? {});
        expect(serverNames.sort()).toEqual(['external-runtime', 'space-agent-tools']);
        expect(agent.getSessionData().config.mcpServers?.['external-runtime']).toBe(
          preservedServer
        );
      } finally {
        if (previous === undefined) delete process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER;
        else process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER = previous;
      }
    });

    test('long-term agent reactivation resolves the LH handle alias so @handle delegation survives restart', async () => {
      const agent = makeMemberAgentSession({
        id: longTermAgentSessionId(mockSpace.id, 'agent-lh'),
        metadata: {
          promptProvenance: {
            source: 'long_horizon_agent',
            hash: 'agent-lh',
            agentId: 'agent-lh',
            agentName: 'Release Manager',
          },
        },
      });
      const sessionManager = makeSessionManager(agent);
      const longHorizonAgentRepo = {
        getById: mock(() => ({
          id: 'agent-lh',
          spaceId: mockSpace.id,
          handle: 'release-manager',
          displayName: 'Release Manager',
          autonomyLevel: 2,
        })),
        listBySpaceId: mock(() => []),
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
      const actorRegistryRepos = {
        sessionRepo: { updateSession: mock(() => {}) },
        spaceAgentRepo: { getById: mock(() => null) },
      } as unknown as SpaceRuntimeServiceConfig['actorRegistryRepos'];
      const svc = new SpaceRuntimeService(
        buildMemberConfig({ sessionManager, longHorizonAgentRepo, actorRegistryRepos })
      );

      await (
        svc as unknown as {
          attachLongTermAgentMcpServersForSession(session: Session): Promise<void>;
        }
      ).attachLongTermAgentMcpServersForSession(agent.getSessionData());

      expect(longHorizonAgentRepo.getById).toHaveBeenCalledWith('agent-lh');
      const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
      expect(mergeMock).toHaveBeenCalledTimes(1);
      expect(mergeMock.mock.calls[0][0]).toHaveProperty('space-agent-tools');
    });

    test('long-term agent deleted sessions release db-query runtime server handles', async () => {
      const sessionId = longTermAgentSessionId(mockSpace.id, 'agent-1');
      const agent = makeMemberAgentSession({
        id: sessionId,
        metadata: {
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: 'agent-1',
            agentName: 'Long Term',
          },
        },
      });
      const sessionManager = makeSessionManager(agent);
      const dir = join(
        process.cwd(),
        'tmp',
        'test-long-term-agent-tools',
        `db-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, 'test.db');
      const tmpDb = new BunDatabase(dbPath);
      tmpDb.close();

      try {
        const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager, dbPath }));
        await (
          svc as unknown as {
            attachLongTermAgentMcpServersForSession(session: Session): Promise<void>;
          }
        ).attachLongTermAgentMcpServersForSession(agent.getSessionData());
        const dbQueryServers = (
          svc as unknown as { longTermAgentDbQueryServers: Map<string, { close: () => void }> }
        ).longTermAgentDbQueryServers;
        const server = dbQueryServers.get(sessionId);
        expect(server).toBeDefined();
        const closeMock = mock(() => {});
        dbQueryServers.set(sessionId, { close: closeMock });

        (
          svc as unknown as { releaseLongTermAgentDbQuery(sessionId: string): void }
        ).releaseLongTermAgentDbQuery(sessionId);

        expect(closeMock).toHaveBeenCalledTimes(1);
        expect(dbQueryServers.has(sessionId)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('internalEventBus session.created subscription (Task #137 regression)', () => {
    function makeMemberAgentSession() {
      return {
        mergeRuntimeMcpServers: mock((_: Record<string, McpServerConfig>) => {}),
        setRuntimeMcpServers: mock(() => {}),
        setRuntimeSystemPrompt: mock(() => {}),
      } as unknown as AgentSession;
    }

    function makeMemberSession(overrides: Partial<Session> = {}): Session {
      return {
        id: 'worker-session-uuid-123',
        title: 'Worker',
        workspacePath: '/tmp/ws',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: { tools: {} },
        metadata: {},
        type: 'worker',
        context: { spaceId: mockSpace.id },
        ...overrides,
      } as unknown as Session;
    }

    test('attaches space-agent-tools when internalEventBus emits session.created with a UUID sessionId', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = {
        getSessionAsync: mock(async () => agent),
        listSessions: mock(() => [] as Session[]),
      } as unknown as SessionManager;

      const internalEventBus = await createTestInternalEventBus('space-rts-test-created');
      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: createMockSpaceManager(mockSpace),
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: { listWorkflows: mock(() => []) } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
        internalEventBus,
      });
      svc.start();

      const session = makeMemberSession();
      await internalEventBus.publish('session.created', { sessionId: session.id, session });

      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
      expect(mergeMock).toHaveBeenCalledTimes(1);
      const [additional] = mergeMock.mock.calls[0];
      expect(additional).toHaveProperty('space-agent-tools');

      await svc.stop();
    });

    test('clears all task interests when a task becomes done', async () => {
      let taskUpdatedHandler:
        | ((
            event: import('../../../../src/lib/internal-event-bus').DaemonInternalEventMap['space.task.updated']
          ) => void)
        | undefined;
      const internalEventBus = {
        subscribe: mock((event: string, handler: typeof taskUpdatedHandler) => {
          if (event === 'space.task.updated') taskUpdatedHandler = handler;
          return () => {};
        }),
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as SpaceRuntimeServiceConfig['internalEventBus'];
      const sessionManager = {
        listSessions: mock(() => [] as Session[]),
        getSessionAsync: mock(async () => null),
        registerSessionResetSubscriber: mock(() => () => {}),
      } as unknown as SessionManager;
      const svc = new SpaceRuntimeService({
        ...buildConfig(createMockSpaceManager()),
        sessionManager,
        internalEventBus,
      });
      const runtime = (
        svc as unknown as {
          runtime: {
            clearTaskInterests: (taskId: string) => void;
            clearTaskInterestsPreservingDynamic: (taskId: string) => void;
          };
        }
      ).runtime;
      const clearAll = mock(() => {});
      const clearPreservingDynamic = mock(() => {});
      runtime.clearTaskInterests = clearAll;
      runtime.clearTaskInterestsPreservingDynamic = clearPreservingDynamic;
      svc.start();

      expect(taskUpdatedHandler).toBeDefined();
      taskUpdatedHandler?.({
        sessionId: 'global',
        spaceId: mockSpace.id,
        taskId: 'task-done',
        task: {
          id: 'task-done',
          spaceId: mockSpace.id,
          taskNumber: 1,
          title: 'Done task',
          description: '',
          status: 'done',
          priority: 'normal',
          labels: [],
          dependsOn: [],
          result: null,
          workflowRunId: 'run-done',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as import('@hyperneo/shared').SpaceTask,
      });

      expect(clearAll).toHaveBeenCalledWith('task-done');
      expect(clearPreservingDynamic).not.toHaveBeenCalled();

      await svc.stop();
    });

    test('does NOT attach for sessions outside Space policy', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = {
        getSessionAsync: mock(async () => agent),
        listSessions: mock(() => [] as Session[]),
      } as unknown as SessionManager;

      const internalEventBus = await createTestInternalEventBus('space-rts-test-non-space');
      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: createMockSpaceManager(mockSpace),
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: { listWorkflows: mock(() => []) } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
        internalEventBus,
      });
      svc.start();

      const nonSpaceSession = makeMemberSession({ context: undefined });
      await internalEventBus.publish('session.created', {
        sessionId: nonSpaceSession.id,
        session: nonSpaceSession,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();

      await svc.stop();
    });

    test('does NOT attach for space_chat sessions (handled by setupSpaceAgentSession)', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = {
        getSessionAsync: mock(async () => agent),
        listSessions: mock(() => [] as Session[]),
      } as unknown as SessionManager;

      const internalEventBus = await createTestInternalEventBus('space-rts-test-space-chat');
      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: createMockSpaceManager(mockSpace),
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: { listWorkflows: mock(() => []) } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
        internalEventBus,
      });
      svc.start();

      const chatSession = makeMemberSession({
        type: 'space_chat',
        id: `space:chat:${mockSpace.id}`,
      });
      await internalEventBus.publish('session.created', {
        sessionId: chatSession.id,
        session: chatSession,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();

      await svc.stop();
    });

    test('does NOT attach for workflow workers identified by node execution ownership', async () => {
      const agent = makeMemberAgentSession();
      const sessionManager = {
        getSessionAsync: mock(async () => agent),
        listSessions: mock(() => [] as Session[]),
      } as unknown as SessionManager;
      const internalEventBus = await createTestInternalEventBus(
        'space-rts-test-sub-session-policy'
      );
      const subSession = makeMemberSession({ id: 'opaque-workflow-worker' });
      const nodeExecutionRepo = {
        getByAgentSessionId: mock((sessionId: string) =>
          sessionId === subSession.id ? { id: 'exec-1' } : null
        ),
      };
      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: createMockSpaceManager(mockSpace),
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: { listWorkflows: mock(() => []) } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        tickIntervalMs: 60_000,
        sessionManager,
        internalEventBus,
        nodeExecutionRepo: nodeExecutionRepo as unknown as NodeExecutionRepository,
      });

      svc.start();

      await internalEventBus.publish('session.created', {
        sessionId: subSession.id,
        session: subSession,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(nodeExecutionRepo.getByAgentSessionId).toHaveBeenCalledWith(subSession.id);
      expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();

      await svc.stop();
    });

    test('session.deleted handler runs when internalEventBus emits with a UUID sessionId', async () => {
      const sessionManager = {
        getSessionAsync: mock(async () => null),
        listSessions: mock(() => [] as Session[]),
      } as unknown as SessionManager;

      const internalEventBus = await createTestInternalEventBus('space-rts-test-deleted');
      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: createMockSpaceManager(mockSpace),
        spaceAgentManager: { listBySpaceId: mock(() => []) } as unknown as SpaceAgentManager,
        spaceWorkflowManager: { listWorkflows: mock(() => []) } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
        internalEventBus,
      });

      const memberDbQueryServers = (
        svc as unknown as {
          memberSessionDbQueryServers: Map<string, { close: () => void }>;
        }
      ).memberSessionDbQueryServers;
      const closeMock = mock(() => {});
      memberDbQueryServers.set('worker-session-uuid-456', { close: closeMock });

      svc.start();

      await internalEventBus.publish('session.deleted', { sessionId: 'worker-session-uuid-456' });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(closeMock).toHaveBeenCalledTimes(1);
      expect(memberDbQueryServers.has('worker-session-uuid-456')).toBe(false);

      await svc.stop();
    });
  });

  describe('ready() — startup provisioning gate', () => {
    function makeSession() {
      return {
        setRuntimeMcpServers: mock(() => {}),
        mergeRuntimeMcpServers: mock(() => {}),
        setRuntimeSystemPrompt: mock(() => {}),
      } as unknown as AgentSession;
    }

    function makeMemberAgentSession() {
      return {
        mergeRuntimeMcpServers: mock(() => {}),
        setRuntimeMcpServers: mock(() => {}),
        setRuntimeSystemPrompt: mock(() => {}),
      } as unknown as AgentSession;
    }

    function makeMemberSession(id: string): Session {
      return {
        id,
        title: 'Worker',
        workspacePath: '/tmp/ws',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: { tools: {} },
        metadata: {},
        type: 'worker',
        context: { spaceId: mockSpace.id },
      } as unknown as Session;
    }

    test('ready() resolves only after BOTH the chat-session sweep and the member-session sweep have completed', async () => {
      const chatAgent = makeSession();
      const memberAgent = makeMemberAgentSession();

      let resolveChat!: () => void;
      const chatGate = new Promise<void>((r) => {
        resolveChat = r;
      });
      let resolveMember!: () => void;
      const memberGate = new Promise<void>((r) => {
        resolveMember = r;
      });

      const sessionManager = {
        getSessionAsync: mock(async (id: string) => {
          if (id === `space:chat:${mockSpace.id}`) {
            await chatGate;
            return chatAgent;
          }
          await memberGate;
          return memberAgent;
        }),
        listSessions: mock(() => [makeMemberSession('member-gated')]),
      } as unknown as SessionManager;

      const spaceMgr: SpaceManager = {
        getSpace: mock(async () => mockSpace),
        listSpaces: mock(async () => [mockSpace]),
      } as unknown as SpaceManager;

      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: spaceMgr,
        spaceAgentManager: {
          listBySpaceId: mock(() => []),
        } as unknown as SpaceAgentManager,
        spaceWorkflowManager: {
          listWorkflows: mock(() => []),
        } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {
          getActiveRuns: mock(() => []),
        } as unknown as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
      });

      svc.start();

      let readyResolved = false;
      const readyPromise = svc.ready().then(() => {
        readyResolved = true;
      });

      await new Promise<void>((r) => setTimeout(r, 5));
      expect(readyResolved).toBe(false);

      resolveChat();
      await new Promise<void>((r) => setTimeout(r, 5));
      expect(readyResolved).toBe(false);

      resolveMember();
      await readyPromise;
      expect(readyResolved).toBe(true);

      expect(chatAgent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);
      expect(memberAgent.mergeRuntimeMcpServers).toHaveBeenCalledTimes(1);

      await svc.stop();
    });

    test('ready() is safe to call before start() and resolves immediately', async () => {
      const svc = new SpaceRuntimeService(buildConfig(createMockSpaceManager()));
      await expect(svc.ready()).resolves.toBeUndefined();
    });

    test('ready() does not reject when a sweep throws — errors are logged, not propagated', async () => {
      const spaceMgr: SpaceManager = {
        getSpace: mock(async () => mockSpace),
        listSpaces: mock(async () => {
          throw new Error('boom');
        }),
      } as unknown as SpaceManager;

      const sessionManager = {
        getSessionAsync: mock(async () => null),
        listSessions: mock(() => {
          throw new Error('boom-list');
        }),
      } as unknown as SessionManager;

      const svc = new SpaceRuntimeService({
        db: {} as BunDatabase,
        spaceManager: spaceMgr,
        spaceAgentManager: {
          listBySpaceId: mock(() => []),
        } as unknown as SpaceAgentManager,
        spaceWorkflowManager: {
          listWorkflows: mock(() => []),
        } as unknown as SpaceWorkflowManager,
        workflowRunRepo: {} as SpaceWorkflowRunRepository,
        taskRepo: {} as SpaceTaskRepository,
        nodeExecutionRepo: makeNoopNodeExecutionRepo(),
        tickIntervalMs: 60_000,
        sessionManager,
      });

      svc.start();
      await expect(svc.ready()).resolves.toBeUndefined();

      await svc.stop();
    });
  });
});

function makeTestDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

describe('activateWorkflowNode() — InternalEventBus forwarding', () => {
  test('publishes space.workflowRun.reopened to InternalEventBus when reopening a done run', async () => {
    const db = makeTestDb();
    try {
      const SPACE_ID = 'space-act-sink-1';
      const AGENT_ID = 'agent-act-sink-1';
      const NODE_A = 'node-act-a';
      const NODE_B = 'node-act-b';

      db.prepare(
        `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
				 allowed_models, session_ids, slug, status, created_at, updated_at)
				 VALUES (?, '/tmp/ws', 'Test', '', '', '', '[]', '[]', ?, 'active', ?, ?)`
      ).run(SPACE_ID, SPACE_ID, Date.now(), Date.now());
      db.prepare(
        `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
				 VALUES (?, ?, 'A', '', null, '[]', '', ?, ?)`
      ).run(AGENT_ID, SPACE_ID, Date.now(), Date.now());

      const taskRepo = new SpaceTaskRepo(db);
      const workflowRunRepo = new SpaceWorkflowRunRepo(db);
      const { ChannelCycleRepository } = await import(
        '../../../../src/storage/repositories/channel-cycle-repository.ts'
      );
      const channelCycleRepo = new ChannelCycleRepository(db);
      const agentRepo = new SpaceAgentRepository(db);
      const agentManager = new AgentMgr(agentRepo);
      const workflowRepo = new SpaceWorkflowRepository(db);
      const workflowManager = new WorkflowMgr(workflowRepo);
      const spaceManager = new SpaceMgr(db);

      const { InternalEventBus } = await import('../../../../src/lib/internal-event-bus.ts');
      type DaemonInternalEventMap =
        import('../../../../src/lib/internal-event-bus.ts').DaemonInternalEventMap;

      const bus = new InternalEventBus<DaemonInternalEventMap>();
      const busEvents: Array<{ event: string; payload: unknown }> = [];
      bus.subscribe(
        'space.workflowRun.reopened',
        (payload) => {
          busEvents.push({ event: 'space.workflowRun.reopened', payload });
        },
        { subscriberName: 'test-activate-subscriber' }
      );

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `WF ${Date.now()}`,
        description: '',
        nodes: [
          { id: NODE_A, name: 'A', agentId: AGENT_ID },
          { id: NODE_B, name: 'B', agentId: AGENT_ID },
        ],
        transitions: [],
        startNodeId: NODE_A,
        endNodeId: NODE_B,
        rules: [],
        tags: [],
        channels: [],
        completionAutonomyLevel: 3,
      });

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Reopen me',
      });
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Reopen me',
        description: '',
        status: 'open',
        workflowRunId: run.id,
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');

      const service = new SpaceRuntimeService({
        db,
        spaceManager: spaceManager as unknown as SpaceManager,
        spaceAgentManager: agentManager as unknown as SpaceAgentManager,
        spaceWorkflowManager: workflowManager as unknown as SpaceWorkflowManager,
        workflowRunRepo,
        taskRepo,
        tickIntervalMs: 60_000,
        channelCycleRepo,
        internalEventBus: bus,
      });

      await service.activateWorkflowNode(run.id, NODE_B);

      expect(busEvents).toHaveLength(1);
      const payload = busEvents[0].payload as Record<string, unknown>;
      expect(payload['runId']).toBe(run.id);
      expect(payload['spaceId']).toBe(SPACE_ID);
      expect(payload['fromStatus']).toBe('done');
    } finally {
      try {
        db.close();
      } catch {}
    }
  });
});

describe('buildLongHorizonAgentSessionConfig — provider inference (Task #768)', () => {
  const service = new SpaceRuntimeService(buildConfig(createMockSpaceManager(mockSpace)));

  beforeEach(() => clearModelsCache());
  afterEach(() => clearModelsCache());

  function seedModels(models: ModelInfo[]): void {
    const cache = new Map<string, ModelInfo[]>();
    cache.set('global', models);
    setModelsCache(cache);
  }

  function cachedModel(id: string, provider: string): ModelInfo {
    return {
      id,
      name: id,
      alias: id,
      family: id,
      provider,
      contextWindow: 200000,
      description: '',
      releaseDate: '2026-01-01',
      available: true,
    };
  }

  async function callBuilder(
    agent: SpaceLongHorizonAgent,
    currentProvider?: string,
    currentModel?: string
  ): Promise<Partial<Session['config']>> {
    return (
      service as unknown as {
        buildLongHorizonAgentSessionConfig: (
          space: Space,
          a: SpaceLongHorizonAgent,
          currentProvider?: string,
          currentModel?: string
        ) => Promise<Partial<Session['config']>>;
      }
    ).buildLongHorizonAgentSessionConfig(mockSpace, agent, currentProvider, currentModel);
  }

  test('infers kimi provider when model is kimi and provider is unset', async () => {
    const config = await callBuilder(buildLongHorizonAgent({ model: 'kimi-for-coding' }));
    expect(config.model).toBe('kimi-for-coding');
    expect(config.provider).toBe('kimi');
  });

  test('leaves provider undefined for anthropic-family models so cached metadata resolves the variant', async () => {
    const config = await callBuilder(buildLongHorizonAgent({ model: 'claude-sonnet-4.6' }));
    expect(config.model).toBe('claude-sonnet-4.6');
    expect(config.provider).toBeUndefined();
  });

  test('leaves provider undefined for anthropic catch-all models (P1: Copilot Gemini)', async () => {
    const config = await callBuilder(buildLongHorizonAgent({ model: 'gemini-3.1-pro-preview' }));
    expect(config.model).toBe('gemini-3.1-pro-preview');
    expect(config.provider).toBeUndefined();
  });

  test('leaves provider undefined for contested gpt-* models (P1: Codex/Copilot)', async () => {
    const claiming = (id: string) =>
      ({
        id,
        displayName: id,
        ownsModel: () => true,
        isAvailable: async () => true,
      }) as unknown as Provider;
    const registry = getProviderRegistry();
    registry.register(claiming('anthropic-codex'));
    registry.register(claiming('anthropic-copilot'));
    try {
      const config = await callBuilder(buildLongHorizonAgent({ model: 'gpt-5.4' }));
      expect(config.model).toBe('gpt-5.4');
      expect(config.provider).toBeUndefined();
    } finally {
      resetProviderRegistry();
    }
  });

  test('persists provider-specific non-contested inferences (ollama)', async () => {
    const config = await callBuilder(buildLongHorizonAgent({ model: 'gpt-oss:20b' }));
    expect(config.model).toBe('gpt-oss:20b');
    expect(config.provider).toBe('ollama');
  });

  test('resolves the cached provider for contested models (P1: Copilot Gemini/gpt-*)', async () => {
    seedModels([
      cachedModel('gemini-3.1-pro-preview', 'anthropic-copilot'),
      cachedModel('gpt-5.4', 'anthropic-copilot'),
    ]);

    expect(
      (await callBuilder(buildLongHorizonAgent({ model: 'gemini-3.1-pro-preview' }))).provider
    ).toBe('anthropic-copilot');
    expect((await callBuilder(buildLongHorizonAgent({ model: 'gpt-5.4' }))).provider).toBe(
      'anthropic-copilot'
    );
  });

  test('resolves the cached provider for custom-endpoint models with built-in-looking IDs (P1)', async () => {
    seedModels([cachedModel('glm-4', 'custom-endpoint')]);

    const config = await callBuilder(buildLongHorizonAgent({ model: 'glm-4' }));
    expect(config.provider).toBe('custom-endpoint');
  });

  test('preserves the session provider across wakes when the cache still offers the model (P1)', async () => {
    seedModels([
      cachedModel('claude-sonnet-4.6', 'anthropic'),
      cachedModel('claude-sonnet-4.6', 'anthropic-copilot'),
    ]);

    expect(
      (await callBuilder(buildLongHorizonAgent({ model: 'claude-sonnet-4.6' }))).provider
    ).toBe('anthropic');
    expect(
      (
        await callBuilder(
          buildLongHorizonAgent({ model: 'claude-sonnet-4.6' }),
          'anthropic-copilot'
        )
      ).provider
    ).toBe('anthropic-copilot');
  });

  test('recomputes when the preferred provider no longer offers the model', async () => {
    seedModels([cachedModel('claude-sonnet-4.6', 'anthropic-copilot')]);

    expect(
      (
        await callBuilder(
          buildLongHorizonAgent({ model: 'kimi-for-coding' }),
          'anthropic-copilot',
          'claude-sonnet-4.6'
        )
      ).provider
    ).toBe('kimi');
  });

  test('retains the live provider across a transient cache miss when the model is unchanged (P2)', async () => {
    seedModels([cachedModel('claude-sonnet-4.6', 'anthropic')]);

    expect(
      (await callBuilder(buildLongHorizonAgent({ model: 'glm-4' }), 'custom-endpoint', 'glm-4'))
        .provider
    ).toBe('custom-endpoint');
  });

  test('retains the live provider even when another provider offers the same ID (P2)', async () => {
    seedModels([cachedModel('glm-4', 'glm')]);

    expect(
      (await callBuilder(buildLongHorizonAgent({ model: 'glm-4' }), 'custom-endpoint', 'glm-4'))
        .provider
    ).toBe('custom-endpoint');
  });

  test('explicit agent.provider wins over inference', async () => {
    const config = await callBuilder(
      buildLongHorizonAgent({ model: 'kimi-for-coding', provider: 'openrouter' })
    );
    expect(config.provider).toBe('openrouter');
  });

  test('falls back to the default model, provider left undefined, when neither is set', async () => {
    const config = await callBuilder(buildLongHorizonAgent({}));
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.provider).toBeUndefined();
  });
});

describe('buildLongHorizonAgentSessionConfig — owner-review contract injection (MC5-B1)', () => {
  const service = new SpaceRuntimeService(buildConfig(createMockSpaceManager(mockSpace)));

  async function callBuilder(agent: SpaceLongHorizonAgent): Promise<Partial<Session['config']>> {
    return (
      service as unknown as {
        buildLongHorizonAgentSessionConfig: (
          space: Space,
          a: SpaceLongHorizonAgent
        ) => Promise<Partial<Session['config']>>;
      }
    ).buildLongHorizonAgentSessionConfig(mockSpace, agent);
  }

  function systemPromptAppend(config: Partial<Session['config']>): string {
    const prompt = config.systemPrompt;
    if (typeof prompt !== 'object' || prompt === null || prompt.type !== 'preset') return '';
    return prompt.append ?? '';
  }

  test('injects the current owner-review contract for agents without instructions', async () => {
    const config = await callBuilder(buildLongHorizonAgent({ instructions: '' }));
    const append = systemPromptAppend(config);
    expect(append).toContain('## Goal Ownership & Outcome Review Contract');
    expect(append).toContain('## Scheduling & Task Systems');
  });

  test('persisted agents with stale template instructions still receive the current contract', async () => {
    const staleInstructions =
      'Maintain marketing momentum. (drafted before the review tool existed)';
    const config = await callBuilder(buildLongHorizonAgent({ instructions: staleInstructions }));
    const append = systemPromptAppend(config);
    expect(append).toContain(staleInstructions);
    expect(append).toContain('## Goal Ownership & Outcome Review Contract');
    expect(append).toContain('review_goal_outcome');
  });

  test('user-customized instructions are preserved, not replaced, by the contract append', async () => {
    const custom = 'My bespoke positioning playbook.';
    const config = await callBuilder(buildLongHorizonAgent({ instructions: custom }));
    const append = systemPromptAppend(config);
    expect(append.startsWith(custom)).toBe(true);
    expect(append).toContain('## Goal Ownership & Outcome Review Contract');
    expect(append.match(/## Goal Ownership & Outcome Review Contract/g)?.length).toBe(1);
  });
});

describe('refreshLongHorizonAgentSessionConfig — self-heals undefined provider (Task #768)', () => {
  const service = new SpaceRuntimeService(buildConfig(createMockSpaceManager(mockSpace)));
  const refresh = () =>
    service as unknown as {
      refreshLongHorizonAgentSessionConfig: (
        session: AgentSession,
        config: Partial<Session['config']>
      ) => Promise<void>;
    };

  test('updates provider undefined → kimi on the next wake', async () => {
    const updateConfig = mock(async () => {});
    const resetQuery = mock(async () => ({ success: true }));
    const restart = mock(async () => {});
    const stranded = {
      getSessionData: () => ({ config: { model: 'kimi-for-coding', provider: undefined } }),
      updateConfig,
      resetQuery,
      restart,
    } as unknown as AgentSession;

    const built = await (
      service as unknown as {
        buildLongHorizonAgentSessionConfig: (
          s: Space,
          a: SpaceLongHorizonAgent
        ) => Promise<Partial<Session['config']>>;
      }
    ).buildLongHorizonAgentSessionConfig(
      mockSpace,
      buildLongHorizonAgent({ model: 'kimi-for-coding' })
    );

    await refresh().refreshLongHorizonAgentSessionConfig(stranded, built);

    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: 'kimi' }));
    expect(resetQuery).toHaveBeenCalledWith({ restartQuery: false });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  test('re-evaluates the context budget in the restart beforeStart gap', async () => {
    const updateConfig = mock(async () => {});
    const resetQuery = mock(async () => ({ success: true }));
    const reevaluate = mock(async () => {});
    const restart = mock(async (options?: { beforeStart?: () => Promise<void> }) => {
      await options?.beforeStart?.();
    });
    const session = {
      getSessionData: () => ({ config: { model: 'old-model', provider: 'kimi' } }),
      updateConfig,
      resetQuery,
      reevaluateContextBudgetAfterModelSwitch: reevaluate,
      restart,
    } as unknown as AgentSession;

    await refresh().refreshLongHorizonAgentSessionConfig(session, {
      model: 'kimi-for-coding',
      provider: 'kimi',
    });

    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(resetQuery).toHaveBeenCalledWith({ restartQuery: false });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(reevaluate).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when the provider already matches', async () => {
    const updateConfig = mock(async () => {});
    const resetQuery = mock(async () => ({ success: true }));
    const session = {
      getSessionData: () => ({ config: { model: 'kimi-for-coding', provider: 'kimi' } }),
      updateConfig,
      resetQuery,
    } as unknown as AgentSession;

    await refresh().refreshLongHorizonAgentSessionConfig(session, {
      model: 'kimi-for-coding',
      provider: 'kimi',
    });

    expect(updateConfig).not.toHaveBeenCalled();
    expect(resetQuery).not.toHaveBeenCalled();
  });

  test('does not stomp the provider createSession resolved from the cache (P1)', async () => {
    const cache = new Map<string, ModelInfo[]>();
    cache.set('global', [
      {
        id: 'gemini-3.1-pro-preview',
        name: 'gemini-3.1-pro-preview',
        alias: 'gemini-3.1-pro-preview',
        family: 'gemini-3.1-pro-preview',
        provider: 'anthropic-copilot',
        contextWindow: 200000,
        description: '',
        releaseDate: '2026-01-01',
        available: true,
      },
    ]);
    setModelsCache(cache);
    try {
      const built = await (
        service as unknown as {
          buildLongHorizonAgentSessionConfig: (
            s: Space,
            a: SpaceLongHorizonAgent
          ) => Promise<Partial<Session['config']>>;
        }
      ).buildLongHorizonAgentSessionConfig(
        mockSpace,
        buildLongHorizonAgent({ model: 'gemini-3.1-pro-preview' })
      );
      expect(built.provider).toBe('anthropic-copilot');

      const updateConfig = mock(async () => {});
      const resetQuery = mock(async () => ({ success: true }));
      const session = {
        getSessionData: () => ({ config: { ...built } }),
        updateConfig,
        resetQuery,
      } as unknown as AgentSession;

      await refresh().refreshLongHorizonAgentSessionConfig(session, built);

      expect(updateConfig).not.toHaveBeenCalled();
      expect(resetQuery).not.toHaveBeenCalled();
    } finally {
      clearModelsCache();
    }
  });
});

describe('ensureLongTermAgentSession — regular worker agent provider inference (Task #768)', () => {
  async function captureRegularAgentConfig(
    agent: SpaceWorkerAgent
  ): Promise<Partial<Session['config']> | undefined> {
    const createdConfigs: Partial<Session['config']>[] = [];
    let lookups = 0;
    const sessionMock = {
      getSessionData: () => ({ id: 'sess-1', metadata: {} }),
      mergeRuntimeMcpServers: () => {},
    };
    const sessionManager = {
      getSessionAsync: mock(async () => {
        lookups += 1;
        return lookups === 1 ? null : sessionMock;
      }),
      createSession: mock(async (opts: { config: Partial<Session['config']> }) => {
        createdConfigs.push(opts.config);
      }),
    } as unknown as SessionManager;
    const spaceAgentManager = {
      getById: mock(() => agent),
    } as unknown as SpaceAgentManager;

    const svc = new SpaceRuntimeService({
      ...buildConfig(createMockSpaceManager(mockSpace)),
      sessionManager,
      spaceAgentManager,
    });
    (
      svc as unknown as { attachLongTermAgentMcpServers: () => void }
    ).attachLongTermAgentMcpServers = () => {};
    (
      svc as unknown as { missingLongTermAgentMcpServers: () => boolean }
    ).missingLongTermAgentMcpServers = () => false;

    await (
      svc as unknown as { ensureLongTermAgentSession: (a: ActorRef) => Promise<unknown> }
    ).ensureLongTermAgentSession({
      actorId: `agent:${agent.id}`,
      spaceId: agent.spaceId,
    } as ActorRef);

    return createdConfigs[0];
  }

  test('infers kimi provider for a kimi model with no explicit provider', async () => {
    const config = await captureRegularAgentConfig({
      id: 'worker-1',
      spaceId: 'space-1',
      name: 'Worker',
      model: 'kimi-for-coding',
      provider: null,
      thinkingLevel: null,
      customPrompt: '',
      tools: [],
      settingSources: null,
    } as unknown as SpaceWorkerAgent);

    expect(config).toBeDefined();
    expect(config?.model).toBe('kimi-for-coding');
    expect(config?.provider).toBe('kimi');
  });

  test('leaves provider undefined for anthropic catch-all models in the regular branch (P1)', async () => {
    const config = await captureRegularAgentConfig({
      id: 'worker-3',
      spaceId: 'space-1',
      name: 'Worker',
      model: 'gemini-3.1-pro-preview',
      provider: null,
      thinkingLevel: null,
      customPrompt: '',
      tools: [],
      settingSources: null,
    } as unknown as SpaceWorkerAgent);

    expect(config?.model).toBe('gemini-3.1-pro-preview');
    expect(config?.provider).toBeUndefined();
  });

  test('leaves provider undefined for contested gpt-* models in the regular branch (P1)', async () => {
    const claiming = (id: string) =>
      ({
        id,
        displayName: id,
        ownsModel: () => true,
        isAvailable: async () => true,
      }) as unknown as Provider;
    const registry = getProviderRegistry();
    registry.register(claiming('anthropic-codex'));
    registry.register(claiming('anthropic-copilot'));
    try {
      const config = await captureRegularAgentConfig({
        id: 'worker-4',
        spaceId: 'space-1',
        name: 'Worker',
        model: 'gpt-5.5',
        provider: null,
        thinkingLevel: null,
        customPrompt: '',
        tools: [],
        settingSources: null,
      } as unknown as SpaceWorkerAgent);

      expect(config?.model).toBe('gpt-5.5');
      expect(config?.provider).toBeUndefined();
    } finally {
      resetProviderRegistry();
    }
  });

  test('resolves the cached provider for contested models in the regular branch (P1)', async () => {
    const cache = new Map<string, ModelInfo[]>();
    cache.set('global', [
      {
        id: 'gemini-3.1-pro-preview',
        name: 'gemini-3.1-pro-preview',
        alias: 'gemini-3.1-pro-preview',
        family: 'gemini-3.1-pro-preview',
        provider: 'anthropic-copilot',
        contextWindow: 200000,
        description: '',
        releaseDate: '2026-01-01',
        available: true,
      },
    ]);
    setModelsCache(cache);
    try {
      const config = await captureRegularAgentConfig({
        id: 'worker-5',
        spaceId: 'space-1',
        name: 'Worker',
        model: 'gemini-3.1-pro-preview',
        provider: null,
        thinkingLevel: null,
        customPrompt: '',
        tools: [],
        settingSources: null,
      } as unknown as SpaceWorkerAgent);

      expect(config?.provider).toBe('anthropic-copilot');
    } finally {
      clearModelsCache();
    }
  });

  test('explicit provider wins over inference for regular agents', async () => {
    const config = await captureRegularAgentConfig({
      id: 'worker-2',
      spaceId: 'space-1',
      name: 'Worker',
      model: 'kimi-for-coding',
      provider: 'openrouter',
      thinkingLevel: null,
      customPrompt: '',
      tools: [],
      settingSources: null,
    } as unknown as SpaceWorkerAgent);

    expect(config?.provider).toBe('openrouter');
  });
});

describe('clearLongTermAgentSessionProvider — provider-override clear (P2)', () => {
  function buildService(session: unknown): SpaceRuntimeService {
    const sessionManager = {
      getSessionAsync: mock(async () => session),
    } as unknown as SessionManager;
    return new SpaceRuntimeService({
      ...buildConfig(createMockSpaceManager(mockSpace)),
      sessionManager,
    });
  }

  test('clears the session persisted provider so the next wake re-resolves', async () => {
    const updateConfig = mock(async () => {});
    const session = {
      getSessionData: () => ({ config: { model: 'kimi-for-coding', provider: 'openrouter' } }),
      updateConfig,
    };
    const svc = buildService(session);

    await svc.clearLongTermAgentSessionProvider('space-1', 'agent-1');

    expect(updateConfig).toHaveBeenCalledWith({ provider: undefined });
  });

  test('is a no-op when the session provider is already unset', async () => {
    const updateConfig = mock(async () => {});
    const session = {
      getSessionData: () => ({ config: { model: 'kimi-for-coding', provider: undefined } }),
      updateConfig,
    };
    const svc = buildService(session);

    await svc.clearLongTermAgentSessionProvider('space-1', 'agent-1');

    expect(updateConfig).not.toHaveBeenCalled();
  });

  test('is a no-op when the session does not exist', async () => {
    const svc = buildService(null);

    await expect(
      svc.clearLongTermAgentSessionProvider('space-1', 'agent-1')
    ).resolves.toBeUndefined();
  });
});
