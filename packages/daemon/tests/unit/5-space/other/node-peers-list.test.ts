import { describe, expect, test } from 'bun:test';
import type { NodeExecution, SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { ChannelResolver } from '../../../../src/lib/messaging/channel-resolver.ts';
import type {
  NodeMessagingDependencies,
  NodeMessagingRuntime,
} from '../../../../src/lib/messaging/node-messaging-context.ts';
import { createListNodePeersOperation } from '../../../../src/lib/messaging/node-peers-list.ts';
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

describe('createListNodePeersOperation', () => {
  test('lists within-node peers and cross-node targets reachable over a declared channel', async () => {
    const workflow = workflowWith([{ from: 'writer', to: 'reviewer' } as WorkflowChannel]);
    const operation = createListNodePeersOperation(depsFor(baseExecutions(), runtimeFor(workflow)));

    const result = (await operation.execute({}, workerCaller)) as {
      myAgentName: string;
      peers: Array<{ agentName: string; status: string; nodeName: string | null }>;
      permittedTargets: string[];
      channelTopologyDeclared: boolean;
    };

    expect(result.myAgentName).toBe('writer');
    expect(result.peers.map((peer) => peer.agentName)).toEqual(['co-writer', 'reviewer']);
    expect(result.peers[0]?.status).toBe('completed');
    expect(result.peers[1]?.nodeName).toBe('reviewer');
    expect(result.permittedTargets).toEqual(['reviewer']);
    expect(result.channelTopologyDeclared).toBe(true);
  });

  test('appends the reply-routing session handle to permitted targets', async () => {
    const workflow = workflowWith([{ from: 'writer', to: 'reviewer' } as WorkflowChannel]);
    const operation = createListNodePeersOperation(
      depsFor(baseExecutions(), runtimeFor(workflow, { replyRoutingLookup: () => 'session-human' }))
    );

    const result = (await operation.execute({}, workerCaller)) as { permittedTargets: string[] };

    expect(result.permittedTargets).toContain('@session:session-human');
  });

  test('prefers the current note artifact as the completion summary', async () => {
    const workflow = workflowWith([]);
    const operation = createListNodePeersOperation(
      depsFor(
        baseExecutions(),
        runtimeFor(workflow, {
          artifactRepo: {
            listByRun: () =>
              [
                { artifactKey: 'stale', updatedAt: 9, data: { text: 'stale note' } },
                { artifactKey: 'current', updatedAt: 1, data: { text: 'current note' } },
              ] as never,
          },
        })
      )
    );

    const result = (await operation.execute({}, workerCaller)) as {
      nodeCompletionState: Array<{ completionSummary: string | null }>;
    };

    expect(result.nodeCompletionState.map((state) => state.completionSummary)).toEqual([
      'current note',
      'current note',
    ]);
  });

  test('rejects an MCP caller whose role is not workflow_worker', async () => {
    const operation = createListNodePeersOperation(
      depsFor(baseExecutions(), runtimeFor(workflowWith([])))
    );

    const result = await operation.execute({}, {
      ...workerCaller,
      role: 'ad_hoc_member',
    } as OperationCaller);

    expect(result).toBe('node_caller_denied');
  });

  test('rejects a worker whose caller Space differs from the run Space', async () => {
    const operation = createListNodePeersOperation(
      depsFor(baseExecutions(), runtimeFor(workflowWith([])))
    );

    const result = await operation.execute({}, { ...workerCaller, spaceId: 'space-other' });

    expect(result).toBe('node_caller_denied');
  });

  test('rejects a caller with no live node execution', async () => {
    const operation = createListNodePeersOperation(depsFor([], runtimeFor(workflowWith([]))));

    const result = await operation.execute({}, workerCaller);

    expect(result).toBe('not_a_node_agent');
  });

  test('rejects a node session whose runtime is gone', async () => {
    const operation = createListNodePeersOperation(depsFor(baseExecutions(), null));

    const result = await operation.execute({}, workerCaller);

    expect(result).toBe('not_a_node_agent');
  });
});

describe('workflow.run.peer.list policy', () => {
  test('declares a read policy, but the generic door no longer restricts it to workflow workers', () => {
    const operation = createListNodePeersOperation(
      depsFor(baseExecutions(), runtimeFor(workflowWith([])))
    );

    expect(operation.policy).toEqual({ safetyClass: 'read', roles: ['workflow_worker'] });
    expect(isOperationAdmitted(operation, workerCaller)).toBe(true);
    expect(isOperationAdmitted(operation, { ...workerCaller, role: 'universal_read' })).toBe(true);
  });
});
