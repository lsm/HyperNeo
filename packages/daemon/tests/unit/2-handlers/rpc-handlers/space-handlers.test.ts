import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type {
  Space,
  SpaceCreateResult,
  SpaceTask,
  SpaceWorkspace,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import { setupSpaceHandlers } from '../../../../src/lib/rpc-handlers/space-handlers';
import {
  WorkspaceRegistrationError,
  WorkspaceRemovalBlockedError,
} from '../../../../src/lib/space/managers/space-workspace-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';

type RequestHandler = (data: unknown) => Promise<unknown>;

const NOW = Date.now();

const mockSpace: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/tmp/test-workspace',
  name: 'Test Space',
  description: 'A test space',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  paused: false,
  stopped: false,
  autonomyLevel: 1,
  maxConcurrentTasks: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const mockTask: SpaceTask = {
  id: 'task-1',
  spaceId: 'space-1',
  taskNumber: 1,
  title: 'Test Task',
  description: 'desc',
  status: 'open',
  priority: 'normal',
  dependsOn: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const mockRun: SpaceWorkflowRun = {
  id: 'run-1',
  spaceId: 'space-1',
  workflowId: 'wf-1',
  title: 'Run 1',
  status: 'pending',
  createdAt: NOW,
  updatedAt: NOW,
};

const mockWorkspace: SpaceWorkspace = {
  id: 'ws-1',
  spaceId: 'space-1',
  path: '/tmp/test-workspace',
  label: 'test-workspace',
  isPrimary: true,
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
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
  return {
    createSpace: mock(async () => space!),
    getSpace: mock(async () => space),
    listSpaces: mock(async () => (space ? [space] : [])),
    updateSpace: mock(async () => space!),
    archiveSpace: mock(async () => ({ ...space!, status: 'archived' as const })),
    pauseSpace: mock(async () => ({ ...space!, paused: true })),
    resumeSpace: mock(async () => ({ ...space!, paused: false })),
    stopSpace: mock(async () => ({ ...space!, stopped: true })),
    startSpace: mock(async () => ({ ...space!, stopped: false, paused: false })),
    deleteSpace: mock(async () => true),
    addSession: mock(async () => space!),
    removeSession: mock(async () => space!),
    registerWorkspace: mock(async () => mockWorkspace),
    removeWorkspace: mock(() => true),
    listWorkspaces: mock(() => [mockWorkspace]),
  } as unknown as SpaceManager;
}

function registrationError(
  reason: 'path_claimed_by_another_space' | 'not_a_git_repository_root',
  message: string
): WorkspaceRegistrationError {
  return new WorkspaceRegistrationError(message, reason, {
    accepted: false,
    reason,
    message,
    canonicalPath: null,
  });
}

function createMockTaskRepo(tasks: SpaceTask[] = [mockTask]): SpaceTaskRepository {
  return {
    listBySpace: mock(() => tasks),
  } as unknown as SpaceTaskRepository;
}

function createMockRunRepo(runs: SpaceWorkflowRun[] = [mockRun]): SpaceWorkflowRunRepository {
  return {
    listBySpace: mock(() => runs),
  } as unknown as SpaceWorkflowRunRepository;
}

const mockAgents = [
  { id: 'agent-coder', name: 'Coder', spaceId: 'space-1' },
  { id: 'agent-general', name: 'General', spaceId: 'space-1' },
  { id: 'agent-planner', name: 'Planner', spaceId: 'space-1' },
  { id: 'agent-research', name: 'Research', spaceId: 'space-1' },
  { id: 'agent-reviewer', name: 'Reviewer', spaceId: 'space-1' },
  { id: 'agent-qa', name: 'QA', spaceId: 'space-1' },
];

function createMockSpaceAgentManager(opts?: {
  createFail?: (name: string) => boolean;
}): SpaceAgentManager {
  let callCount = 0;
  return {
    create: mock(async (params: { name?: string }) => {
      const idx = callCount++;
      if (opts?.createFail?.(params.name ?? '')) {
        return { ok: false, error: `Agent ${params.name} already exists` };
      }
      const agent = mockAgents[idx] ?? {
        id: `agent-${idx}`,
        name: params.name,
        spaceId: 'space-1',
      };
      return { ok: true, value: agent };
    }),
    listBySpaceId: mock(() => mockAgents),
  } as unknown as SpaceAgentManager;
}

function createMockSpaceWorkflowManager(): SpaceWorkflowManager {
  return {
    createWorkflow: mock(() => ({})),
    listWorkflows: mock(() => []),
    getWorkflow: mock(() => null),
  } as unknown as SpaceWorkflowManager;
}

function createMockSessionManager(): SessionManager {
  return {
    createSession: mock(async () => 'space:chat:space-1'),
    getSessionAsync: mock(async () => null),
  } as unknown as SessionManager;
}

function createMockSpaceRuntimeService(): SpaceRuntimeService {
  return {
    setupSpaceAgentSession: mock(async () => {}),
  } as unknown as SpaceRuntimeService;
}

describe('space-handlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let spaceManager: SpaceManager;
  let taskRepo: SpaceTaskRepository;
  let runRepo: SpaceWorkflowRunRepository;

  function setup(
    space: Space | null = mockSpace,
    sessionManager?: SessionManager,
    spaceRuntimeService?: SpaceRuntimeService,
    agentManager?: SpaceAgentManager,
    workflowManager?: SpaceWorkflowManager
  ) {
    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    internalEventBus = createMockInternalEventBus();
    spaceManager = createMockSpaceManager(space);
    taskRepo = createMockTaskRepo();
    runRepo = createMockRunRepo();
    setupSpaceHandlers(
      hub,
      spaceManager,
      taskRepo,
      runRepo,
      internalEventBus,
      agentManager ?? createMockSpaceAgentManager(),
      workflowManager ?? createMockSpaceWorkflowManager(),
      sessionManager,
      spaceRuntimeService
    );
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  describe('space.create', () => {
    beforeEach(() => setup());

    it('creates a space and publishes space.created', async () => {
      const result = await call('space.create', {
        workspacePath: '/tmp/test',
        name: 'My Space',
      });

      expect(result).toEqual(mockSpace);
      expect(spaceManager.createSpace).toHaveBeenCalledTimes(1);
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.created', {
        sessionId: 'global',
        spaceId: mockSpace.id,
        space: mockSpace,
      });
    });

    it('throws when workspacePath is missing', async () => {
      await expect(call('space.create', { name: 'X' })).rejects.toThrow(
        'workspacePath is required'
      );
    });

    it('throws when name is missing', async () => {
      await expect(call('space.create', { workspacePath: '/tmp/x' })).rejects.toThrow(
        'name is required'
      );
    });

    it('throws when name is empty string', async () => {
      await expect(call('space.create', { workspacePath: '/tmp/x', name: '  ' })).rejects.toThrow(
        'name is required'
      );
    });

    it('propagates SpaceManager errors (e.g. invalid path)', async () => {
      (spaceManager.createSpace as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error('Workspace path does not exist: /nonexistent');
      });

      await expect(
        call('space.create', { workspacePath: '/nonexistent', name: 'Bad' })
      ).rejects.toThrow('Workspace path does not exist');
    });

    it('propagates duplicate path error from SpaceManager', async () => {
      (spaceManager.createSpace as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error('A space already exists for workspace path: /tmp/test');
      });

      await expect(
        call('space.create', { workspacePath: '/tmp/test', name: 'Dup' })
      ).rejects.toThrow('A space already exists');
    });

    it('throws when autonomyLevel is invalid', async () => {
      await expect(
        call('space.create', {
          workspacePath: '/tmp/x',
          name: 'X',
          autonomyLevel: 'fully_autonomous',
        })
      ).rejects.toThrow('Invalid autonomyLevel: fully_autonomous');
    });

    it('passes autonomyLevel=1 to SpaceManager', async () => {
      await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
        autonomyLevel: 1,
      });

      expect(spaceManager.createSpace).toHaveBeenCalledTimes(1);
      const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
      expect(params.autonomyLevel).toBe(1);
    });

    it('passes autonomyLevel=3 to SpaceManager', async () => {
      await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
        autonomyLevel: 3,
      });

      const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
      expect(params.autonomyLevel).toBe(3);
    });

    it('passes undefined autonomyLevel to SpaceManager when not specified', async () => {
      await call('space.create', { workspacePath: '/tmp/x', name: 'X' });

      const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
      expect(params.autonomyLevel).toBeUndefined();
    });

    it('creates space:chat:${spaceId} session when sessionManager is provided', async () => {
      const sessionManager = createMockSessionManager();
      setup(mockSpace, sessionManager);

      await call('space.create', { workspacePath: '/tmp/x', name: 'X' });

      expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
      const [params] = (sessionManager.createSession as ReturnType<typeof mock>).mock.calls[0];
      expect(params.sessionId).toBe(`space:chat:${mockSpace.id}`);
      expect(params.sessionType).toBe('space_chat');
      expect(params.spaceId).toBe(mockSpace.id);
      expect(params.title).toBe(mockSpace.name);
      expect(params.workspacePath).toBe(mockSpace.workspacePath);
      expect(params.createdBy).toBeUndefined();
    });

    it('does not create a session when sessionManager is omitted', async () => {
      setup(mockSpace);

      await call('space.create', { workspacePath: '/tmp/x', name: 'X' });

      expect(spaceManager.createSpace).toHaveBeenCalledTimes(1);
    });

    it('calls spaceManager.addSession to register the session on the space', async () => {
      const sessionManager = createMockSessionManager();
      setup(mockSpace, sessionManager);

      await call('space.create', { workspacePath: '/tmp/x', name: 'X' });

      expect(spaceManager.addSession).toHaveBeenCalledWith(
        mockSpace.id,
        `space:chat:${mockSpace.id}`
      );
    });

    it('calls setupSpaceAgentSession when spaceRuntimeService is provided', async () => {
      const sessionManager = createMockSessionManager();
      const runtimeService = createMockSpaceRuntimeService();
      setup(mockSpace, sessionManager, runtimeService);

      await call('space.create', { workspacePath: '/tmp/x', name: 'X' });

      expect(runtimeService.setupSpaceAgentSession).toHaveBeenCalledWith(mockSpace);
    });

    it('returns seedWarnings when some agents fail to seed', async () => {
      const agentMgr = createMockSpaceAgentManager({
        createFail: (name) => name === 'Coder' || name === 'QA',
      });
      setup(mockSpace, undefined, undefined, agentMgr);

      const result = (await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
      })) as SpaceCreateResult;

      expect(result.id).toBe(mockSpace.id);
      expect(result.seedWarnings).toBeDefined();
      expect(result.seedWarnings!.length).toBeGreaterThan(0);
      expect(result.seedWarnings!.some((w) => w.includes('Coder'))).toBe(true);
      expect(result.seedWarnings!.some((w) => w.includes('QA'))).toBe(true);
    });

    it('does not include seedWarnings when all agents seed successfully', async () => {
      setup(mockSpace);

      const result = await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
      });

      expect((result as Record<string, unknown>).seedWarnings).toBeUndefined();
    });

    it('returns seedWarnings when seedPresetAgents throws unexpectedly', async () => {
      const agentMgr = createMockSpaceAgentManager();
      (agentMgr.create as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error('Database locked');
      });
      setup(mockSpace, undefined, undefined, agentMgr);

      const result = (await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
      })) as SpaceCreateResult;

      expect(result.id).toBe(mockSpace.id);
      expect(result.seedWarnings).toBeDefined();
      expect(result.seedWarnings!.some((w) => w.includes('preset agents'))).toBe(true);
    });

    it('returns seedWarnings when workflow seeding fails', async () => {
      const agentMgr = createMockSpaceAgentManager();
      (agentMgr.listBySpaceId as ReturnType<typeof mock>).mockReturnValue([]);
      setup(mockSpace, undefined, undefined, agentMgr);

      const result = (await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
      })) as SpaceCreateResult;

      expect(result.id).toBe(mockSpace.id);
      expect(result.seedWarnings).toBeDefined();
      expect(result.seedWarnings!.some((w) => w.includes('workflows'))).toBe(true);
    });

    it('space creation succeeds even when both agents and workflows fail', async () => {
      const agentMgr = createMockSpaceAgentManager({
        createFail: () => true,
      });
      (agentMgr.listBySpaceId as ReturnType<typeof mock>).mockReturnValue([]);
      setup(mockSpace, undefined, undefined, agentMgr);

      const result = (await call('space.create', {
        workspacePath: '/tmp/x',
        name: 'X',
      })) as SpaceCreateResult;

      expect(result.id).toBe(mockSpace.id);
      expect(result.seedWarnings).toBeDefined();
      expect(result.seedWarnings!.length).toBe(2);
      expect(internalEventBus.publish).toHaveBeenCalledWith(
        'space.created',
        expect.objectContaining({ spaceId: mockSpace.id })
      );
    });

    it('still creates space and publishes event even if session creation fails', async () => {
      const sessionManager = createMockSessionManager();
      (sessionManager.createSession as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error('Session creation failed');
      });
      setup(mockSpace, sessionManager);

      const result = await call('space.create', { workspacePath: '/tmp/x', name: 'X' });
      expect(result).toEqual(mockSpace);
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.created', {
        sessionId: 'global',
        spaceId: mockSpace.id,
        space: mockSpace,
      });
    });
  });

  describe('space.list', () => {
    beforeEach(() => setup());

    it('lists active spaces by default', async () => {
      const result = await call('space.list', {});
      expect(result).toEqual([mockSpace]);
      expect(spaceManager.listSpaces).toHaveBeenCalledWith(false);
    });

    it('lists including archived when requested', async () => {
      await call('space.list', { includeArchived: true });
      expect(spaceManager.listSpaces).toHaveBeenCalledWith(true);
    });

    it('accepts null/undefined data', async () => {
      await call('space.list', null);
      expect(spaceManager.listSpaces).toHaveBeenCalledWith(false);
    });
  });

  describe('space.get', () => {
    beforeEach(() => setup());

    it('returns the space when found', async () => {
      const result = await call('space.get', { id: 'space-1' });
      expect(result).toEqual(mockSpace);
    });

    it('throws when id and slug are both missing', async () => {
      await expect(call('space.get', {})).rejects.toThrow('id or slug is required');
    });

    it('throws when space is not found', async () => {
      setup(null);
      await expect(call('space.get', { id: 'nope' })).rejects.toThrow('Space not found: nope');
    });
  });

  describe('space.update', () => {
    beforeEach(() => setup());

    it('updates the space and publishes space.updated', async () => {
      const updated = { ...mockSpace, name: 'Renamed' };
      (spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updated);

      const result = await call('space.update', { id: 'space-1', name: 'Renamed' });

      expect(result).toEqual(updated);
      expect(spaceManager.updateSpace).toHaveBeenCalledWith('space-1', { name: 'Renamed' });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: updated,
      });
    });

    it('throws when id is missing', async () => {
      await expect(call('space.update', { name: 'X' })).rejects.toThrow('id is required');
    });

    it('propagates errors from SpaceManager', async () => {
      (spaceManager.updateSpace as ReturnType<typeof mock>).mockRejectedValue(
        new Error('Space not found: bad-id')
      );

      await expect(call('space.update', { id: 'bad-id', name: 'X' })).rejects.toThrow(
        'Space not found'
      );
    });

    it('throws when autonomyLevel is invalid', async () => {
      await expect(
        call('space.update', { id: 'space-1', autonomyLevel: 'fully_autonomous' })
      ).rejects.toThrow('Invalid autonomyLevel: fully_autonomous');
    });

    it('passes autonomyLevel=3 to SpaceManager.updateSpace', async () => {
      await call('space.update', { id: 'space-1', autonomyLevel: 3 });

      expect(spaceManager.updateSpace).toHaveBeenCalledTimes(1);
      const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
      expect(params.autonomyLevel).toBe(3);
    });

    it('passes autonomyLevel=1 to SpaceManager.updateSpace', async () => {
      await call('space.update', { id: 'space-1', autonomyLevel: 1 });

      const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
      expect(params.autonomyLevel).toBe(1);
    });

    it('does not set autonomyLevel in updateParams when not provided', async () => {
      await call('space.update', { id: 'space-1', name: 'New Name' });

      const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
      expect(params.autonomyLevel).toBeUndefined();
    });
  });

  describe('space.setConcurrentLimit', () => {
    beforeEach(() => setup());

    it('updates maxConcurrentTasks and publishes space.updated', async () => {
      const updated = { ...mockSpace, maxConcurrentTasks: 4 };
      (spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updated);

      const result = await call('space.setConcurrentLimit', { spaceId: 'space-1', limit: 4 });

      expect(result).toEqual(updated);
      expect(spaceManager.updateSpace).toHaveBeenCalledWith('space-1', { maxConcurrentTasks: 4 });
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: updated,
      });
    });

    it('accepts id as a backwards-compatible alias for spaceId', async () => {
      await call('space.setConcurrentLimit', { id: 'space-1', limit: 2 });

      expect(spaceManager.updateSpace).toHaveBeenCalledWith('space-1', { maxConcurrentTasks: 2 });
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('space.setConcurrentLimit', { limit: 2 })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when limit is below 1', async () => {
      await expect(
        call('space.setConcurrentLimit', { spaceId: 'space-1', limit: 0 })
      ).rejects.toThrow('Invalid concurrent task limit');
    });

    it('throws when limit is above 20', async () => {
      await expect(
        call('space.setConcurrentLimit', { spaceId: 'space-1', limit: 21 })
      ).rejects.toThrow('Invalid concurrent task limit');
    });

    it('throws when limit is non-integer', async () => {
      await expect(
        call('space.setConcurrentLimit', { spaceId: 'space-1', limit: 1.5 })
      ).rejects.toThrow('Invalid concurrent task limit');
    });

    it('propagates not-found errors from SpaceManager', async () => {
      (spaceManager.updateSpace as ReturnType<typeof mock>).mockRejectedValue(
        new Error('Space not found: missing')
      );

      await expect(
        call('space.setConcurrentLimit', { spaceId: 'missing', limit: 2 })
      ).rejects.toThrow('Space not found');
    });
  });

  describe('space.archive', () => {
    beforeEach(() => setup());

    it('archives the space and emits dedicated space.archived event with full space', async () => {
      const archivedSpace = { ...mockSpace, status: 'archived' as const };
      (spaceManager.archiveSpace as ReturnType<typeof mock>).mockResolvedValue(archivedSpace);

      const result = await call('space.archive', { id: 'space-1' });

      expect((result as Space).status).toBe('archived');
      expect(spaceManager.archiveSpace).toHaveBeenCalledWith('space-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.archived', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: archivedSpace,
      });
    });

    it('does NOT emit space.updated on archive', async () => {
      await call('space.archive', { id: 'space-1' });

      const calls = (internalEventBus.publish as ReturnType<typeof mock>).mock.calls;
      const updatedCall = calls.find((c: unknown[]) => c[0] === 'space.updated');
      expect(updatedCall).toBeUndefined();
    });

    it('throws when id is missing', async () => {
      await expect(call('space.archive', {})).rejects.toThrow('id is required');
    });

    it('propagates errors from SpaceManager', async () => {
      (spaceManager.archiveSpace as ReturnType<typeof mock>).mockRejectedValue(
        new Error('Space not found: nope')
      );

      await expect(call('space.archive', { id: 'nope' })).rejects.toThrow('Space not found');
    });
  });

  describe('space.stop', () => {
    let mockRuntimeService: SpaceRuntimeService;

    beforeEach(() => {
      mockRuntimeService = {
        setupSpaceAgentSession: mock(async () => {}),
        stopActiveWork: mock(async () => {}),
      } as unknown as SpaceRuntimeService;
      setup(mockSpace, undefined, mockRuntimeService);
    });

    it('marks the space stopped before quiescing active work and publishes space.updated', async () => {
      const stoppedSpace = { ...mockSpace, stopped: true };
      const callOrder: string[] = [];
      (spaceManager.stopSpace as ReturnType<typeof mock>).mockImplementation(async () => {
        callOrder.push('stopSpace');
        return stoppedSpace;
      });
      (mockRuntimeService.stopActiveWork as ReturnType<typeof mock>).mockImplementation(
        async () => {
          callOrder.push('stopActiveWork');
        }
      );

      const result = await call('space.stop', { id: 'space-1' });

      expect(callOrder).toEqual(['stopSpace', 'stopActiveWork']);
      expect(mockRuntimeService.stopActiveWork).toHaveBeenCalledWith('space-1');
      expect(spaceManager.stopSpace).toHaveBeenCalledWith('space-1');
      expect((result as Space).stopped).toBe(true);
      expect((result as Space).status).toBe('active');
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: stoppedSpace,
      });
    });

    it('works without runtime service (graceful degradation)', async () => {
      setup(mockSpace, undefined, undefined);
      const stoppedSpace = { ...mockSpace, stopped: true };
      (spaceManager.stopSpace as ReturnType<typeof mock>).mockResolvedValue(stoppedSpace);

      const result = await call('space.stop', { id: 'space-1' });

      expect((result as Space).stopped).toBe(true);
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: stoppedSpace,
      });
    });

    it('throws when id is missing', async () => {
      await expect(call('space.stop', {})).rejects.toThrow('id is required');
    });
  });

  describe('space.start', () => {
    beforeEach(() => setup());

    it('clears stopped flag and publishes space.updated', async () => {
      const startedSpace = { ...mockSpace, stopped: false, paused: false };
      (spaceManager.startSpace as ReturnType<typeof mock>).mockResolvedValue(startedSpace);

      const result = await call('space.start', { id: 'space-1' });

      expect(spaceManager.startSpace).toHaveBeenCalledWith('space-1');
      expect((result as Space).stopped).toBe(false);
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: startedSpace,
      });
    });

    it('throws when id is missing', async () => {
      await expect(call('space.start', {})).rejects.toThrow('id is required');
    });
  });

  describe('space.delete', () => {
    beforeEach(() => setup());

    it('deletes the space and publishes space.deleted', async () => {
      const result = await call('space.delete', { id: 'space-1' });

      expect(result).toEqual({ success: true });
      expect(spaceManager.deleteSpace).toHaveBeenCalledWith('space-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.deleted', {
        sessionId: 'global',
        spaceId: 'space-1',
      });
    });

    it('throws when id is missing', async () => {
      await expect(call('space.delete', {})).rejects.toThrow('id is required');
    });

    it('throws when space is not found (deleteSpace returns false)', async () => {
      (spaceManager.deleteSpace as ReturnType<typeof mock>).mockResolvedValue(false);

      await expect(call('space.delete', { id: 'ghost' })).rejects.toThrow('Space not found: ghost');
    });
  });

  describe('space.overview', () => {
    beforeEach(() => setup());

    it('returns space, tasks, workflowRuns, and sessions', async () => {
      const result = (await call('space.overview', { id: 'space-1' })) as {
        space: Space;
        tasks: SpaceTask[];
        workflowRuns: SpaceWorkflowRun[];
        sessions: string[];
      };

      expect(result.space).toEqual(mockSpace);
      expect(result.tasks).toEqual([mockTask]);
      expect(result.workflowRuns).toEqual([mockRun]);
      expect(result.sessions).toEqual(mockSpace.sessionIds);
    });

    it('throws when id and slug are both missing', async () => {
      await expect(call('space.overview', {})).rejects.toThrow('id or slug is required');
    });

    it('throws when space is not found', async () => {
      setup(null);
      await expect(call('space.overview', { id: 'ghost' })).rejects.toThrow(
        'Space not found: ghost'
      );
    });
  });

  describe('space.pause', () => {
    beforeEach(() => setup());

    it('pauses a space and publishes space.updated', async () => {
      const result = (await call('space.pause', { id: 'space-1' })) as Space;

      expect(result.paused).toBe(true);
      expect(spaceManager.pauseSpace).toHaveBeenCalledWith('space-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: result,
      });
    });

    it('throws when id is missing', async () => {
      await expect(call('space.pause', {})).rejects.toThrow('id is required');
    });
  });

  describe('space.resume', () => {
    beforeEach(() => setup());

    it('resumes a space and publishes space.updated', async () => {
      const result = (await call('space.resume', { id: 'space-1' })) as Space;

      expect(result.paused).toBe(false);
      expect(spaceManager.resumeSpace).toHaveBeenCalledWith('space-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('space.updated', {
        sessionId: 'global',
        spaceId: 'space-1',
        space: result,
      });
    });

    it('throws when id is missing', async () => {
      await expect(call('space.resume', {})).rejects.toThrow('id is required');
    });
  });

  describe('space.workspace.list', () => {
    beforeEach(() => setup());

    it('returns the workspaces of the space', async () => {
      const result = await call('space.workspace.list', { spaceId: 'space-1' });

      expect(result).toEqual([mockWorkspace]);
      expect(spaceManager.listWorkspaces).toHaveBeenCalledWith('space-1');
    });

    it('propagates unknown-space errors from the manager', async () => {
      (spaceManager.listWorkspaces as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error('Space not found: ghost');
      });

      await expect(call('space.workspace.list', { spaceId: 'ghost' })).rejects.toThrow(
        'Space not found: ghost'
      );
    });
  });

  describe('space.workspace.add', () => {
    beforeEach(() => setup());

    it('registers the workspace and returns the record', async () => {
      const result = await call('space.workspace.add', {
        spaceId: 'space-1',
        path: '/tmp/other-repo',
        label: 'other-repo',
      });

      expect(result).toEqual(mockWorkspace);
      expect(spaceManager.registerWorkspace).toHaveBeenCalledWith(
        'space-1',
        '/tmp/other-repo',
        'other-repo'
      );
    });

    it('forwards an undefined label when none is provided', async () => {
      await call('space.workspace.add', { spaceId: 'space-1', path: '/tmp/other-repo' });

      expect(spaceManager.registerWorkspace).toHaveBeenCalledWith(
        'space-1',
        '/tmp/other-repo',
        undefined
      );
    });

    it('rejects paths already claimed by another space', async () => {
      (spaceManager.registerWorkspace as ReturnType<typeof mock>).mockImplementation(async () => {
        throw registrationError(
          'path_claimed_by_another_space',
          'Workspace path is already claimed by space space-2: /tmp/other-repo'
        );
      });

      await expect(
        call('space.workspace.add', { spaceId: 'space-1', path: '/tmp/other-repo' })
      ).rejects.toThrow('already claimed by space space-2');
    });

    it('rejects paths that are not git repository roots', async () => {
      (spaceManager.registerWorkspace as ReturnType<typeof mock>).mockImplementation(async () => {
        throw registrationError(
          'not_a_git_repository_root',
          'Workspace path is not a git repository root: /tmp/plain-dir'
        );
      });

      await expect(
        call('space.workspace.add', { spaceId: 'space-1', path: '/tmp/plain-dir' })
      ).rejects.toThrow('not a git repository root');
    });
  });

  describe('space.workspace.remove', () => {
    beforeEach(() => setup());

    it('removes the workspace and returns success', async () => {
      const result = await call('space.workspace.remove', {
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      });

      expect(result).toEqual({ success: true });
      expect(spaceManager.removeWorkspace).toHaveBeenCalledWith('space-1', 'ws-1');
    });

    it('throws when the manager reports the workspace missing', async () => {
      (spaceManager.removeWorkspace as ReturnType<typeof mock>).mockImplementation(() => false);

      await expect(
        call('space.workspace.remove', { spaceId: 'space-1', workspaceId: 'ws-ghost' })
      ).rejects.toThrow('Workspace not found: ws-ghost');
    });

    it('rejects removal of the primary workspace', async () => {
      (spaceManager.removeWorkspace as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkspaceRemovalBlockedError(
          'Cannot remove the primary workspace of space space-1',
          'primary'
        );
      });

      await expect(
        call('space.workspace.remove', { spaceId: 'space-1', workspaceId: 'ws-1' })
      ).rejects.toThrow('Cannot remove the primary workspace');
    });

    it('rejects removal while active sessions reference the workspace', async () => {
      (spaceManager.removeWorkspace as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkspaceRemovalBlockedError(
          'Cannot remove workspace ws-2 while 2 active sessions reference it',
          'active_sessions'
        );
      });

      await expect(
        call('space.workspace.remove', { spaceId: 'space-1', workspaceId: 'ws-2' })
      ).rejects.toThrow('2 active sessions reference it');
    });
  });
});
