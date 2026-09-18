import { describe, expect, test } from 'bun:test';
import type { NodeExecution, SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { ChannelResolver } from '../../../../src/lib/messaging/channel-resolver.ts';
import { createListNodeChannelsOperation } from '../../../../src/lib/messaging/node-channels-list.ts';
import type {
  NodeMessagingDependencies,
  NodeMessagingRuntime,
} from '../../../../src/lib/messaging/node-messaging-context.ts';
import { createListNodeReachableAgentsOperation } from '../../../../src/lib/messaging/node-reachable-agents-list.ts';
import { isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const RUN_ID = 'run-1';
const SPACE_ID = 'space-1';
const MY_SESSION = 'session-writer';

function execution(overrides: Partial<NodeExecution> & { agentName: string }): NodeExecution {
  return {
    id: `exec-${overrides.agentName}`,
    workflowRunId: RUN_ID,
    workflowNodeId: 'node-writer',
    agentId: null,
    agentSessionId: null,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    lastActivityAt: null,
    ...overrides,
  };
}

function workflowWith(channels: WorkflowChannel[]): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Review Flow',
    description: '',
    nodes: [
      { id: 'node-writer', name: 'writer', agents: [{ name: 'writer' }] },
      { id: 'node-reviewer', name: 'reviewer', agents: [{ name: 'reviewer' }] },
    ],
    startNodeId: 'node-writer',
    channels,
    completionAutonomyLevel: 3,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SpaceWorkflow;
}

function runtimeFor(
  workflow: SpaceWorkflow,
  overrides: Partial<NodeMessagingRuntime> = {}
): NodeMessagingRuntime {
  return {
    spaceId: SPACE_ID,
    taskId: 'task-1',
    workflow,
    channelResolver: new ChannelResolver(workflow.channels ?? []),
    agentMessageRouter: {
      deliverMessage: async () => ({ success: true, delivered: [], failed: [] }),
    },
    ...overrides,
  };
}

function depsFor(
  executions: NodeExecution[],
  runtime: NodeMessagingRuntime | null
): NodeMessagingDependencies {
  return {
    nodeExecutionRepo: {
      getByAgentSessionId: (sessionId) =>
        executions.find((exec) => exec.agentSessionId === sessionId) ?? null,
      listByNode: (runId, nodeId) =>
        executions.filter((exec) => exec.workflowRunId === runId && exec.workflowNodeId === nodeId),
      listByWorkflowRun: (runId) => executions.filter((exec) => exec.workflowRunId === runId),
    },
    runtimeForSession: () => runtime,
  };
}

const workerCaller: OperationCaller = {
  source: 'mcp',
  sessionId: MY_SESSION,
  spaceId: SPACE_ID,
  role: 'workflow_worker',
  agentName: 'writer',
};

function baseExecutions(): NodeExecution[] {
  return [
    execution({ agentName: 'writer', agentSessionId: MY_SESSION }),
    execution({ agentName: 'co-writer', agentSessionId: 'session-co', status: 'idle' }),
    execution({
      agentName: 'reviewer',
      workflowNodeId: 'node-reviewer',
      agentSessionId: 'session-reviewer',
    }),
  ];
}

describe('createListNodeReachableAgentsOperation', () => {
  test('reports within-node peers and cross-node targets from the channel topology', async () => {
    const workflow = workflowWith([{ from: 'writer', to: ['reviewer'] } as WorkflowChannel]);
    const operation = createListNodeReachableAgentsOperation(
      depsFor(baseExecutions(), runtimeFor(workflow))
    );

    const result = (await operation.execute({}, workerCaller)) as {
      myNodeName: string;
      withinNodePeers: Array<{ agentName: string; status: string }>;
      crossNodeTargets: Array<{ nodeName: string }>;
      reachabilityDeclared: boolean;
    };

    expect(result.myNodeName).toBe('writer');
    expect(result.withinNodePeers).toEqual([{ agentName: 'co-writer', status: 'completed' }]);
    expect(result.crossNodeTargets).toEqual([{ nodeName: 'reviewer' }]);
    expect(result.reachabilityDeclared).toBe(true);
  });

  test('reports no declared reachability when the workflow has no channels', async () => {
    const operation = createListNodeReachableAgentsOperation(
      depsFor(baseExecutions(), runtimeFor(workflowWith([])))
    );

    const result = (await operation.execute({}, workerCaller)) as {
      crossNodeTargets: Array<{ nodeName: string }>;
      reachabilityDeclared: boolean;
    };

    expect(result.reachabilityDeclared).toBe(false);
    expect(result.crossNodeTargets).toEqual([]);
  });

  test('rejects an MCP caller whose role is not workflow_worker', async () => {
    const operation = createListNodeReachableAgentsOperation(
      depsFor(baseExecutions(), runtimeFor(workflowWith([])))
    );

    const result = await operation.execute({}, { ...workerCaller, role: 'universal_read' });

    expect(result).toBe('node_caller_denied');
  });
});

describe('createListNodeChannelsOperation', () => {
  test('lists every declared channel with its cycle budget', async () => {
    const workflow = workflowWith([
      { id: 'ch-1', from: 'writer', to: 'reviewer', maxCycles: 2, label: 'review' },
    ] as WorkflowChannel[]);
    const operation = createListNodeChannelsOperation(
      depsFor(baseExecutions(), runtimeFor(workflow))
    );

    const result = (await operation.execute({}, workerCaller)) as {
      channels: Array<{ channelId: string | null; maxCycles: number | null; label: string | null }>;
      total: number;
      message: string;
    };

    expect(result.total).toBe(1);
    expect(result.channels[0]).toEqual({
      channelId: 'ch-1',
      from: 'writer',
      to: 'reviewer',
      maxCycles: 2,
      label: 'review',
    } as never);
    expect(result.message).toContain('Review Flow');
  });

  test('rejects an MCP caller whose role is not workflow_worker', async () => {
    const operation = createListNodeChannelsOperation(
      depsFor(baseExecutions(), runtimeFor(workflowWith([])))
    );

    const result = await operation.execute({}, { ...workerCaller, role: 'long_term_agent' });

    expect(result).toBe('node_caller_denied');
  });
});

describe('node topology read policy', () => {
  test('declares a read policy, but the generic door no longer restricts it to workflow workers', () => {
    const deps = depsFor(baseExecutions(), runtimeFor(workflowWith([])));
    const operations = [
      createListNodeReachableAgentsOperation(deps),
      createListNodeChannelsOperation(deps),
    ];

    for (const operation of operations) {
      expect(operation.policy).toEqual({ safetyClass: 'read', roles: ['workflow_worker'] });
      expect(isOperationAdmitted(operation, workerCaller)).toBe(true);
      expect(isOperationAdmitted(operation, { ...workerCaller, role: 'ad_hoc_member' })).toBe(true);
      expect(isOperationAdmitted(operation, { ...workerCaller, role: 'universal_read' })).toBe(
        true
      );
    }
  });
});
