import { describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { NodeExecution } from '@hyperneo/shared';
import { setupNodeExecutionHandlers } from '../../../../src/lib/rpc-handlers/space-node-execution-handlers.ts';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';

type RequestHandler = (data: unknown) => Promise<unknown>;

const NOW = Date.now();

const mockExecutions: NodeExecution[] = [
  {
    id: 'exec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: 'agent-1',
    agentSessionId: null,
    status: 'done',
    result: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 5000,
    updatedAt: NOW + 5000,
    lastActivityAt: NOW + 4000,
  },
  {
    id: 'exec-2',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-2',
    agentName: 'reviewer',
    agentId: 'agent-2',
    agentSessionId: null,
    status: 'in_progress',
    result: null,
    createdAt: NOW + 6000,
    startedAt: NOW + 6000,
    completedAt: null,
    updatedAt: NOW + 6000,
    lastActivityAt: NOW + 7000,
  },
];

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

function createMockNodeExecutionRepo(executions: NodeExecution[] = []): NodeExecutionRepository {
  return {
    listByWorkflowRun: mock((workflowRunId: string) =>
      executions.filter((e) => e.workflowRunId === workflowRunId)
    ),
  } as unknown as NodeExecutionRepository;
}

function createMockWorkflowRunRepo(
  runs: Record<string, { spaceId: string }> = {}
): SpaceWorkflowRunRepository {
  return {
    getRun: mock((id: string) => {
      const run = runs[id];
      return run ? ({ spaceId: run.spaceId } as any) : null;
    }),
  } as unknown as SpaceWorkflowRunRepository;
}

describe('space-node-execution-handlers', () => {
  let handlers: Map<string, RequestHandler>;

  function setup(
    opts: { executions?: NodeExecution[]; runs?: Record<string, { spaceId: string }> } = {}
  ) {
    const { hub, handlers: h } = createMockMessageHub();
    handlers = h;
    const nodeExecRepo = createMockNodeExecutionRepo(opts.executions ?? mockExecutions);
    const runRepo = createMockWorkflowRunRepo(opts.runs ?? { 'run-1': { spaceId: 'space-1' } });
    setupNodeExecutionHandlers(hub, nodeExecRepo, runRepo);
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  describe('nodeExecution.list', () => {
    it('throws if workflowRunId is missing', async () => {
      setup();
      await expect(call('nodeExecution.list', { spaceId: 'space-1' })).rejects.toThrow(
        'workflowRunId is required'
      );
    });

    it('throws if spaceId is missing', async () => {
      setup();
      await expect(call('nodeExecution.list', { workflowRunId: 'run-1' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('returns empty array when no executions exist for the run', async () => {
      setup({
        executions: [],
        runs: { 'run-1': { spaceId: 'space-1' } },
      });
      const result = (await call('nodeExecution.list', {
        workflowRunId: 'run-1',
        spaceId: 'space-1',
      })) as { executions: NodeExecution[] };

      expect(result.executions).toEqual([]);
    });

    it('returns executions filtered by workflowRunId', async () => {
      setup();
      const result = (await call('nodeExecution.list', {
        workflowRunId: 'run-1',
        spaceId: 'space-1',
      })) as { executions: NodeExecution[] };

      expect(result.executions).toHaveLength(2);
      expect(result.executions[0].id).toBe('exec-1');
      expect(result.executions[1].id).toBe('exec-2');
      expect(result.executions[0].lastActivityAt).toBe(NOW + 4000);
      expect(result.executions[1].lastActivityAt).toBe(NOW + 7000);
    });

    it('returns only executions matching the given workflowRunId', async () => {
      const mixedExecutions: NodeExecution[] = [
        ...mockExecutions,
        {
          ...mockExecutions[0],
          id: 'exec-3',
          workflowRunId: 'run-2',
        },
      ];
      setup({ executions: mixedExecutions });

      const result = (await call('nodeExecution.list', {
        workflowRunId: 'run-1',
        spaceId: 'space-1',
      })) as { executions: NodeExecution[] };

      expect(result.executions).toHaveLength(2);
      expect(result.executions.every((e) => e.workflowRunId === 'run-1')).toBe(true);
    });

    it('succeeds when spaceId matches the run spaceId', async () => {
      setup({ runs: { 'run-1': { spaceId: 'space-1' } } });
      const result = (await call('nodeExecution.list', {
        workflowRunId: 'run-1',
        spaceId: 'space-1',
      })) as { executions: NodeExecution[] };

      expect(result.executions).toHaveLength(2);
    });

    it('throws when spaceId does not match the run spaceId (ownership check)', async () => {
      setup({ runs: { 'run-1': { spaceId: 'space-1' } } });
      await expect(
        call('nodeExecution.list', {
          workflowRunId: 'run-1',
          spaceId: 'space-other',
        })
      ).rejects.toThrow('WorkflowRun not found: run-1');
    });

    it('throws when run not found', async () => {
      setup({ runs: {} });
      await expect(
        call('nodeExecution.list', {
          workflowRunId: 'run-missing',
          spaceId: 'space-1',
        })
      ).rejects.toThrow('WorkflowRun not found: run-missing');
    });
  });
});
