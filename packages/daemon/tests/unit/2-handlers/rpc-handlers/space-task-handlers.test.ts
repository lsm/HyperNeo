import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { SpaceTaskManagerFactory } from '../../../../src/lib/rpc-handlers/space-task-handlers';
import { setupSpaceTaskHandlers } from '../../../../src/lib/rpc-handlers/space-task-handlers';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';

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

const mockTask: SpaceTask = makeTask();

const mockWorkflow: SpaceWorkflow = {
  id: 'workflow-1',
  spaceId: 'space-1',
  name: 'Coding Workflow',
  nodes: [
    {
      id: 'node-1',
      name: 'Coding',
      agents: [{ agentId: 'agent-coder', name: 'coder' }],
    },
  ],
  startNodeId: 'node-1',
  tags: [],
  completionAutonomyLevel: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Test Task',
    description: 'A task description',
    status: 'open',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    reportedStatus: null,
    reportedSummary: null,
    ...overrides,
  };
}

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
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
  return {
    getSpace: mock(async () => space),
  } as unknown as SpaceManager;
}

function createMockWorkflowManager(
  workflow: SpaceWorkflow | null = mockWorkflow
): SpaceWorkflowManager {
  return {
    getWorkflow: mock(() => workflow),
  } as unknown as SpaceWorkflowManager;
}

function createMockTaskManager(task: SpaceTask | null = mockTask): SpaceTaskManager {
  return {
    createTask: mock(async () => task!),
    getTask: mock(async () => task),
    listTasks: mock(async () => (task ? [task] : [])),
    listTasksByStatusPaginated: mock(async () => ({
      tasks: task ? [task] : [],
      total: task ? 1 : 0,
    })),
    setTaskStatus: mock(async () => ({ ...task!, status: 'in_progress' as const })),
    updateTask: mock(async (_taskId: string, params: Partial<SpaceTask>) => ({
      ...task!,
      ...params,
    })),
    updateTaskProgress: mock(async () => ({ ...task!, progress: 50 })),
    publishTask: mock(async () => ({ ...task!, status: 'open' as const })),
    submitTaskForReview: mock(async (_taskId: string, opts: { reason: string | null }) => ({
      ...task!,
      status: 'review' as const,
      pendingCheckpointType: 'task_completion' as const,
      pendingCompletionSubmittedByNodeId: null,
      pendingCompletionSubmittedAt: NOW,
      pendingCompletionReason: opts.reason,
    })),
  } as unknown as SpaceTaskManager;
}

describe('space-task-handlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let spaceManager: SpaceManager;
  let workflowManager: SpaceWorkflowManager;
  let taskManager: SpaceTaskManager;
  let taskManagerFactory: SpaceTaskManagerFactory;

  function setup(
    space: Space | null = mockSpace,
    task: SpaceTask | null = mockTask,
    runtime?: SpaceRuntimeService,
    workflow: SpaceWorkflow | null = mockWorkflow,
    goalService?: { handleTaskTerminal: (taskId: string) => void }
  ) {
    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    internalEventBus = createMockInternalEventBus();
    spaceManager = createMockSpaceManager(space);
    workflowManager = createMockWorkflowManager(workflow);
    taskManager = createMockTaskManager(task);
    taskManagerFactory = mock((_spaceId: string) => taskManager);
    setupSpaceTaskHandlers(
      hub,
      spaceManager,
      workflowManager,
      taskManagerFactory,
      internalEventBus,
      runtime,
      goalService
    );
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  describe('spaceTask.create', () => {
    beforeEach(() => setup());

    it('creates a task and publishes space.task.created', async () => {
      const result = await call('spaceTask.create', {
        spaceId: 'space-1',
        title: 'Do work',
        description: 'description',
      });

      expect(result).toEqual(mockTask);
      expect(taskManager.createTask).toHaveBeenCalledTimes(1);
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.created', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: mockTask.id,
        task: mockTask,
      });
    });

    it('allows empty string description', async () => {
      await expect(
        call('spaceTask.create', { spaceId: 'space-1', title: 'T', description: '' })
      ).resolves.toBeDefined();
    });

    it('strips untrusted task id from create requests', async () => {
      await call('spaceTask.create', {
        spaceId: 'space-1',
        id: 'client-controlled-id',
        title: 'Do work',
        description: 'description',
      });

      expect(taskManager.createTask).toHaveBeenCalledWith(
        expect.not.objectContaining({ id: 'client-controlled-id' })
      );
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceTask.create', { title: 'T', description: 'D' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when title is missing', async () => {
      await expect(
        call('spaceTask.create', { spaceId: 'space-1', description: 'D' })
      ).rejects.toThrow('title is required');
    });

    it('throws when title is empty string', async () => {
      await expect(
        call('spaceTask.create', { spaceId: 'space-1', title: '', description: 'D' })
      ).rejects.toThrow('title is required');
    });

    it('throws when description is null', async () => {
      await expect(
        call('spaceTask.create', { spaceId: 'space-1', title: 'T', description: null })
      ).rejects.toThrow('description must not be null');
    });

    it('throws when description is undefined', async () => {
      await expect(call('spaceTask.create', { spaceId: 'space-1', title: 'T' })).rejects.toThrow(
        'description must not be null'
      );
    });

    it('throws when space is not found', async () => {
      setup(null);
      await expect(
        call('spaceTask.create', {
          spaceId: 'ghost',
          title: 'T',
          description: 'D',
        })
      ).rejects.toThrow('Space not found: ghost');
    });

    it('propagates task manager errors (e.g. invalid dependency)', async () => {
      (taskManager.createTask as ReturnType<typeof mock>).mockRejectedValue(
        new Error('Dependency task not found in space: bad-dep')
      );

      await expect(
        call('spaceTask.create', {
          spaceId: 'space-1',
          title: 'T',
          description: 'D',
          dependsOn: ['bad-dep'],
        })
      ).rejects.toThrow('Dependency task not found');
    });

    it('creates a draft task when draft flag is true', async () => {
      await call('spaceTask.create', {
        spaceId: 'space-1',
        title: 'Draft',
        description: 'D',
        draft: true,
      });

      expect(taskManager.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'draft' })
      );
    });

    it('rejects contradictory draft flag and non-draft status', async () => {
      await expect(
        call('spaceTask.create', {
          spaceId: 'space-1',
          title: 'Draft',
          description: 'D',
          draft: true,
          status: 'open',
        })
      ).rejects.toThrow('draft: true cannot be combined with a non-draft status');

      expect(taskManager.createTask).not.toHaveBeenCalled();
    });
  });

  describe('spaceTask.list', () => {
    beforeEach(() => setup());

    it('lists tasks for a space', async () => {
      const result = await call('spaceTask.list', { spaceId: 'space-1' });
      expect(result).toEqual([mockTask]);
      expect(taskManager.listTasks).toHaveBeenCalledWith(false);
    });

    it('passes includeArchived flag', async () => {
      await call('spaceTask.list', { spaceId: 'space-1', includeArchived: true });
      expect(taskManager.listTasks).toHaveBeenCalledWith(true);
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceTask.list', {})).rejects.toThrow('spaceId is required');
    });

    it('throws when space is not found', async () => {
      setup(null);
      await expect(call('spaceTask.list', { spaceId: 'ghost' })).rejects.toThrow(
        'Space not found: ghost'
      );
    });

    describe('paginated mode', () => {
      it('routes to listTasksByStatusPaginated with status + limit + offset', async () => {
        const result = await call('spaceTask.list', {
          spaceId: 'space-1',
          status: 'in_progress',
          limit: 10,
          offset: 20,
        });

        expect(taskManager.listTasksByStatusPaginated).toHaveBeenCalledWith(
          'in_progress',
          undefined,
          10,
          20,
          undefined
        );
        expect(result).toEqual({ tasks: [mockTask], total: 1 });
      });

      it('forwards a blockReason filter when provided', async () => {
        await call('spaceTask.list', {
          spaceId: 'space-1',
          status: 'blocked',
          blockReason: 'human_input_requested',
          limit: 10,
        });

        expect(taskManager.listTasksByStatusPaginated).toHaveBeenCalledWith(
          'blocked',
          'human_input_requested',
          10,
          0,
          undefined
        );
      });

      it('forwards an explicit null blockReason', async () => {
        await call('spaceTask.list', {
          spaceId: 'space-1',
          status: 'blocked',
          blockReason: null,
        });

        expect(taskManager.listTasksByStatusPaginated).toHaveBeenCalledWith(
          'blocked',
          null,
          10,
          0,
          undefined
        );
      });

      it('forwards a blockReasonNotIn filter', async () => {
        await call('spaceTask.list', {
          spaceId: 'space-1',
          status: 'blocked',
          blockReasonNotIn: ['human_input_requested', 'gate_rejected'],
        });

        expect(taskManager.listTasksByStatusPaginated).toHaveBeenCalledWith(
          'blocked',
          undefined,
          10,
          0,
          ['human_input_requested', 'gate_rejected']
        );
      });

      it('rejects blockReason without status=blocked', async () => {
        await expect(
          call('spaceTask.list', {
            spaceId: 'space-1',
            status: 'in_progress',
            blockReason: 'human_input_requested',
          })
        ).rejects.toThrow(/status === 'blocked'/);
      });

      it('rejects combining blockReason and blockReasonNotIn', async () => {
        await expect(
          call('spaceTask.list', {
            spaceId: 'space-1',
            status: 'blocked',
            blockReason: 'human_input_requested',
            blockReasonNotIn: ['gate_rejected'],
          })
        ).rejects.toThrow(/mutually exclusive/);
      });

      it('rejects pagination params without a status', async () => {
        await expect(call('spaceTask.list', { spaceId: 'space-1', limit: 10 })).rejects.toThrow(
          /status is required/
        );
      });

      it('rejects non-positive limit', async () => {
        await expect(
          call('spaceTask.list', { spaceId: 'space-1', status: 'open', limit: 0 })
        ).rejects.toThrow(/limit must be a positive number/);
        await expect(
          call('spaceTask.list', { spaceId: 'space-1', status: 'open', limit: -1 })
        ).rejects.toThrow(/limit must be a positive number/);
      });

      it('rejects negative offset', async () => {
        await expect(
          call('spaceTask.list', { spaceId: 'space-1', status: 'open', offset: -1 })
        ).rejects.toThrow(/offset must be a non-negative number/);
      });

      it('defaults limit to 10 and offset to 0 when only status provided', async () => {
        await call('spaceTask.list', { spaceId: 'space-1', status: 'open' });
        expect(taskManager.listTasksByStatusPaginated).toHaveBeenCalledWith(
          'open',
          undefined,
          10,
          0,
          undefined
        );
      });
    });
  });

  describe('spaceTask.get', () => {
    beforeEach(() => setup());

    it('returns the task when found', async () => {
      const result = await call('spaceTask.get', {
        spaceId: 'space-1',
        taskId: 'task-1',
      });
      expect(result).toEqual(mockTask);
    });

    it('verifies space existence before fetching task', async () => {
      setup(null);
      await expect(call('spaceTask.get', { spaceId: 'ghost', taskId: 'task-1' })).rejects.toThrow(
        'Space not found: ghost'
      );
      expect(taskManager.getTask).not.toHaveBeenCalled();
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceTask.get', { taskId: 'task-1' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when taskId is missing', async () => {
      await expect(call('spaceTask.get', { spaceId: 'space-1' })).rejects.toThrow(
        'taskId is required'
      );
    });

    it('throws when task is not found', async () => {
      setup(mockSpace, null);
      await expect(call('spaceTask.get', { spaceId: 'space-1', taskId: 'ghost' })).rejects.toThrow(
        'Task not found: ghost'
      );
    });
  });

  describe('spaceTask.archive via spaceTask.update', () => {
    it('archives a completed task via status transition and publishes space.task.updated', async () => {
      const completedTask = { ...mockTask, status: 'completed' as const };
      setup(mockSpace, completedTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...completedTask,
        status: 'archived' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'archived',
      });

      expect((result as SpaceTask).status).toBe('archived');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'archived', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({ status: 'archived' }),
      });
    });

    it('archives a cancelled task via status transition', async () => {
      const cancelledTask = { ...mockTask, status: 'cancelled' as const };
      setup(mockSpace, cancelledTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...cancelledTask,
        status: 'archived' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'archived',
      });

      expect((result as SpaceTask).status).toBe('archived');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'archived', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
    });

    it('propagates invalid-transition error when archiving from in_progress', async () => {
      const inProgressTask = { ...mockTask, status: 'in_progress' as const };
      setup(mockSpace, inProgressTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockRejectedValue(
        new Error("Invalid status transition from 'in_progress' to 'archived'. Allowed: none")
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'archived',
        })
      ).rejects.toThrow('Invalid status transition');
    });

    it('rejects archiving a task that belongs to an active (non-terminal) workflow run (G1, task #849)', async () => {
      const runTask = {
        ...mockTask,
        status: 'open' as const,
        workflowRunId: 'run-1',
      };
      const runtime = {
        isWorkflowRunActive: mock(() => true),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, runTask, runtime);

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'archived',
        })
      ).rejects.toThrow(/active workflow run/);
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
    });

    it('allows archiving a task on a terminal (done/cancelled) workflow run', async () => {
      const runTask = {
        ...mockTask,
        status: 'done' as const,
        workflowRunId: 'run-1',
      };
      const runtime = {
        isWorkflowRunActive: mock(() => false),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, runTask, runtime);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...runTask,
        status: 'archived' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'archived',
      });

      expect((result as SpaceTask).status).toBe('archived');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith(
        'task-1',
        'archived',
        expect.anything()
      );
    });

    it('allows archiving a task with no workflow run (G1 shelve case)', async () => {
      const freeTask = { ...mockTask, status: 'open' as const };
      setup(mockSpace, freeTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...freeTask,
        status: 'archived' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'archived',
      });

      expect((result as SpaceTask).status).toBe('archived');
    });
  });

  describe('spaceTask.reactivate via spaceTask.update', () => {
    it('routes workflow-backed Resume through workflow recovery instead of task-only status update', async () => {
      const workflowTask = {
        ...mockTask,
        status: 'cancelled' as const,
        workflowRunId: 'run-1',
        completedAt: NOW - 1_000,
      };
      const recoveredTask = {
        ...workflowTask,
        status: 'in_progress' as const,
        completedAt: null,
      };
      const runtime = {
        recoverWorkflowBackedTask: mock(async () => recoveredTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, workflowTask, runtime);

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
      });

      expect(result).toEqual(recoveredTask);
      expect(runtime.recoverWorkflowBackedTask).toHaveBeenCalledWith(
        'space-1',
        'task-1',
        'in_progress'
      );
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
    });

    it('exposes explicit workflow recovery RPC', async () => {
      const workflowTask = {
        ...mockTask,
        status: 'cancelled' as const,
        workflowRunId: 'run-1',
      };
      const recoveredTask = { ...workflowTask, status: 'open' as const };
      const runtime = {
        recoverWorkflowBackedTask: mock(async () => recoveredTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, workflowTask, runtime);

      const result = await call('spaceTask.recoverWorkflow', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'open',
      });

      expect(result).toEqual(recoveredTask);
      expect(runtime.recoverWorkflowBackedTask).toHaveBeenCalledWith('space-1', 'task-1', 'open');
    });

    it('reactivates a completed task to in_progress and publishes space.task.updated', async () => {
      const completedTask = { ...mockTask, status: 'completed' as const };
      setup(mockSpace, completedTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...completedTask,
        status: 'in_progress' as const,
        result: undefined,
        progress: undefined,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
      });

      expect((result as SpaceTask).status).toBe('in_progress');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({ status: 'in_progress' }),
      });
    });

    it('reactivates a cancelled task to in_progress', async () => {
      const cancelledTask = { ...mockTask, status: 'cancelled' as const };
      setup(mockSpace, cancelledTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...cancelledTask,
        status: 'in_progress' as const,
        error: undefined,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
      });

      expect((result as SpaceTask).status).toBe('in_progress');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
    });

    it('reactivates a cancelled task to open', async () => {
      const cancelledTask = { ...mockTask, status: 'cancelled' as const };
      setup(mockSpace, cancelledTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...cancelledTask,
        status: 'open' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'open',
      });

      expect((result as SpaceTask).status).toBe('open');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'open', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
    });

    it('propagates invalid-transition error when reactivating an archived task', async () => {
      const archivedTask = { ...mockTask, status: 'archived' as const };
      setup(mockSpace, archivedTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockRejectedValue(
        new Error("Invalid status transition from 'archived' to 'in_progress'. Allowed: none")
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'in_progress',
        })
      ).rejects.toThrow('Invalid status transition');
    });
  });

  describe('spaceTask.update', () => {
    beforeEach(() => setup());

    it('delegates status change to setTaskStatus and publishes space.task.updated', async () => {
      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
      });

      expect((result as SpaceTask).status).toBe('in_progress');
      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({ status: 'in_progress' }),
      });
    });

    it('does NOT call setTaskStatus when status is unchanged (avoids spurious transition error)', async () => {
      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'open',
        title: 'New title',
      });

      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        {
          status: 'open',
          title: 'New title',
        },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect(result).toBeDefined();
    });

    it('delegates non-status update to updateTask', async () => {
      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        title: 'Updated',
      });

      expect((result as SpaceTask).title).toBe('Updated');
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { title: 'Updated' },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({ title: 'Updated' }),
      });
    });

    it('routes workflow-backed pause transitions through runtime cleanup', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        taskAgentSessionId: 'task-session-1',
      };
      const pausedTask = {
        ...activeTask,
        status: 'open' as const,
        taskAgentSessionId: undefined,
      };
      const runtime = {
        stopWorkflowBackedTaskForStatus: mock(async () => pausedTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'open',
      });

      expect(result).toEqual(pausedTask);
      expect(runtime.stopWorkflowBackedTaskForStatus).toHaveBeenCalledWith('space-1', 'task-1', {
        status: 'open',
      });
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
      expect(internalEventBus.publish).not.toHaveBeenCalledWith(
        'space.task.updated',
        expect.objectContaining({ taskId: 'task-1' })
      );
    });

    it('routes workflow-backed blocked task cancellation through runtime cleanup', async () => {
      const blockedTask = {
        ...mockTask,
        status: 'blocked' as const,
        workflowRunId: 'run-1',
        taskAgentSessionId: 'task-session-1',
      };
      const cancelledTask = {
        ...blockedTask,
        status: 'cancelled' as const,
        taskAgentSessionId: undefined,
      };
      const runtime = {
        stopWorkflowBackedTaskForStatus: mock(async () => cancelledTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, blockedTask, runtime);

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'cancelled',
        cancelReason: 'user cancelled',
      });

      expect(result).toEqual(cancelledTask);
      expect(runtime.stopWorkflowBackedTaskForStatus).toHaveBeenCalledWith('space-1', 'task-1', {
        status: 'cancelled',
        cancelReason: 'user cancelled',
      });
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
    });

    it('routes unmet dependency updates for workflow-backed in-progress tasks through runtime', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        dependsOn: ['dep-done'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => ({
          ...activeTask,
          dependsOn: ['dep-open'],
          status: 'blocked' as const,
          blockReason: 'dependency_added' as const,
        })),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);
      (taskManager.updateTask as ReturnType<typeof mock>).mockResolvedValue({
        ...activeTask,
        dependsOn: ['dep-open'],
        status: 'blocked' as const,
        blockReason: 'dependency_added' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dep-open'],
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { dependsOn: ['dep-open'] },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect(runtime.stopWorkflowBackedTask).toHaveBeenCalledWith('space-1', 'task-1', {
        dependsOn: ['dep-open'],
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      });
      expect((result as SpaceTask).status).toBe('blocked');
    });

    it('routes same-status unmet dependency updates through runtime', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        dependsOn: ['dep-done'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => ({
          ...activeTask,
          dependsOn: ['dep-open'],
          status: 'blocked' as const,
          blockReason: 'dependency_added' as const,
        })),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);
      (taskManager.updateTask as ReturnType<typeof mock>).mockResolvedValue({
        ...activeTask,
        dependsOn: ['dep-open'],
        status: 'blocked' as const,
        blockReason: 'dependency_added' as const,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
        dependsOn: ['dep-open'],
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { status: 'in_progress', dependsOn: ['dep-open'] },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect(runtime.stopWorkflowBackedTask).toHaveBeenCalledWith('space-1', 'task-1', {
        status: 'blocked',
        dependsOn: ['dep-open'],
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      });
      expect((result as SpaceTask).status).toBe('blocked');
    });

    it('does not pre-check overwrite runtime pointers before dependency block cleanup', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        taskAgentSessionId: 'task-session-1',
        dependsOn: ['dep-done'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => ({
          ...activeTask,
          dependsOn: ['dep-open'],
          status: 'blocked' as const,
          blockReason: 'dependency_added' as const,
        })),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);
      (taskManager.updateTask as ReturnType<typeof mock>).mockResolvedValue({
        ...activeTask,
        dependsOn: ['dep-open'],
        status: 'blocked' as const,
        blockReason: 'dependency_added' as const,
      });

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dep-open'],
        taskAgentSessionId: null,
        workflowRunId: null,
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { dependsOn: ['dep-open'] },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect(runtime.stopWorkflowBackedTask).toHaveBeenCalledWith('space-1', 'task-1', {
        dependsOn: ['dep-open'],
        taskAgentSessionId: null,
        workflowRunId: null,
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      });
    });

    it('does not double-run goal terminal handling after runtime dependency block', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        dependsOn: ['dep-done'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => ({
          ...activeTask,
          dependsOn: ['dep-open'],
          status: 'blocked' as const,
          blockReason: 'dependency_added' as const,
        })),
      } as unknown as SpaceRuntimeService;
      const goalService = {
        handleTaskTerminal: mock(() => {}),
      };
      setup(mockSpace, activeTask, runtime, goalService);
      (taskManager.updateTask as ReturnType<typeof mock>).mockResolvedValue({
        ...activeTask,
        dependsOn: ['dep-open'],
        status: 'blocked' as const,
        blockReason: 'dependency_added' as const,
      });

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dep-open'],
      });

      expect(runtime.stopWorkflowBackedTask).toHaveBeenCalledTimes(1);
      expect(goalService.handleTaskTerminal).not.toHaveBeenCalled();
    });

    it('keeps met dependency updates on normal updateTask path', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        dependsOn: ['dep-old'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => activeTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);
      (taskManager.updateTask as ReturnType<typeof mock>).mockResolvedValue({
        ...activeTask,
        dependsOn: ['dep-done'],
        status: 'in_progress' as const,
      });

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dep-done'],
      });

      expect(runtime.stopWorkflowBackedTask).not.toHaveBeenCalled();
      expect(taskManager.updateTask).toHaveBeenCalledTimes(1);
    });

    it('preserves pointer field updates on non-blocking dependency changes', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        workflowRunId: 'run-1',
        taskAgentSessionId: 'task-session-1',
        dependsOn: ['dep-old'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => activeTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);
      (taskManager.updateTask as ReturnType<typeof mock>)
        .mockResolvedValueOnce({
          ...activeTask,
          dependsOn: ['dep-done'],
          status: 'in_progress' as const,
        })
        .mockResolvedValueOnce({
          ...activeTask,
          dependsOn: ['dep-done'],
          taskAgentSessionId: 'replacement-session',
          workflowRunId: 'replacement-run',
          status: 'in_progress' as const,
        });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dep-done'],
        taskAgentSessionId: 'replacement-session',
        workflowRunId: 'replacement-run',
      });

      expect(runtime.stopWorkflowBackedTask).not.toHaveBeenCalled();
      expect(taskManager.updateTask).toHaveBeenNthCalledWith(
        1,
        'task-1',
        { dependsOn: ['dep-done'] },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect(taskManager.updateTask).toHaveBeenNthCalledWith(
        2,
        'task-1',
        { taskAgentSessionId: 'replacement-session', workflowRunId: 'replacement-run' },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect((result as SpaceTask).taskAgentSessionId).toBe('replacement-session');
      expect((result as SpaceTask).workflowRunId).toBe('replacement-run');
    });

    it('keeps non-workflow dependency updates on normal updateTask path', async () => {
      const activeTask = {
        ...mockTask,
        status: 'in_progress' as const,
        dependsOn: ['dep-old'],
      };
      const runtime = {
        stopWorkflowBackedTask: mock(async () => activeTask),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, activeTask, runtime);

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dep-open'],
      });

      expect(runtime.stopWorkflowBackedTask).not.toHaveBeenCalled();
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { dependsOn: ['dep-open'] },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('publishes space.task.updated for cascaded dependency changes', async () => {
      const cascadedTask = {
        ...mockTask,
        id: 'dependent-task',
        status: 'blocked' as const,
        dependsOn: ['task-1'],
      };
      (taskManager.updateTask as ReturnType<typeof mock>).mockImplementation(
        async (
          _taskId: string,
          params: Record<string, unknown>,
          options?: { onCascadedTasks?: (tasks: SpaceTask[]) => Promise<void> }
        ) => {
          await options?.onCascadedTasks?.([cascadedTask]);
          return { ...mockTask, ...params };
        }
      );

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        dependsOn: ['dependency-task'],
      });

      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'dependent-task',
        task: cascadedTask,
      });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({ dependsOn: ['dependency-task'] }),
      });
    });

    it('passes result to setTaskStatus when provided with status', async () => {
      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'blocked',
        result: 'Build failed',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'blocked', {
        result: 'Build failed',
        approvalReason: undefined,
        approvalSource: undefined,
      });
    });

    it('persists validated per-task workflow model overrides', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' } },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('clears empty workflow model overrides', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        workflowModelOverrides: { 'node-1:coder': '' },
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { workflowModelOverrides: null },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('trims workflow model override keys and values before persisting', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        workflowModelOverrides: { ' node-1:coder ': ' claude-opus-4-5 ' },
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' } },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('rejects clearing workflow model overrides after task start', async () => {
      setup(
        mockSpace,
        makeTask({ preferredWorkflowId: 'workflow-1', startedAt: NOW, workflowRunId: 'run-1' })
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: null,
        })
      ).rejects.toThrow('Workflow model overrides are locked after the task starts');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects workflow model overrides after task start', async () => {
      setup(
        mockSpace,
        makeTask({ preferredWorkflowId: 'workflow-1', startedAt: NOW, workflowRunId: 'run-1' })
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Workflow model overrides are locked after the task starts');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects workflow model overrides without selected workflow', async () => {
      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Select a workflow before setting model overrides');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects workflow model overrides for unknown node-agent targets', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: { 'node-2:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Invalid workflow model override target: node-2:coder');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects workflow model overrides for disabled workflows', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }), undefined, {
        ...mockWorkflow,
        disabled: true,
      });

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Cannot set model overrides for a disabled workflow');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects non-object workflow model override payloads', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      for (const workflowModelOverrides of [123, false, ['node-1:coder']]) {
        await expect(
          call('spaceTask.update', {
            spaceId: 'space-1',
            taskId: 'task-1',
            workflowModelOverrides,
          })
        ).rejects.toThrow('workflowModelOverrides must be a string map');
      }
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects non-string workflow model override values', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: { 'node-1:coder': 123 },
        })
      ).rejects.toThrow('workflowModelOverrides must be a string map');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('validates workflow model overrides against incoming workflow selection', async () => {
      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        preferredWorkflowId: 'workflow-1',
        workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        {
          preferredWorkflowId: 'workflow-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('rejects workflow model overrides when clearing workflow selection', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          preferredWorkflowId: null,
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Select a workflow before setting model overrides');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('clears existing workflow model overrides when workflow selection changes', async () => {
      setup(
        mockSpace,
        makeTask({
          preferredWorkflowId: 'workflow-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      );

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        preferredWorkflowId: 'workflow-2',
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { preferredWorkflowId: 'workflow-2', workflowModelOverrides: null },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('rejects implicit workflow model override clears after task start', async () => {
      setup(
        mockSpace,
        makeTask({
          preferredWorkflowId: 'workflow-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
          startedAt: NOW,
          workflowRunId: 'run-1',
        })
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          preferredWorkflowId: 'workflow-2',
        })
      ).rejects.toThrow('Workflow model overrides are locked after the task starts');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('clears existing workflow model overrides when workflow selection is removed', async () => {
      setup(
        mockSpace,
        makeTask({
          preferredWorkflowId: 'workflow-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      );

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        preferredWorkflowId: null,
      });

      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { preferredWorkflowId: null, workflowModelOverrides: null },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('allows start and workflow selection changes without override mutations', async () => {
      setup(
        mockSpace,
        makeTask({
          preferredWorkflowId: 'workflow-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      );

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
        preferredWorkflowId: 'workflow-2',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { preferredWorkflowId: 'workflow-2', workflowModelOverrides: null },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('allows workflow model override updates with non-start status changes', async () => {
      setup(mockSpace, makeTask({ status: 'draft', preferredWorkflowId: 'workflow-1' }));

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'open',
        workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'open', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        { workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' } },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('rejects workflow model override updates combined with task start', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'in_progress',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Workflow model overrides are locked after the task starts');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
    });

    it('rechecks workflow model override lock immediately before write', async () => {
      setup(mockSpace, makeTask({ preferredWorkflowId: 'workflow-1' }));
      (
        taskManager.getTask as unknown as {
          mockImplementation: (fn: () => Promise<SpaceTask>) => void;
        }
      ).mockImplementation(() =>
        Promise.resolve(
          makeTask({ preferredWorkflowId: 'workflow-1', workflowRunId: 'run-1', startedAt: NOW })
        )
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
        })
      ).rejects.toThrow('Workflow model overrides are locked after the task starts');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('applies non-status fields (e.g. taskAgentSessionId) after status transition', async () => {
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...mockTask,
        status: 'in_progress' as const,
      });
      (taskManager.updateTask as ReturnType<typeof mock>).mockImplementation(
        async (_taskId: string, params: Record<string, unknown>) => ({
          ...mockTask,
          status: 'in_progress' as const,
          ...params,
        })
      );

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'in_progress',
        taskAgentSessionId: 'session-abc',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress', {
        result: undefined,
        approvalReason: undefined,
        approvalSource: undefined,
      });
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        {
          taskAgentSessionId: 'session-abc',
        },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
      expect((result as SpaceTask).status).toBe('in_progress');
      expect((result as SpaceTask).taskAgentSessionId).toBe('session-abc');
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceTask.update', { taskId: 'task-1', title: 'X' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when taskId is missing', async () => {
      await expect(call('spaceTask.update', { spaceId: 'space-1', title: 'X' })).rejects.toThrow(
        'taskId is required'
      );
    });

    it('throws Space not found when space does not exist', async () => {
      setup(null);
      await expect(
        call('spaceTask.update', { spaceId: 'ghost', taskId: 'task-1', title: 'X' })
      ).rejects.toThrow('Space not found: ghost');
      expect(taskManager.updateTask).not.toHaveBeenCalled();
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
    });

    it('maps cancelReason onto approvalReason for review→cancelled audit trail', async () => {
      const reviewTask = { ...mockTask, status: 'review' as const };
      setup(mockSpace, reviewTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...reviewTask,
        status: 'cancelled' as const,
      });
      (taskManager.updateTask as ReturnType<typeof mock>).mockImplementation(
        async (_taskId: string, params: Record<string, unknown>) => ({
          ...reviewTask,
          status: 'cancelled' as const,
          ...params,
        })
      );

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'cancelled',
        cancelReason: 'not worth shipping',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'cancelled', {
        result: undefined,
        approvalSource: undefined,
        approvalReason: 'not worth shipping',
      });
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        {
          approvalReason: 'not worth shipping',
        },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('falls back to approvalReason when cancelReason is omitted on cancel transitions', async () => {
      const reviewTask = { ...mockTask, status: 'review' as const };
      setup(mockSpace, reviewTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...reviewTask,
        status: 'cancelled' as const,
      });

      await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'cancelled',
        approvalReason: 'rejected via legacy field',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'cancelled', {
        result: undefined,
        approvalSource: undefined,
        approvalReason: 'rejected via legacy field',
      });
      expect(taskManager.updateTask).toHaveBeenCalledWith(
        'task-1',
        {
          approvalReason: 'rejected via legacy field',
        },
        expect.objectContaining({ onCascadedTasks: expect.any(Function) })
      );
    });

    it('propagates errors from setTaskStatus (invalid transitions)', async () => {
      const doneTask = { ...mockTask, status: 'done' as const };
      setup(mockSpace, doneTask);

      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockRejectedValue(
        new Error("Invalid status transition from 'done' to 'in_progress'. Allowed: none")
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'in_progress',
        })
      ).rejects.toThrow('Invalid status transition');
    });

    it('rejects bare in_progress→review transitions and points at spaceTask.submitForReview', async () => {
      const inProgressTask = { ...mockTask, status: 'in_progress' as const };
      setup(mockSpace, inProgressTask);

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'review',
        })
      ).rejects.toThrow(/spaceTask\.submitForReview/);
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('rejects bare → approved transitions and points at the post-approval router', async () => {
      const inProgressTask = { ...mockTask, status: 'in_progress' as const };
      setup(mockSpace, inProgressTask);

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          status: 'approved',
        })
      ).rejects.toThrow(/approvePendingCompletion|post-approval/);
      expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
      expect(taskManager.updateTask).not.toHaveBeenCalled();
    });

    it('allows approved → done via spaceTask.update — relies on setTaskStatus to clear post-approval-* atomically', async () => {
      const approvedTask = { ...mockTask, status: 'approved' as const };
      setup(mockSpace, approvedTask);
      (taskManager.setTaskStatus as ReturnType<typeof mock>).mockResolvedValue({
        ...approvedTask,
        status: 'done' as const,
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
      });

      const result = await call('spaceTask.update', {
        spaceId: 'space-1',
        taskId: 'task-1',
        status: 'done',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'done', expect.any(Object));
      expect((result as SpaceTask).status).toBe('done');
    });

    it('propagates errors from updateTask', async () => {
      (taskManager.updateTask as ReturnType<typeof mock>).mockRejectedValue(
        new Error('Task not found: task-1')
      );

      await expect(
        call('spaceTask.update', {
          spaceId: 'space-1',
          taskId: 'task-1',
          title: 'X',
        })
      ).rejects.toThrow('Task not found');
    });
  });

  describe('spaceTask.submitForReview', () => {
    beforeEach(() => setup());

    it('delegates to taskManager.submitTaskForReview with submittedByNodeId=null and the reason', async () => {
      const result = await call('spaceTask.submitForReview', {
        spaceId: 'space-1',
        taskId: 'task-1',
        reason: 'ready for human eyes',
      });

      expect(taskManager.submitTaskForReview).toHaveBeenCalledWith('task-1', {
        submittedByNodeId: null,
        reason: 'ready for human eyes',
      });
      expect((result as SpaceTask).status).toBe('review');
      expect((result as SpaceTask).pendingCheckpointType).toBe('task_completion');
      expect((result as SpaceTask).pendingCompletionReason).toBe('ready for human eyes');
    });

    it('coerces missing reason to null so the manager always receives an explicit value', async () => {
      await call('spaceTask.submitForReview', {
        spaceId: 'space-1',
        taskId: 'task-1',
      });

      expect(taskManager.submitTaskForReview).toHaveBeenCalledWith('task-1', {
        submittedByNodeId: null,
        reason: null,
      });
    });

    it('publishes space.task.updated with the post-submit task', async () => {
      await call('spaceTask.submitForReview', {
        spaceId: 'space-1',
        taskId: 'task-1',
        reason: 'ready',
      });

      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({
          status: 'review',
          pendingCheckpointType: 'task_completion',
        }),
      });
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceTask.submitForReview', { taskId: 'task-1' })).rejects.toThrow(
        'spaceId is required'
      );
      expect(taskManager.submitTaskForReview).not.toHaveBeenCalled();
    });

    it('throws when taskId is missing', async () => {
      await expect(call('spaceTask.submitForReview', { spaceId: 'space-1' })).rejects.toThrow(
        'taskId is required'
      );
      expect(taskManager.submitTaskForReview).not.toHaveBeenCalled();
    });

    it('throws Space not found when space does not exist', async () => {
      setup(null);
      await expect(
        call('spaceTask.submitForReview', { spaceId: 'ghost', taskId: 'task-1' })
      ).rejects.toThrow('Space not found: ghost');
      expect(taskManager.submitTaskForReview).not.toHaveBeenCalled();
    });

    it('propagates manager errors (e.g. invalid status transition)', async () => {
      (taskManager.submitTaskForReview as ReturnType<typeof mock>).mockRejectedValue(
        new Error("Invalid status transition from 'archived' to 'review'. Allowed: none")
      );

      await expect(
        call('spaceTask.submitForReview', { spaceId: 'space-1', taskId: 'task-1' })
      ).rejects.toThrow('Invalid status transition');
    });
  });

  describe('spaceTask.approvePendingCompletion', () => {
    beforeEach(() => setup());

    it('dispatches human approval through the post-approval router and returns the refreshed task', async () => {
      const reviewTask = {
        ...mockTask,
        status: 'review' as const,
        pendingCheckpointType: 'task_completion' as const,
      };
      const approvedTask = { ...reviewTask, status: 'approved' as const };
      const runtime = {
        dispatchPostApproval: mock(async () => {}),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, reviewTask, runtime);
      (taskManager.getTask as ReturnType<typeof mock>)
        .mockResolvedValueOnce(reviewTask)
        .mockResolvedValueOnce(approvedTask);

      const result = await call('spaceTask.approvePendingCompletion', {
        spaceId: 'space-1',
        taskId: 'task-1',
        approved: true,
        reason: 'looks good',
      });

      expect(runtime.dispatchPostApproval).toHaveBeenCalledWith('space-1', 'task-1', 'human', {
        approvalReason: 'looks good',
      });
      expect(result).toEqual(approvedTask);
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: approvedTask,
      });
    });

    it('surfaces a post-approval dispatch failure as a warning, not a raw throw (Layer C)', async () => {
      const reviewTask = {
        ...mockTask,
        status: 'review' as const,
        pendingCheckpointType: 'task_completion' as const,
      };
      const approvedTask = { ...reviewTask, status: 'approved' as const };
      const runtime = {
        dispatchPostApproval: mock(async () => {
          throw new Error('user interrupted');
        }),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, reviewTask, runtime);
      (taskManager.getTask as ReturnType<typeof mock>)
        .mockResolvedValueOnce(reviewTask)
        .mockResolvedValueOnce(approvedTask)
        .mockResolvedValueOnce(approvedTask);

      const result = await call('spaceTask.approvePendingCompletion', {
        spaceId: 'space-1',
        taskId: 'task-1',
        approved: true,
      });

      expect(result.status).toBe('approved');
      expect(taskManager.updateTask).toHaveBeenCalledWith('task-1', {
        postApprovalBlockedReason: expect.stringContaining('Approval recorded'),
      });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: approvedTask,
      });
    });

    it('rethrows when the status transition itself failed (approval did not happen)', async () => {
      const reviewTask = {
        ...mockTask,
        status: 'review' as const,
        pendingCheckpointType: 'task_completion' as const,
      };
      const runtime = {
        dispatchPostApproval: mock(async () => {
          throw new Error('Invalid status transition');
        }),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, reviewTask, runtime);
      (taskManager.getTask as ReturnType<typeof mock>)
        .mockResolvedValueOnce(reviewTask)
        .mockResolvedValueOnce(reviewTask);

      await expect(
        call('spaceTask.approvePendingCompletion', {
          spaceId: 'space-1',
          taskId: 'task-1',
          approved: true,
        })
      ).rejects.toThrow('Invalid status transition');
      expect(taskManager.updateTask).not.toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ postApprovalBlockedReason: expect.any(String) })
      );
    });

    it('rejects completion back to in_progress with rejection reason', async () => {
      const reviewTask = {
        ...mockTask,
        status: 'review' as const,
        pendingCheckpointType: 'task_completion' as const,
      };
      setup(mockSpace, reviewTask);

      await call('spaceTask.approvePendingCompletion', {
        spaceId: 'space-1',
        taskId: 'task-1',
        approved: false,
        reason: 'needs revision',
      });

      expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress');
      expect(taskManager.updateTask).toHaveBeenCalledWith('task-1', {
        approvalReason: 'needs revision',
      });
    });

    it('requires a task_completion checkpoint', async () => {
      await expect(
        call('spaceTask.approvePendingCompletion', {
          spaceId: 'space-1',
          taskId: 'task-1',
          approved: true,
        })
      ).rejects.toThrow('not awaiting submit_for_approval review');
    });
  });

  describe('spaceTask.publish', () => {
    beforeEach(() => setup());

    it('publishes a draft task and publishes space.task.updated', async () => {
      const mockDraftTask = { ...mockTask, status: 'draft' };
      (taskManager.getTask as ReturnType<typeof mock>).mockResolvedValue(mockDraftTask);
      (taskManager.publishTask as ReturnType<typeof mock>).mockResolvedValue({
        ...mockTask,
        status: 'open',
      });

      const result = await call('spaceTask.publish', {
        spaceId: 'space-1',
        taskId: 'task-1',
      });

      expect(result.status).toBe('open');
      expect(taskManager.publishTask).toHaveBeenCalledWith('task-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.task.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        taskId: 'task-1',
        task: expect.objectContaining({ status: 'open' }),
      });
    });

    it('throws when taskId is missing', async () => {
      await expect(call('spaceTask.publish', { spaceId: 'space-1' })).rejects.toThrow(
        'taskId is required'
      );
    });

    it('throws when task is not in draft status', async () => {
      (taskManager.getTask as ReturnType<typeof mock>).mockResolvedValue({
        ...mockTask,
        status: 'open',
      });

      await expect(
        call('spaceTask.publish', { spaceId: 'space-1', taskId: 'task-1' })
      ).rejects.toThrow("not in 'draft' status");
    });
  });
});
