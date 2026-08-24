import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { configureLogger, LogLevel, MessageHub, subscribeToStructuredLogs } from '@hyperneo/shared';
import type { Space, SpaceWorkflow } from '@hyperneo/shared';
import {
  setupSpaceWorkflowHandlers,
  checkBuiltInWorkflowDriftOnStartup,
} from '../../../../src/lib/rpc-handlers/space-workflow-handlers';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceWorkflowSummary } from '@hyperneo/shared';
import {
  WorkflowValidationError,
  WorkflowDeletionBlockedError,
} from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { computeWorkflowHash } from '../../../../src/lib/space/workflows/template-hash';
import { getBuiltInWorkflows } from '../../../../src/lib/space/workflows/built-in-workflows';

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
  id: 'wf-1',
  spaceId: 'space-1',
  name: 'Test Workflow',
  description: 'A test workflow',
  nodes: [
    {
      id: 'step-1',
      name: 'Code',
      agents: [{ agentId: 'agent-uuid-1', name: 'coder' }],
    },
  ],
  startNodeId: 'step-1',
  tags: [],
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
  workflow: SpaceWorkflow | null = mockWorkflow
): SpaceWorkflowManager {
  return {
    createWorkflow: mock(() => workflow!),
    getWorkflow: mock(() => workflow),
    getWorkflowByHandle: mock(() => workflow),
    listWorkflows: mock(() => (workflow ? [workflow] : [])),
    listWorkflowSummaries: mock(() =>
      workflow
        ? [
            {
              id: workflow.id,
              spaceId: workflow.spaceId,
              name: workflow.name,
              description: workflow.description,
              tags: workflow.tags ?? [],
              templateName: workflow.templateName,
              templateHash: workflow.templateHash ?? null,
              disabled: workflow.disabled,
              nodeCount: workflow.nodes?.length ?? 0,
              completionAutonomyLevel: workflow.completionAutonomyLevel ?? 3,
              createdAt: workflow.createdAt,
              updatedAt: workflow.updatedAt,
            },
          ]
        : []
    ),
    updateWorkflow: mock(() => ({ ...workflow!, name: 'Updated' })),
    deleteWorkflow: mock(() => true),
    hasExecutableRuns: mock(() => false),
  } as unknown as SpaceWorkflowManager;
}

function createMockSpaceAgentManager(
  agents: Array<{ id: string; name: string }> = []
): SpaceAgentManager {
  return {
    listBySpaceId: mock(() => agents),
  } as unknown as SpaceAgentManager;
}

function createMockWorkflowRunRepo(): SpaceWorkflowRunRepository {
  return {
    deleteByWorkflowId: mock(() => 0),
  } as unknown as SpaceWorkflowRunRepository;
}

describe('space-workflow-handlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let spaceManager: SpaceManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceAgentManager: SpaceAgentManager;
  let workflowRunRepo: SpaceWorkflowRunRepository;

  function setup(
    space: Space | null = mockSpace,
    workflow: SpaceWorkflow | null = mockWorkflow,
    agents: Array<{ id: string; name: string }> = []
  ) {
    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    internalEventBus = createMockInternalEventBus<DaemonInternalEventMap>();
    spaceManager = createMockSpaceManager(space);
    workflowManager = createMockWorkflowManager(workflow);
    spaceAgentManager = createMockSpaceAgentManager(agents);
    workflowRunRepo = createMockWorkflowRunRepo();
    setupSpaceWorkflowHandlers(
      hub,
      spaceManager,
      workflowManager,
      internalEventBus,
      spaceAgentManager,
      workflowRunRepo
    );
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  describe('spaceWorkflow.create', () => {
    beforeEach(() => setup());

    it('creates a workflow and emits spaceWorkflow.created', async () => {
      const result = (await call('spaceWorkflow.create', {
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [{ name: 'Code', agentId: 'agent-uuid-1' }],
      })) as { workflow: SpaceWorkflow };

      expect(result.workflow).toEqual(mockWorkflow);
      expect(workflowManager.createWorkflow).toHaveBeenCalledTimes(1);
      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceWorkflow.created', {
        sessionId: 'global',
        spaceId: 'space-1',
        workflow: mockWorkflow,
      });
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceWorkflow.create', { name: 'Wf' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when name is missing', async () => {
      await expect(call('spaceWorkflow.create', { spaceId: 'space-1' })).rejects.toThrow(
        'name is required'
      );
    });

    it('throws when name is empty string', async () => {
      await expect(
        call('spaceWorkflow.create', { spaceId: 'space-1', name: '   ' })
      ).rejects.toThrow('name is required');
    });

    it('throws when space not found', async () => {
      setup(null);
      await expect(call('spaceWorkflow.create', { spaceId: 'ghost', name: 'Wf' })).rejects.toThrow(
        'Space not found: ghost'
      );
      expect(workflowManager.createWorkflow).not.toHaveBeenCalled();
    });

    it('propagates WorkflowValidationError from manager', async () => {
      (workflowManager.createWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkflowValidationError(
          'A workflow named "Test Workflow" already exists in this space'
        );
      });

      await expect(
        call('spaceWorkflow.create', {
          spaceId: 'space-1',
          name: 'Test Workflow',
          nodes: [{ name: 'Code', agentId: 'agent-uuid-1' }],
        })
      ).rejects.toThrow('already exists in this space');
    });

    it('propagates step validation error from manager', async () => {
      (workflowManager.createWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkflowValidationError('A workflow must have at least one step');
      });

      await expect(
        call('spaceWorkflow.create', {
          spaceId: 'space-1',
          name: 'Empty',
          nodes: [],
        })
      ).rejects.toThrow('at least one step');
    });
  });

  describe('spaceWorkflow.list', () => {
    beforeEach(() => setup());

    it('lists workflows for a space', async () => {
      const result = (await call('spaceWorkflow.list', { spaceId: 'space-1' })) as {
        workflows: SpaceWorkflowSummary[];
      };
      expect(result.workflows).toEqual([
        {
          id: mockWorkflow.id,
          spaceId: mockWorkflow.spaceId,
          name: mockWorkflow.name,
          description: mockWorkflow.description,
          tags: mockWorkflow.tags ?? [],
          templateName: mockWorkflow.templateName,
          templateHash: mockWorkflow.templateHash ?? null,
          disabled: mockWorkflow.disabled,
          nodeCount: mockWorkflow.nodes?.length ?? 0,
          completionAutonomyLevel: mockWorkflow.completionAutonomyLevel ?? 3,
          createdAt: mockWorkflow.createdAt,
          updatedAt: mockWorkflow.updatedAt,
        },
      ]);
      expect(workflowManager.listWorkflowSummaries).toHaveBeenCalledWith('space-1');
    });

    it('throws when spaceId is missing', async () => {
      await expect(call('spaceWorkflow.list', {})).rejects.toThrow('spaceId is required');
    });

    it('throws when space not found', async () => {
      setup(null);
      await expect(call('spaceWorkflow.list', { spaceId: 'ghost' })).rejects.toThrow(
        'Space not found: ghost'
      );
      expect(workflowManager.listWorkflows).not.toHaveBeenCalled();
    });

    it('returns empty list when space has no workflows', async () => {
      setup(mockSpace, null);
      const result = (await call('spaceWorkflow.list', { spaceId: 'space-1' })) as {
        workflows: SpaceWorkflow[];
      };
      expect(result.workflows).toEqual([]);
    });
  });

  describe('spaceWorkflow.get', () => {
    beforeEach(() => setup());

    it('returns the workflow when found (no spaceId)', async () => {
      const result = (await call('spaceWorkflow.get', { id: 'wf-1' })) as {
        workflow: SpaceWorkflow;
      };
      expect(result.workflow).toEqual(mockWorkflow);
      expect(workflowManager.getWorkflow).toHaveBeenCalledWith('wf-1');
    });

    it('accepts matching optional spaceId', async () => {
      const result = (await call('spaceWorkflow.get', {
        id: 'wf-1',
        spaceId: 'space-1',
      })) as { workflow: SpaceWorkflow };
      expect(result.workflow).toEqual(mockWorkflow);
    });

    it('throws Space not found when spaceId is provided but space does not exist', async () => {
      setup(null, mockWorkflow);
      await expect(
        call('spaceWorkflow.get', { id: 'wf-1', spaceId: 'deleted-space' })
      ).rejects.toThrow('Space not found: deleted-space');
      expect(workflowManager.getWorkflow).not.toHaveBeenCalled();
    });

    it('throws when spaceId does not match workflow owner', async () => {
      await expect(
        call('spaceWorkflow.get', { id: 'wf-1', spaceId: 'space-other' })
      ).rejects.toThrow('Workflow not found: wf-1');
    });

    it('throws when id is missing', async () => {
      await expect(call('spaceWorkflow.get', {})).rejects.toThrow('id or handle is required');
    });

    it('throws when workflow not found by id', async () => {
      setup(mockSpace, null);
      await expect(call('spaceWorkflow.get', { id: 'ghost' })).rejects.toThrow(
        'Workflow not found: ghost'
      );
    });

    it('returns workflow by handle when handle and spaceId are provided', async () => {
      const result = (await call('spaceWorkflow.get', {
        handle: 'test-workflow',
        spaceId: 'space-1',
      })) as { workflow: SpaceWorkflow };
      expect(result.workflow).toEqual(mockWorkflow);
      expect(workflowManager.getWorkflowByHandle).toHaveBeenCalledWith('space-1', 'test-workflow');
    });

    it('throws when handle is provided but spaceId is missing', async () => {
      await expect(call('spaceWorkflow.get', { handle: 'test-workflow' })).rejects.toThrow(
        'spaceId is required when looking up by handle'
      );
    });

    it('throws when workflow not found by handle', async () => {
      setup(mockSpace, null);
      await expect(
        call('spaceWorkflow.get', { handle: 'ghost', spaceId: 'space-1' })
      ).rejects.toThrow('Workflow not found: ghost');
    });

    it('falls back to handle when id lookup misses and both id and handle+spaceId are provided', async () => {
      setup(mockSpace, null);
      (workflowManager.getWorkflowByHandle as ReturnType<typeof mock>).mockReturnValue(
        mockWorkflow
      );

      const result = (await call('spaceWorkflow.get', {
        id: 'stale-id',
        handle: 'test-workflow',
        spaceId: 'space-1',
      })) as { workflow: SpaceWorkflow };

      expect(result.workflow).toEqual(mockWorkflow);
      expect(workflowManager.getWorkflow).toHaveBeenCalledWith('stale-id');
      expect(workflowManager.getWorkflowByHandle).toHaveBeenCalledWith('space-1', 'test-workflow');
    });

    it('falls back to handle when id resolves to a workflow in a different space', async () => {
      const crossSpaceWorkflow: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-other',
        spaceId: 'space-other',
      };
      setup(mockSpace, crossSpaceWorkflow);
      (workflowManager.getWorkflowByHandle as ReturnType<typeof mock>).mockReturnValue(
        mockWorkflow
      );

      const result = (await call('spaceWorkflow.get', {
        id: 'wf-other',
        handle: 'test-workflow',
        spaceId: 'space-1',
      })) as { workflow: SpaceWorkflow };

      expect(result.workflow).toEqual(mockWorkflow);
      expect(workflowManager.getWorkflow).toHaveBeenCalledWith('wf-other');
      expect(workflowManager.getWorkflowByHandle).toHaveBeenCalledWith('space-1', 'test-workflow');
    });

    it('throws when id is cross-space and no handle is provided', async () => {
      const crossSpaceWorkflow: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-other',
        spaceId: 'space-other',
      };
      setup(mockSpace, crossSpaceWorkflow);

      await expect(
        call('spaceWorkflow.get', { id: 'wf-other', spaceId: 'space-1' })
      ).rejects.toThrow('Workflow not found: wf-other');
    });
  });

  describe('spaceWorkflow.update', () => {
    beforeEach(() => setup());

    it('updates a workflow and emits spaceWorkflow.updated', async () => {
      const updated = { ...mockWorkflow, name: 'Updated' };
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(updated);

      const result = (await call('spaceWorkflow.update', {
        id: 'wf-1',
        name: 'Updated',
      })) as { workflow: SpaceWorkflow };

      expect(result.workflow.name).toBe('Updated');
      expect(workflowManager.updateWorkflow).toHaveBeenCalledWith('wf-1', { name: 'Updated' });
      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceWorkflow.updated', {
        sessionId: 'global',
        spaceId: updated.spaceId,
        workflow: updated,
      });
    });

    it('throws Space not found when spaceId is provided but space does not exist', async () => {
      setup(null, mockWorkflow);
      await expect(
        call('spaceWorkflow.update', { id: 'wf-1', spaceId: 'deleted-space', name: 'X' })
      ).rejects.toThrow('Space not found: deleted-space');
      expect(workflowManager.getWorkflow).not.toHaveBeenCalled();
      expect(workflowManager.updateWorkflow).not.toHaveBeenCalled();
    });

    it('rejects when optional spaceId does not match workflow owner', async () => {
      await expect(
        call('spaceWorkflow.update', { id: 'wf-1', spaceId: 'space-other', name: 'X' })
      ).rejects.toThrow('Workflow not found: wf-1');
      expect(workflowManager.updateWorkflow).not.toHaveBeenCalled();
    });

    it('throws when id is missing', async () => {
      await expect(call('spaceWorkflow.update', { name: 'X' })).rejects.toThrow('id is required');
    });

    it('throws when workflow not found', async () => {
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(null);
      await expect(call('spaceWorkflow.update', { id: 'ghost', name: 'X' })).rejects.toThrow(
        'Workflow not found: ghost'
      );
      expect(internalEventBus.publish).not.toHaveBeenCalled();
    });

    it('propagates WorkflowValidationError from manager (e.g. duplicate name)', async () => {
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkflowValidationError('A workflow named "Dupe" already exists in this space');
      });

      await expect(call('spaceWorkflow.update', { id: 'wf-1', name: 'Dupe' })).rejects.toThrow(
        'already exists in this space'
      );
    });

    it('propagates step validation error (unknown agentId)', async () => {
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkflowValidationError(
          'step[0]: agentId "unknown-uuid" does not match any SpaceWorkerAgent in this space'
        );
      });

      await expect(
        call('spaceWorkflow.update', {
          id: 'wf-1',
          nodes: [{ id: 's1', name: 'Lead', agentId: 'unknown-uuid', order: 0 }],
        })
      ).rejects.toThrow('does not match any SpaceWorkerAgent in this space');
    });
  });

  describe('spaceWorkflow.delete', () => {
    beforeEach(() => setup());

    it('deletes a workflow and emits spaceWorkflow.deleted', async () => {
      const result = (await call('spaceWorkflow.delete', { id: 'wf-1' })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(workflowManager.deleteWorkflow).toHaveBeenCalledWith('wf-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceWorkflow.deleted', {
        sessionId: 'global',
        spaceId: mockWorkflow.spaceId,
        workflowId: 'wf-1',
      });
    });

    it('throws Space not found when spaceId is provided but space does not exist', async () => {
      setup(null, mockWorkflow);
      await expect(
        call('spaceWorkflow.delete', { id: 'wf-1', spaceId: 'deleted-space' })
      ).rejects.toThrow('Space not found: deleted-space');
      expect(workflowManager.getWorkflow).not.toHaveBeenCalled();
      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
      expect(internalEventBus.publish).not.toHaveBeenCalled();
    });

    it('rejects when optional spaceId does not match workflow owner', async () => {
      await expect(
        call('spaceWorkflow.delete', { id: 'wf-1', spaceId: 'space-other' })
      ).rejects.toThrow('Workflow not found: wf-1');
      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
      expect(internalEventBus.publish).not.toHaveBeenCalled();
    });

    it('throws when id is missing', async () => {
      await expect(call('spaceWorkflow.delete', {})).rejects.toThrow('id is required');
    });

    it('throws when workflow not found (getWorkflow returns null)', async () => {
      setup(mockSpace, null);
      await expect(call('spaceWorkflow.delete', { id: 'ghost' })).rejects.toThrow(
        'Workflow not found: ghost'
      );
      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
      expect(internalEventBus.publish).not.toHaveBeenCalled();
    });

    it('throws when deleteWorkflow returns false', async () => {
      (workflowManager.deleteWorkflow as ReturnType<typeof mock>).mockReturnValue(false);

      await expect(call('spaceWorkflow.delete', { id: 'wf-1' })).rejects.toThrow(
        'Workflow not found: wf-1'
      );
    });

    it('propagates WorkflowDeletionBlockedError and does NOT emit deleted (RFC §4 #3)', async () => {
      (workflowManager.deleteWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
        throw new WorkflowDeletionBlockedError('blocked: executable run', 'wf-1');
      });

      await expect(call('spaceWorkflow.delete', { id: 'wf-1' })).rejects.toThrow(
        /executable|not archived/
      );
      expect(internalEventBus.publish).not.toHaveBeenCalledWith(
        'spaceWorkflow.deleted',
        expect.anything()
      );
    });
  });

  describe('spaceWorkflow.setDefault', () => {
    beforeEach(() => setup());

    it('does not register spaceWorkflow.setDefault (removed from design)', () => {
      expect(handlers.has('spaceWorkflow.setDefault')).toBe(false);
    });
  });

  describe('spaceWorkflow.detectDrift', () => {
    it('returns neither signal with null hashes when workflow has no templateName', async () => {
      const wfNoTemplate: SpaceWorkflow = {
        ...mockWorkflow,
        templateName: undefined,
        templateHash: undefined,
      };
      setup(mockSpace, wfNoTemplate);
      const result = (await call('spaceWorkflow.detectDrift', { id: 'wf-1' })) as Record<
        string,
        unknown
      >;
      expect(result.updateAvailable).toBe(false);
      expect(result.customized).toBe(false);
      expect(result.templateName).toBeNull();
      expect(result.currentTemplateHash).toBeNull();
      expect(result.workflowContentHash).toBeNull();
      expect(result.storedHash).toBeNull();
    });

    it('returns neither signal when template is not found in built-ins', async () => {
      const wfUnknownTemplate: SpaceWorkflow = {
        ...mockWorkflow,
        templateName: 'Unknown Template',
        templateHash: 'abc123',
      };
      setup(mockSpace, wfUnknownTemplate);
      const result = (await call('spaceWorkflow.detectDrift', { id: 'wf-1' })) as Record<
        string,
        unknown
      >;
      expect(result.updateAvailable).toBe(false);
      expect(result.customized).toBe(false);
      expect(result.templateName).toBe('Unknown Template');
      expect(result.storedHash).toBe('abc123');
    });

    it('returns neither signal when workflow matches template and stored hash (pristine)', async () => {
      const [template] = getBuiltInWorkflows();
      const hash = computeWorkflowHash(template);
      const wfMatching: SpaceWorkflow = {
        ...template,
        id: 'wf-1',
        spaceId: 'space-1',
        templateName: template.name,
        templateHash: hash,
      };
      setup(mockSpace, wfMatching);
      const result = (await call('spaceWorkflow.detectDrift', { id: 'wf-1' })) as Record<
        string,
        unknown
      >;
      expect(result.updateAvailable).toBe(false);
      expect(result.customized).toBe(false);
      expect(result.templateName).toBe(template.name);
      expect(result.storedHash).toBe(hash);
    });

    it('returns updateAvailable only when the template moved but the row is at its stored version', async () => {
      const [template] = getBuiltInWorkflows();
      const currentHash = computeWorkflowHash(template);
      const oldVersion = { ...template, instructions: `${template.instructions ?? ''}\n[old]` };
      const oldHash = computeWorkflowHash(oldVersion);
      const wfStale: SpaceWorkflow = {
        ...oldVersion,
        id: 'wf-1',
        spaceId: 'space-1',
        templateName: template.name,
        templateHash: oldHash,
      };
      setup(mockSpace, wfStale);
      const result = (await call('spaceWorkflow.detectDrift', { id: 'wf-1' })) as Record<
        string,
        unknown
      >;
      expect(result.updateAvailable).toBe(true);
      expect(result.customized).toBe(false);
      expect(result.currentTemplateHash).toBe(currentHash);
      expect(result.workflowContentHash).toBe(oldHash);
      expect(result.storedHash).toBe(oldHash);
    });

    it('returns customized only when the workflow was edited but the template did not move', async () => {
      const [template] = getBuiltInWorkflows();
      const templateHash = computeWorkflowHash(template);
      const wfEdited: SpaceWorkflow = {
        ...template,
        id: 'wf-1',
        spaceId: 'space-1',
        nodes: [
          ...template.nodes,
          { id: 'extra', name: 'Extra Node', agents: [{ agentId: 'a', name: 'A' }] },
        ],
        templateName: template.name,
        templateHash,
      };
      setup(mockSpace, wfEdited);
      const result = (await call('spaceWorkflow.detectDrift', { id: 'wf-1' })) as Record<
        string,
        unknown
      >;
      expect(result.updateAvailable).toBe(false);
      expect(result.customized).toBe(true);
    });

    it('returns both signals when the template moved AND the row was edited', async () => {
      const [template] = getBuiltInWorkflows();
      const oldVersion = { ...template, instructions: `${template.instructions ?? ''}\n[old]` };
      const wfBoth: SpaceWorkflow = {
        ...oldVersion,
        id: 'wf-1',
        spaceId: 'space-1',
        nodes: [
          ...oldVersion.nodes,
          { id: 'extra', name: 'Extra Node', agents: [{ agentId: 'a', name: 'A' }] },
        ],
        templateName: template.name,
        templateHash: 'stale-hash',
      };
      setup(mockSpace, wfBoth);
      const result = (await call('spaceWorkflow.detectDrift', { id: 'wf-1' })) as Record<
        string,
        unknown
      >;
      expect(result.updateAvailable).toBe(true);
      expect(result.customized).toBe(true);
    });

    it('throws when id is missing', async () => {
      setup();
      await expect(call('spaceWorkflow.detectDrift', {})).rejects.toThrow('id is required');
    });

    it('throws when workflow not found', async () => {
      setup(mockSpace, null);
      await expect(call('spaceWorkflow.detectDrift', { id: 'ghost' })).rejects.toThrow(
        'Workflow not found: ghost'
      );
    });

    it('throws when spaceId provided but workflow belongs to different space', async () => {
      setup(mockSpace, mockWorkflow);
      await expect(
        call('spaceWorkflow.detectDrift', { id: 'wf-1', spaceId: 'other-space' })
      ).rejects.toThrow('Workflow not found: wf-1');
    });
  });

  describe('spaceWorkflow.previewTemplateSync', () => {
    it('registers the handler', () => {
      setup();
      expect(handlers.has('spaceWorkflow.previewTemplateSync')).toBe(true);
    });

    it('throws when id is missing', async () => {
      setup();
      await expect(
        call('spaceWorkflow.previewTemplateSync', { spaceId: 'space-1' })
      ).rejects.toThrow('id is required');
    });

    it('throws when spaceId is missing', async () => {
      setup();
      await expect(call('spaceWorkflow.previewTemplateSync', { id: 'wf-1' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when the workflow is not linked to a template', async () => {
      const wfNoTemplate: SpaceWorkflow = { ...mockWorkflow, templateName: undefined };
      setup(mockSpace, wfNoTemplate);
      await expect(
        call('spaceWorkflow.previewTemplateSync', { id: 'wf-1', spaceId: 'space-1' })
      ).rejects.toThrow(/not linked to a built-in template/i);
    });

    it('returns a structural before/after diff without writing', async () => {
      const [template] = getBuiltInWorkflows();
      const wfEdited: SpaceWorkflow = {
        ...template,
        id: 'wf-1',
        spaceId: 'space-1',
        description: 'edited description',
        instructions: 'edited instructions',
        nodes: [
          ...template.nodes,
          { id: 'extra', name: 'Extra Node', agents: [{ agentId: 'a', name: 'A' }] },
        ],
        templateName: template.name,
        templateHash: 'stale-hash',
      };
      setup(mockSpace, wfEdited);

      const result = (await call('spaceWorkflow.previewTemplateSync', {
        id: 'wf-1',
        spaceId: 'space-1',
      })) as {
        preview: {
          workflowId: string;
          templateName: string;
          updateAvailable: boolean;
          customized: boolean;
          diff: {
            description?: { before: string; after: string };
            instructions?: { before: string; after: string };
            nodes?: { added: string[]; removed: string[] };
          };
        };
      };

      expect(result.preview.workflowId).toBe('wf-1');
      expect(result.preview.templateName).toBe(template.name);
      expect(result.preview.updateAvailable).toBe(true);
      expect(result.preview.customized).toBe(true);
      expect(result.preview.diff.description?.before).toBe('edited description');
      expect(result.preview.diff.description?.after).toBe(template.description ?? '');
      expect(result.preview.diff.instructions?.before).toBe('edited instructions');
      expect(result.preview.diff.nodes?.removed).toContain('Extra Node');
    });
  });

  describe('spaceWorkflow.syncFromTemplate', () => {
    function agentsForTemplate(template: SpaceWorkflow): Array<{ id: string; name: string }> {
      const names = new Set<string>();
      for (const node of template.nodes) {
        for (const a of node.agents) {
          names.add(a.agentId);
        }
      }
      return Array.from(names).map((name, i) => ({ id: `agent-uuid-${i}`, name }));
    }

    it('syncs a workflow from its template and emits spaceWorkflow.updated', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const templateHash = computeWorkflowHash(template);
      const wfLinked: SpaceWorkflow = {
        ...mockWorkflow,
        templateName: template.name,
        templateHash: 'old-hash',
      };
      setup(mockSpace, wfLinked, agents);
      const updatedWf: SpaceWorkflow = { ...wfLinked, templateHash };
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(updatedWf);

      const result = (await call('spaceWorkflow.syncFromTemplate', {
        id: 'wf-1',
        spaceId: 'space-1',
      })) as { workflow: SpaceWorkflow };

      expect(result.workflow).toBeDefined();
      expect(workflowManager.updateWorkflow).toHaveBeenCalledTimes(1);
      const [calledId, calledParams] = (workflowManager.updateWorkflow as ReturnType<typeof mock>)
        .mock.calls[0] as [string, Record<string, unknown>];
      expect(calledId).toBe('wf-1');
      expect(calledParams.name).toBe(template.name);
      expect(calledParams.templateName).toBe(template.name);
      expect(calledParams.templateHash).toBe(templateHash);
      const calledNodes = calledParams.nodes as Array<{ id: string; name: string }>;
      expect(calledNodes.map((node) => node.id)).toContain('step-1');
      expect(calledNodes.find((node) => node.id === 'step-1')?.name).toBe(template.nodes[0].name);
      expect(calledParams.startNodeId).toBe('step-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith(
        'spaceWorkflow.updated',
        expect.objectContaining({
          sessionId: 'global',
          spaceId: 'space-1',
        })
      );
    });

    it('reuses existing node IDs one-by-one when node names are duplicated', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const wfLinked: SpaceWorkflow = {
        ...mockWorkflow,
        nodes: [
          { id: 'existing-a', name: template.nodes[0].name, agents: [] },
          { id: 'existing-b', name: template.nodes[0].name, agents: [] },
        ],
        startNodeId: 'existing-a',
        templateName: template.name,
        templateHash: 'old-hash',
      };
      setup(mockSpace, wfLinked, agents);
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(wfLinked);

      await call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' });

      const [, calledParams] = (workflowManager.updateWorkflow as ReturnType<typeof mock>).mock
        .calls[0] as [string, Record<string, unknown>];
      const calledNodes = calledParams.nodes as Array<{ id: string }>;
      expect(calledNodes.map((node) => node.id).slice(0, 2)).toEqual(['existing-a', 'existing-b']);
      expect(calledNodes).toHaveLength(template.nodes.length);
      expect(new Set(calledNodes.map((node) => node.id)).size).toBe(calledNodes.length);
    });

    it('preserves existing exact-name node IDs and assigns fresh IDs to inserted template nodes', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const wfLinked: SpaceWorkflow = {
        ...mockWorkflow,
        nodes: [{ id: 'existing-review', name: 'Review', agents: [] }],
        startNodeId: 'existing-review',
        endNodeId: 'existing-review',
        templateName: template.name,
        templateHash: 'old-hash',
      };
      setup(mockSpace, wfLinked, agents);
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(wfLinked);

      await call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' });

      const [, calledParams] = (workflowManager.updateWorkflow as ReturnType<typeof mock>).mock
        .calls[0] as [string, Record<string, unknown>];
      const calledNodes = calledParams.nodes as Array<{ id: string; name: string }>;
      expect(calledNodes.find((node) => node.name === 'Review')?.id).toBe('existing-review');
      const insertedCoding = calledNodes.find((node) => node.name === 'Coding');
      expect(insertedCoding?.id).not.toBe('existing-review');
      expect(new Set(calledNodes.map((node) => node.id)).size).toBe(calledNodes.length);
    });

    it('throws when id is missing', async () => {
      setup();
      await expect(call('spaceWorkflow.syncFromTemplate', { spaceId: 'space-1' })).rejects.toThrow(
        'id is required'
      );
    });

    it('throws when spaceId is missing', async () => {
      setup();
      await expect(call('spaceWorkflow.syncFromTemplate', { id: 'wf-1' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when space not found', async () => {
      setup(null, mockWorkflow);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'ghost-space' })
      ).rejects.toThrow('Space not found: ghost-space');
    });

    it('throws when workflow not found', async () => {
      setup(mockSpace, null);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'ghost', spaceId: 'space-1' })
      ).rejects.toThrow('Workflow not found: ghost');
    });

    it('throws when workflow belongs to a different space', async () => {
      const wfOtherSpace: SpaceWorkflow = {
        ...mockWorkflow,
        spaceId: 'other-space',
        templateName: 'X',
      };
      setup(mockSpace, wfOtherSpace);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' })
      ).rejects.toThrow('Workflow not found: wf-1');
    });

    it('throws when workflow has no templateName', async () => {
      const wfNoTemplate: SpaceWorkflow = { ...mockWorkflow, templateName: undefined };
      setup(mockSpace, wfNoTemplate);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' })
      ).rejects.toThrow('is not linked to a built-in template');
    });

    it('throws when template is not found in built-ins', async () => {
      const wfUnknown: SpaceWorkflow = { ...mockWorkflow, templateName: 'Unknown Template' };
      setup(mockSpace, wfUnknown);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' })
      ).rejects.toThrow('Built-in template "Unknown Template" not found');
    });

    it('throws when a required agent role cannot be resolved to a SpaceWorkerAgent', async () => {
      const [template] = getBuiltInWorkflows();
      const wfLinked: SpaceWorkflow = { ...mockWorkflow, templateName: template.name };
      setup(mockSpace, wfLinked, []);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' })
      ).rejects.toThrow(/preset agent "Coder" is missing from space "space-1"/);
    });

    it('throws a preset-specific message with a repair hint when a preset is missing', async () => {
      const template = getBuiltInWorkflows().find((t) => t.name === 'Coding')!;
      const wfLinked: SpaceWorkflow = { ...mockWorkflow, templateName: template.name };
      setup(mockSpace, wfLinked, [{ id: 'coder-id', name: 'Coder' }]);
      await expect(
        call('spaceWorkflow.syncFromTemplate', { id: 'wf-1', spaceId: 'space-1' })
      ).rejects.toThrow(/preset agent "Reviewer" is missing[\s\S]*backfill migration/i);
    });

    it('rejects apply when expectedRowHash no longer matches (concurrent edit)', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const wfLinked: SpaceWorkflow = {
        ...mockWorkflow,
        templateName: template.name,
        templateHash: 'old-hash',
      };
      setup(mockSpace, wfLinked, agents);
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(wfLinked);

      await expect(
        call('spaceWorkflow.syncFromTemplate', {
          id: 'wf-1',
          spaceId: 'space-1',
          expectedRowHash: 'stale-reviewed-hash',
        })
      ).rejects.toThrow(/changed since/i);
      expect(workflowManager.updateWorkflow).not.toHaveBeenCalled();
    });

    it('applies when expectedRowHash matches the current row', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const wfLinked: SpaceWorkflow = {
        ...mockWorkflow,
        templateName: template.name,
        templateHash: 'old-hash',
      };
      setup(mockSpace, wfLinked, agents);
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(wfLinked);

      await call('spaceWorkflow.syncFromTemplate', {
        id: 'wf-1',
        spaceId: 'space-1',
        expectedRowHash: computeWorkflowHash(wfLinked),
      });
      expect(workflowManager.updateWorkflow).toHaveBeenCalledTimes(1);
    });
  });

  describe('spaceWorkflow.detectDuplicateDrift', () => {
    function setupWithWorkflows(workflows: SpaceWorkflow[]) {
      setup(mockSpace, mockWorkflow);
      (workflowManager.listWorkflowSummaries as ReturnType<typeof mock>).mockReturnValue(
        workflows.map((w) => ({
          id: w.id,
          spaceId: w.spaceId,
          name: w.name,
          description: w.description,
          tags: w.tags ?? [],
          templateName: w.templateName,
          templateHash: w.templateHash ?? null,
          disabled: w.disabled,
          nodeCount: w.nodes?.length ?? 0,
          completionAutonomyLevel: w.completionAutonomyLevel ?? 3,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
        }))
      );
    }

    it('throws when spaceId is missing', async () => {
      setup();
      await expect(call('spaceWorkflow.detectDuplicateDrift', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when space not found', async () => {
      setup(null, mockWorkflow);
      await expect(
        call('spaceWorkflow.detectDuplicateDrift', { spaceId: 'ghost' })
      ).rejects.toThrow('Space not found: ghost');
    });

    it('returns empty reports when the space has no workflows', async () => {
      setupWithWorkflows([]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toEqual([]);
    });

    it('returns empty reports when no duplicates share a templateName', async () => {
      const [t1] = getBuiltInWorkflows();
      setupWithWorkflows([
        {
          ...mockWorkflow,
          id: 'wf-a',
          templateName: t1.name,
          templateHash: 'hash-1',
          createdAt: 100,
        },
      ]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toEqual([]);
    });

    it('REPORTS uniform-hash duplicate groups (duplicates warrant cleanup, not only drift)', async () => {
      const [t1] = getBuiltInWorkflows();
      setupWithWorkflows([
        {
          ...mockWorkflow,
          id: 'wf-a',
          templateName: t1.name,
          templateHash: 'same-hash',
          createdAt: 100,
        },
        {
          ...mockWorkflow,
          id: 'wf-b',
          templateName: t1.name,
          templateHash: 'same-hash',
          createdAt: 200,
        },
      ]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0].templateName).toBe(t1.name);
    });

    it('excludes groups keyed on a non-built-in templateName', async () => {
      setupWithWorkflows([
        {
          ...mockWorkflow,
          id: 'wf-a',
          templateName: 'Custom Template',
          templateHash: 'h1',
          createdAt: 100,
        },
        {
          ...mockWorkflow,
          id: 'wf-b',
          templateName: 'Custom Template',
          templateHash: 'h2',
          createdAt: 200,
        },
      ]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toEqual([]);
    });

    it('returns a drift report when rows share a built-in templateName with diverging hashes', async () => {
      const [t1] = getBuiltInWorkflows();
      setupWithWorkflows([
        {
          ...mockWorkflow,
          id: 'wf-older',
          templateName: t1.name,
          templateHash: 'old-hash',
          createdAt: 100,
        },
        {
          ...mockWorkflow,
          id: 'wf-newer',
          templateName: t1.name,
          templateHash: 'new-hash',
          createdAt: 200,
        },
      ]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toHaveLength(1);
      const report = result.reports[0];
      expect(report.templateName).toBe(t1.name);
      expect(report.rows).toHaveLength(2);
      expect(report.rows[0].id).toBe('wf-newer');
      expect(report.rows[1].id).toBe('wf-older');
      expect(report.rows[0].templateHash).toBe('new-hash');
    });

    it('treats null-vs-non-null hashes as drift', async () => {
      const [t1] = getBuiltInWorkflows();
      setupWithWorkflows([
        {
          ...mockWorkflow,
          id: 'wf-a',
          templateName: t1.name,
          templateHash: undefined,
          createdAt: 100,
        },
        {
          ...mockWorkflow,
          id: 'wf-b',
          templateName: t1.name,
          templateHash: 'h1',
          createdAt: 200,
        },
      ]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0].rows).toHaveLength(2);
    });

    it('returns multiple reports when multiple built-in templates drift', async () => {
      const [t1, t2] = getBuiltInWorkflows();
      setupWithWorkflows([
        {
          ...mockWorkflow,
          id: 'a1',
          templateName: t1.name,
          templateHash: 'a-old',
          createdAt: 100,
        },
        {
          ...mockWorkflow,
          id: 'a2',
          templateName: t1.name,
          templateHash: 'a-new',
          createdAt: 200,
        },
        {
          ...mockWorkflow,
          id: 'b1',
          templateName: t2.name,
          templateHash: 'b-old',
          createdAt: 50,
        },
        {
          ...mockWorkflow,
          id: 'b2',
          templateName: t2.name,
          templateHash: 'b-new',
          createdAt: 300,
        },
      ]);
      const result = (await call('spaceWorkflow.detectDuplicateDrift', {
        spaceId: 'space-1',
      })) as { reports: DuplicateDriftReport[] };
      expect(result.reports).toHaveLength(2);
      const names = result.reports.map((r) => r.templateName).sort();
      expect(names).toEqual([t1.name, t2.name].sort());
    });
  });

  describe('spaceWorkflow.resyncDuplicates', () => {
    function agentsForTemplate(template: SpaceWorkflow): Array<{ id: string; name: string }> {
      const names = new Set<string>();
      for (const node of template.nodes) {
        for (const a of node.agents) {
          names.add(a.agentId);
        }
      }
      return Array.from(names).map((name, i) => ({ id: `agent-uuid-${i}`, name }));
    }

    function setupWithGroup(
      group: SpaceWorkflow[],
      agents: Array<{ id: string; name: string }> = []
    ) {
      setup(mockSpace, group[0] ?? null, agents);
      (workflowManager.listWorkflows as ReturnType<typeof mock>).mockReturnValue(group);
    }

    it('throws when spaceId is missing', async () => {
      setup();
      await expect(
        call('spaceWorkflow.resyncDuplicates', { templateName: 'Coding Workflow' })
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when templateName is missing', async () => {
      setup();
      await expect(call('spaceWorkflow.resyncDuplicates', { spaceId: 'space-1' })).rejects.toThrow(
        'templateName is required'
      );
    });

    it('throws when space not found', async () => {
      setup(null, mockWorkflow);
      await expect(
        call('spaceWorkflow.resyncDuplicates', {
          spaceId: 'ghost',
          templateName: 'Coding Workflow',
        })
      ).rejects.toThrow('Space not found: ghost');
    });

    it('throws when templateName is not a built-in', async () => {
      setup();
      await expect(
        call('spaceWorkflow.resyncDuplicates', {
          spaceId: 'space-1',
          templateName: 'My Custom Template',
        })
      ).rejects.toThrow('Built-in template "My Custom Template" not found');
    });

    it('throws when no rows exist for the given templateName', async () => {
      const [template] = getBuiltInWorkflows();
      setupWithGroup([], agentsForTemplate(template));
      await expect(
        call('spaceWorkflow.resyncDuplicates', {
          spaceId: 'space-1',
          templateName: template.name,
        })
      ).rejects.toThrow(`No workflows found for templateName "${template.name}"`);
    });

    it('keeps the newest row, deletes older rows, and overwrites kept row from the template', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const older: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-older',
        templateName: template.name,
        templateHash: 'old',
        createdAt: 100,
      };
      const newer: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-newer',
        templateName: template.name,
        templateHash: 'new',
        createdAt: 200,
      };
      setupWithGroup([older, newer], agents);

      const templateHash = computeWorkflowHash(template);
      const updatedWf: SpaceWorkflow = { ...newer, templateHash };
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(updatedWf);
      (workflowManager.deleteWorkflow as ReturnType<typeof mock>).mockReturnValue(true);

      const result = (await call('spaceWorkflow.resyncDuplicates', {
        spaceId: 'space-1',
        templateName: template.name,
      })) as { workflow: SpaceWorkflow; keptWorkflowId: string; deletedIds: string[] };

      expect(result.keptWorkflowId).toBe('wf-newer');
      expect(result.deletedIds).toEqual(['wf-older']);
      expect(workflowManager.deleteWorkflow).toHaveBeenCalledWith('wf-older');
      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalledWith('wf-newer');

      expect(workflowManager.updateWorkflow).toHaveBeenCalledTimes(1);
      const [calledId, calledParams] = (workflowManager.updateWorkflow as ReturnType<typeof mock>)
        .mock.calls[0] as [string, Record<string, unknown>];
      expect(calledId).toBe('wf-newer');
      expect(calledParams.name).toBe(template.name);
      expect(calledParams.templateName).toBe(template.name);
      expect(calledParams.templateHash).toBe(templateHash);
      const calledNodes = calledParams.nodes as Array<{ id: string; name: string }>;
      expect(calledNodes.map((node) => node.id)).toContain('step-1');
      expect(calledNodes.find((node) => node.id === 'step-1')?.name).toBe(template.nodes[0].name);
      expect(calledParams.startNodeId).toBe('step-1');

      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceWorkflow.deleted', {
        sessionId: 'global',
        spaceId: 'space-1',
        workflowId: 'wf-older',
      });
      expect(internalEventBus.publish).toHaveBeenCalledWith(
        'spaceWorkflow.updated',
        expect.objectContaining({
          sessionId: 'global',
          spaceId: 'space-1',
        })
      );
    });

    it('KEEPS a duplicate whose deletion is blocked by a non-archived run (RFC §4 #3)', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const older: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-older',
        name: template.name,
        templateName: template.name,
        templateHash: 'old',
        createdAt: 100,
      };
      const newer: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-newer',
        name: template.name,
        templateName: template.name,
        templateHash: 'new',
        createdAt: 200,
      };
      setupWithGroup([older, newer], agents);

      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(newer);
      (workflowManager.hasExecutableRuns as ReturnType<typeof mock>).mockImplementation(
        (id: string) => id === 'wf-older'
      );

      const result = (await call('spaceWorkflow.resyncDuplicates', {
        spaceId: 'space-1',
        templateName: template.name,
      })) as { deletedIds: string[]; skippedDueToExecutableRuns: string[] };

      expect(result.deletedIds).toEqual([]);
      expect(result.skippedDueToExecutableRuns).toEqual(['wf-older']);
      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalledWith('wf-older');
      expect(workflowRunRepo.deleteByWorkflowId).not.toHaveBeenCalledWith('wf-older');
      expect(internalEventBus.publish).not.toHaveBeenCalledWith(
        'spaceWorkflow.deleted',
        expect.objectContaining({ workflowId: 'wf-older' })
      );
    });

    it('handles a group of one — no deletions, just overwrite the single row', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const only: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-only',
        templateName: template.name,
        templateHash: 'whatever',
        createdAt: 100,
      };
      setupWithGroup([only], agents);

      const templateHash = computeWorkflowHash(template);
      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue({
        ...only,
        templateHash,
      });

      const result = (await call('spaceWorkflow.resyncDuplicates', {
        spaceId: 'space-1',
        templateName: template.name,
      })) as { keptWorkflowId: string; deletedIds: string[] };

      expect(result.keptWorkflowId).toBe('wf-only');
      expect(result.deletedIds).toEqual([]);
      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
      expect(workflowManager.updateWorkflow).toHaveBeenCalledTimes(1);
    });

    it('throws when no SpaceWorkerAgent resolves a required role — and does NOT delete any duplicates or mutate the kept row', async () => {
      const [template] = getBuiltInWorkflows();
      const older: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-older',
        templateName: template.name,
        templateHash: 'old',
        createdAt: 100,
      };
      const newer: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-newer',
        templateName: template.name,
        templateHash: 'new',
        createdAt: 200,
      };
      setupWithGroup([older, newer], []);

      await expect(
        call('spaceWorkflow.resyncDuplicates', {
          spaceId: 'space-1',
          templateName: template.name,
        })
      ).rejects.toThrow(/Cannot resync: preset agent "Coder" is missing/);

      expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
      expect(workflowManager.updateWorkflow).not.toHaveBeenCalled();
      expect(workflowRunRepo.deleteByWorkflowId).not.toHaveBeenCalled();
    });

    it('explicitly deletes runs for each removed duplicate workflow', async () => {
      const [template] = getBuiltInWorkflows();
      const agents = agentsForTemplate(template);
      const older1: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-older-1',
        templateName: template.name,
        templateHash: 'old-1',
        createdAt: 100,
      };
      const older2: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-older-2',
        templateName: template.name,
        templateHash: 'old-2',
        createdAt: 150,
      };
      const newer: SpaceWorkflow = {
        ...mockWorkflow,
        id: 'wf-newer',
        templateName: template.name,
        templateHash: 'new',
        createdAt: 200,
      };
      setupWithGroup([older1, older2, newer], agents);

      (workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(newer);
      (workflowManager.deleteWorkflow as ReturnType<typeof mock>).mockReturnValue(true);

      await call('spaceWorkflow.resyncDuplicates', {
        spaceId: 'space-1',
        templateName: template.name,
      });

      expect(workflowRunRepo.deleteByWorkflowId).toHaveBeenCalledWith('wf-older-1');
      expect(workflowRunRepo.deleteByWorkflowId).toHaveBeenCalledWith('wf-older-2');
      expect(workflowRunRepo.deleteByWorkflowId).not.toHaveBeenCalledWith('wf-newer');
    });
  });
});

describe('checkBuiltInWorkflowDriftOnStartup', () => {
  function makeSpaceManager(spaces: Space[]): SpaceManager {
    return {
      listSpaces: mock(async () => spaces),
    } as unknown as SpaceManager;
  }

  function makeWorkflowManager(
    workflowsBySpaceId: Record<string, SpaceWorkflow[]>
  ): SpaceWorkflowManager {
    return {
      listWorkflows: mock((spaceId: string) => workflowsBySpaceId[spaceId] ?? []),
    } as unknown as SpaceWorkflowManager;
  }

  it('returns without logging when there are no spaces', async () => {
    const sm = makeSpaceManager([]);
    const wm = makeWorkflowManager({});
    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
  });

  it('returns without logging when all workflows are up-to-date', async () => {
    const [template] = getBuiltInWorkflows();
    const currentHash = computeWorkflowHash(template);
    const space: Space = { ...mockSpace, id: 'sp-1', name: 'My Space' };
    const workflow: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-fresh',
      spaceId: 'sp-1',
      templateName: template.name,
      templateHash: currentHash,
    };
    const sm = makeSpaceManager([space]);
    const wm = makeWorkflowManager({ 'sp-1': [workflow] });

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
    expect(wm.listWorkflows).toHaveBeenCalledWith('sp-1');
  });

  it('returns without logging when workflows have no templateName', async () => {
    const space: Space = { ...mockSpace, id: 'sp-1', name: 'My Space' };
    const workflow: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-custom',
      spaceId: 'sp-1',
      templateName: undefined,
    };
    const sm = makeSpaceManager([space]);
    const wm = makeWorkflowManager({ 'sp-1': [workflow] });

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
  });

  it('returns without logging when templateName does not match any built-in', async () => {
    const space: Space = { ...mockSpace, id: 'sp-1', name: 'My Space' };
    const workflow: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-orphan',
      spaceId: 'sp-1',
      templateName: 'Nonexistent Template',
      templateHash: 'some-hash',
    };
    const sm = makeSpaceManager([space]);
    const wm = makeWorkflowManager({ 'sp-1': [workflow] });

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
  });

  it('resolves without throwing when drift is detected (stale templateHash)', async () => {
    const [template] = getBuiltInWorkflows();
    const space: Space = { ...mockSpace, id: 'sp-1', name: 'My Space' };
    const staleWorkflow: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-stale',
      spaceId: 'sp-1',
      templateName: template.name,
      templateHash: 'stale-hash-from-old-version',
    };
    const sm = makeSpaceManager([space]);
    const wm = makeWorkflowManager({ 'sp-1': [staleWorkflow] });

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
  });

  it('resolves without throwing when templateHash is absent (null → drifted)', async () => {
    const [template] = getBuiltInWorkflows();
    const space: Space = { ...mockSpace, id: 'sp-1', name: 'My Space' };
    const workflow: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-no-hash',
      spaceId: 'sp-1',
      templateName: template.name,
      templateHash: undefined,
    };
    const sm = makeSpaceManager([space]);
    const wm = makeWorkflowManager({ 'sp-1': [workflow] });

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
  });

  it('scans workflows across multiple spaces', async () => {
    const [template] = getBuiltInWorkflows();
    const currentHash = computeWorkflowHash(template);
    const spaceA: Space = { ...mockSpace, id: 'sp-a', name: 'Space A' };
    const spaceB: Space = { ...mockSpace, id: 'sp-b', name: 'Space B' };
    const freshWf: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-fresh',
      spaceId: 'sp-a',
      templateName: template.name,
      templateHash: currentHash,
    };
    const staleWf: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-stale',
      spaceId: 'sp-b',
      templateName: template.name,
      templateHash: 'stale',
    };
    const sm = makeSpaceManager([spaceA, spaceB]);
    const wm = makeWorkflowManager({ 'sp-a': [freshWf], 'sp-b': [staleWf] });

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
    expect(wm.listWorkflows).toHaveBeenCalledWith('sp-a');
    expect(wm.listWorkflows).toHaveBeenCalledWith('sp-b');
  });

  it('emits one summary warning listing every workflow with an update available', async () => {
    const [template] = getBuiltInWorkflows();
    const spaceA: Space = { ...mockSpace, id: 'sp-a', name: 'Space A' };
    const spaceB: Space = { ...mockSpace, id: 'sp-b', name: 'Space B' };
    const staleA: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-a',
      spaceId: 'sp-a',
      name: 'Alpha',
      templateName: template.name,
      templateHash: 'stale-a',
    };
    const staleB: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-b',
      spaceId: 'sp-b',
      name: 'Beta',
      templateName: template.name,
      templateHash: 'stale-b',
    };
    const sm = makeSpaceManager([spaceA, spaceB]);
    const wm = makeWorkflowManager({ 'sp-a': [staleA], 'sp-b': [staleB] });

    const warnings: string[] = [];
    configureLogger({ level: LogLevel.WARN });
    const unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:space-workflow-handlers' && event.level === 'warn') {
        warnings.push(event.message);
      }
    });
    try {
      await checkBuiltInWorkflowDriftOnStartup(wm, sm);
    } finally {
      unsubscribe();
      configureLogger({ level: LogLevel.SILENT });
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2 workflow(s) have a template update available');
    expect(warnings[0]).toContain('Space A/Alpha');
    expect(warnings[0]).toContain('Space B/Beta');
  });

  it('chunks oversized drift summaries so no workflow is truncated by the log cap', async () => {
    const [template] = getBuiltInWorkflows();
    const workflows: SpaceWorkflow[] = [];
    const spaces: Space[] = [];
    for (let i = 0; i < 30; i++) {
      const name = `Workflow-With-A-Very-Deliberately-Long-Name-Number-${i}`;
      spaces.push({ ...mockSpace, id: `sp-${i}`, name: `Space ${i}` });
      workflows.push({
        ...mockWorkflow,
        id: `wf-${i}`,
        spaceId: `sp-${i}`,
        name,
        templateName: template.name,
        templateHash: `stale-${i}`,
      });
    }
    const workflowsBySpaceId: Record<string, SpaceWorkflow[]> = {};
    for (const workflow of workflows) {
      workflowsBySpaceId[workflow.spaceId] = [workflow];
    }
    const sm = makeSpaceManager(spaces);
    const wm = makeWorkflowManager(workflowsBySpaceId);

    const warnings: string[] = [];
    configureLogger({ level: LogLevel.WARN });
    const unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:space-workflow-handlers' && event.level === 'warn') {
        warnings.push(event.message);
      }
    });
    try {
      await checkBuiltInWorkflowDriftOnStartup(wm, sm);
    } finally {
      unsubscribe();
      configureLogger({ level: LogLevel.SILENT });
    }

    expect(warnings.length).toBeGreaterThan(1);
    expect(warnings.length).toBeLessThan(workflows.length);
    for (const message of warnings) {
      expect(message.length).toBeLessThanOrEqual(1000);
    }
    const joined = warnings.join(' ');
    for (const workflow of workflows) {
      expect(joined).toContain(workflow.name);
    }
  });

  it('bounds individually oversized names in the drift summary', async () => {
    const [template] = getBuiltInWorkflows();
    const longSpaceName = `S`.repeat(1200);
    const longWorkflowName = `X`.repeat(1200);
    const space: Space = { ...mockSpace, id: 'sp-long', name: longSpaceName };
    const workflow: SpaceWorkflow = {
      ...mockWorkflow,
      id: 'wf-long',
      spaceId: 'sp-long',
      name: longWorkflowName,
      templateName: template.name,
      templateHash: 'stale-long',
    };
    const sm = makeSpaceManager([space]);
    const wm = makeWorkflowManager({ 'sp-long': [workflow] });

    const warnings: string[] = [];
    configureLogger({ level: LogLevel.WARN });
    const unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:space-workflow-handlers' && event.level === 'warn') {
        warnings.push(event.message);
      }
    });
    try {
      await checkBuiltInWorkflowDriftOnStartup(wm, sm);
    } finally {
      unsubscribe();
      configureLogger({ level: LogLevel.SILENT });
    }

    expect(warnings.length).toBeGreaterThan(0);
    for (const message of warnings) {
      expect(message.length).toBeLessThanOrEqual(1000);
    }
    expect(warnings.some((message) => message.includes('S'.repeat(100)))).toBe(true);
    expect(warnings.some((message) => message.includes('X'.repeat(100)))).toBe(true);
  });

  it('resolves without throwing when spaceManager.listSpaces rejects (non-fatal)', async () => {
    const sm = {
      listSpaces: mock(async () => {
        throw new Error('DB connection lost');
      }),
    } as unknown as SpaceManager;
    const wm = makeWorkflowManager({});

    await expect(checkBuiltInWorkflowDriftOnStartup(wm, sm)).resolves.toBeUndefined();
  });
});
