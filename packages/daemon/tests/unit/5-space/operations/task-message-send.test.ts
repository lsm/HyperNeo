import { describe, expect, mock, test } from 'bun:test';
import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { parseAddress } from '../../../../../messaging/src/address.ts';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { ResolveTargetsResult } from '../../../../../messaging/src/contracts.ts';
import {
  createSendTaskMessageOperation,
  sendTaskMessage,
} from '../../../../src/lib/messaging/task-message-send.ts';

const SPACE_ID = 'space-send-test';

function task(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: SPACE_ID,
    taskNumber: 1,
    title: 'Test',
    description: '',
    status: 'in_progress',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    updatedAt: 0,
    workflowRunId: 'run-1',
    preferredWorkflowId: null,
    createdByTaskId: null,
    createdBy: null,
    createdBySession: null,
    createdByTaskScheduleId: null,
    goalId: null,
    evolutionScopeId: null,
    workspacePath: null,
    workflowModelOverrides: {},
    activeSession: null,
    taskAgentSessionId: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    pendingCompletionGeneration: undefined,
    pendingCompletionSubmittedByNodeId: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
    reportedStatus: null,
    reportedSummary: null,
    postApprovalSessionId: null,
    postApprovalStartedAt: null,
    postApprovalBlockedReason: null,
    postApprovalSourceNodeId: null,
    restrictions: null,
    terminalGeneration: undefined,
    ...overrides,
  };
}

function execution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'exec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: null,
    agentSessionId: null,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

function workflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Test workflow',
    description: '',
    nodes: [{ id: 'node-1', name: 'Work', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
    startNodeId: 'node-1',
    channels: [],
    tags: [],
    version: '1',
    createdAt: 0,
    updatedAt: 0,
    disabled: false,
    hooks: [],
    completionAutonomyLevel: 1,
    ...overrides,
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  const exec = execution();
  return {
    getTask: () => task(),
    getTaskByNumber: () => task(),
    getWorkflowRun: () => ({ workflowId: 'wf-1', definitionVersion: null }),
    getWorkflowForRun: () => workflow(),
    listNodeExecutions: () => [exec],
    getNodeExecutionById: () => exec,
    ensureTargetSession: async () => ({ kind: 'unresolved', reason: 'spawn_timeout' }) as const,
    activateNode: mock(async () => {}),
    taskAgentManager: { injectSubSessionMessage: mock(async () => 'msg-id-1') },
    audit: mock(() => {}),
    ...overrides,
  };
}

const baseInput = {
  spaceId: SPACE_ID,
  taskId: 'task-1',
  message: 'Hello',
  outboundSenderLevel: 'session-agent' as const,
  outboundSenderDisplayName: 'tester',
};

describe('sendTaskMessage', () => {
  test('rejects missing task', async () => {
    const result = await sendTaskMessage(
      { ...baseInput },
      { source: 'mcp' as const },
      baseDeps({ getTask: () => null })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Task not found: task-1');
  });

  test('rejects archived task', async () => {
    const result = await sendTaskMessage(
      { ...baseInput },
      { source: 'mcp' as const },
      baseDeps({ getTask: () => task({ status: 'archived' }) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Task task-1 is archived — create a new task.');
  });

  test('rejects task in a different space', async () => {
    const result = await sendTaskMessage(
      { ...baseInput },
      { source: 'mcp' as const },
      baseDeps({ getTask: () => task({ spaceId: 'other-space' }) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Task task-1 does not belong to this space.');
  });

  test('rejects missing target', async () => {
    const result = await sendTaskMessage(
      { ...baseInput, nodeId: undefined, target: undefined },
      { source: 'mcp' as const },
      baseDeps()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Target agent is required. Use node_id or target to specify a recipient.'
    );
  });

  test('rejects task without workflow run', async () => {
    const result = await sendTaskMessage(
      { ...baseInput, nodeId: 'coder' },
      { source: 'mcp' as const },
      baseDeps({ getTask: () => task({ workflowRunId: null }) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Task task-1 has no workflow run — cannot target workflow workers.');
  });

  test('resolves node by agent name and delivers through the worker pipeline', async () => {
    const injected = mock(async () => 'sdk-msg-1');
    const audit = mock(() => {});
    const ensure = mock(async (target) => {
      if (target.kind === 'worker') {
        return { kind: 'resolved', sessionId: 'session-1', created: true } as const;
      }
      return { kind: 'unresolved', reason: 'spawn_timeout' } as const;
    });
    const result = await sendTaskMessage(
      { ...baseInput, nodeId: 'coder' },
      { source: 'mcp' as const },
      baseDeps({
        taskAgentManager: { injectSubSessionMessage: injected },
        ensureTargetSession: ensure,
        audit,
      })
    );
    expect(result.success).toBe(true);
    expect(result.delivered_session_id).toBe('session-1');
    expect(result.sdk_message_id).toBe('sdk-msg-1');
    expect(result.activated).toBe(true);
    expect(injected).toHaveBeenCalled();
  });

  test('resolves @worker target to the execution and activates if no session', async () => {
    const activated = mock(async () => {});
    const ensure = mock(
      async () => ({ kind: 'unresolved', reason: 'session_resolution_unavailable' }) as const
    );
    const byId = mock(async (sessionId: string) => (sessionId === 'session-2' ? 'sdk-msg-2' : ''));
    let refreshed = execution({ agentSessionId: null });
    const getById = () => refreshed;
    const result = await sendTaskMessage(
      { ...baseInput, target: '@worker:run-1/Work/coder' },
      { source: 'mcp' as const },
      baseDeps({
        ensureTargetSession: ensure,
        activateNode: activated,
        taskAgentManager: { injectSubSessionMessage: byId },
        getNodeExecutionById: getById,
        listNodeExecutions: () => [refreshed],
      })
    );
    expect(activated).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.activated).toBe(true);
    expect(result.delivered).toBe(false);
  });

  test('@session target resolves to matching execution and uses session selector', async () => {
    const exec = execution({ agentSessionId: 'session-3' });
    const byId = mock(async () => 'sdk-msg-3');
    const ensure = mock(
      async () => ({ kind: 'resolved', sessionId: 'session-3', created: false }) as const
    );
    const result = await sendTaskMessage(
      { ...baseInput, target: '@session:session-3' },
      { source: 'mcp' as const },
      baseDeps({
        listNodeExecutions: () => [exec],
        taskAgentManager: { injectSubSessionMessage: byId },
        ensureTargetSession: ensure,
      })
    );
    expect(result.success).toBe(true);
    expect(result.delivered_session_id).toBe('session-3');
    expect(result.sdk_message_id).toBe('sdk-msg-3');
  });

  test('by task number maps to the task and resolves', async () => {
    const injected = mock(async () => 'sdk-msg-4');
    const getByNumber = mock(() => task());
    const result = await sendTaskMessage(
      {
        spaceId: SPACE_ID,
        taskNumber: 1,
        message: 'Hello',
        nodeId: 'coder',
        outboundSenderLevel: 'session-agent' as const,
        outboundSenderDisplayName: 'tester',
      },
      { source: 'mcp' as const },
      baseDeps({
        getTaskByNumber: getByNumber,
        ensureTargetSession: async () =>
          ({ kind: 'resolved', sessionId: 'session-4', created: false }) as const,
        taskAgentManager: { injectSubSessionMessage: injected },
      })
    );
    expect(result.success).toBe(true);
    expect(getByNumber).toHaveBeenCalledWith(SPACE_ID, 1);
  });
});

function longHorizonActor(handle: string, overrides: Partial<ActorRef> = {}): ActorRef {
  return {
    actorId: `agent:agent-1`,
    kind: 'agent',
    spaceId: SPACE_ID,
    handle: `@${handle}`,
    roles: [],
    status: 'active',
    ...overrides,
  };
}

function messageResolverFor(
  actor: ActorRef | null,
  match: (target: string) => boolean = () => true
) {
  return {
    resolveTargets: mock(async (message: MessageRecord) => {
      const targetRef = message.targets[0] ?? '';
      if (!actor || !match(targetRef)) {
        return {
          resolved: [],
          unresolved: [{ targetRef, reason: 'No routable actor found' }],
        } as ResolveTargetsResult;
      }
      return {
        resolved: [{ targetRef, address: parseAddress(targetRef), actor }],
        unresolved: [],
      } as ResolveTargetsResult;
    }),
  };
}

describe('sendTaskMessage — handle and role targets', () => {
  test('rejects an unambiguous @handle that matches a long-horizon agent', async () => {
    const actor = longHorizonActor('coder');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@coder' },
      { source: 'mcp' as const },
      baseDeps({
        listNodeExecutions: () => [execution({ agentName: 'other' })],
        messageResolver: messageResolverFor(actor),
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous target "@coder" matched long-horizon agent');
  });

  test('resolves @handle to a worker when no long-horizon agent matches', async () => {
    const injected = mock(async () => 'sdk-msg-5');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@coder' },
      { source: 'mcp' as const },
      baseDeps({
        messageResolver: messageResolverFor(null),
        ensureTargetSession: async () =>
          ({ kind: 'resolved', sessionId: 'session-5', created: false }) as const,
        taskAgentManager: { injectSubSessionMessage: injected },
      })
    );
    expect(result.success).toBe(true);
    expect(result.delivered_session_id).toBe('session-5');
    expect(result.sdk_message_id).toBe('sdk-msg-5');
  });

  test('prefers node_id worker when @handle is ambiguous with a long-horizon agent', async () => {
    const actor = longHorizonActor('coder');
    const injected = mock(async () => 'sdk-msg-6');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@coder', nodeId: 'exec-1' },
      { source: 'mcp' as const },
      baseDeps({
        messageResolver: messageResolverFor(actor),
        ensureTargetSession: async () =>
          ({ kind: 'resolved', sessionId: 'session-6', created: false }) as const,
        taskAgentManager: { injectSubSessionMessage: injected },
      })
    );
    expect(result.success).toBe(true);
    expect(result.delivered_session_id).toBe('session-6');
  });

  test('rejects ambiguous @handle when node_id is not provided', async () => {
    const actor = longHorizonActor('coder');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@coder' },
      { source: 'mcp' as const },
      baseDeps({
        messageResolver: messageResolverFor(actor),
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous target "@coder"');
    expect(result.error).toContain('Disambiguate with @worker:');
  });

  test('rejects when node_id disagrees with a long-horizon @handle', async () => {
    const actor = longHorizonActor('coder');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@coder', nodeId: 'other' },
      { source: 'mcp' as const },
      baseDeps({
        listNodeExecutions: () => [execution({ agentName: 'other' })],
        messageResolver: messageResolverFor(actor),
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('target and node_id disagree');
  });

  test('rejects when @handle resolves to a different worker than node_id', async () => {
    const other = execution({ id: 'exec-2', agentName: 'other', workflowNodeId: 'node-2' });
    const result = await sendTaskMessage(
      { ...baseInput, target: '@coder', nodeId: 'other' },
      { source: 'mcp' as const },
      baseDeps({
        listNodeExecutions: () => [execution(), other],
        getWorkflowForRun: () =>
          workflow({
            nodes: [
              { id: 'node-1', name: 'Work', agents: [{ agentId: 'agent-1', name: 'coder' }] },
              { id: 'node-2', name: 'Other', agents: [{ agentId: 'agent-2', name: 'other' }] },
            ],
          }),
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('target and node_id disagree');
  });

  test('delivers @role target through the long-horizon messaging facade', async () => {
    const actor = longHorizonActor('task-manager');
    const deliverToSession = mock(async () => 'session-role-1');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@role:task-manager' },
      { source: 'mcp' as const },
      baseDeps({
        messageResolver: messageResolverFor(actor, (target) => target.startsWith('@role:')),
        longTermAgentDelivery: {
          deliverToSession,
          queueForActivation: mock(async () => undefined),
        },
      })
    );
    expect(result.success).toBe(true);
    expect(result.target).toBe('agent');
    expect(result.delivered_session_id).toBe('session-role-1');
    expect(deliverToSession).toHaveBeenCalled();
  });

  test('queues an inactive long-horizon agent targeted by @role', async () => {
    const actor = longHorizonActor('task-manager', { status: 'inactive' });
    const queueForActivation = mock(async () => 'session-queued-1');
    const result = await sendTaskMessage(
      { ...baseInput, target: '@role:task-manager' },
      { source: 'mcp' as const },
      baseDeps({
        messageResolver: messageResolverFor(actor, (target) => target.startsWith('@role:')),
        longTermAgentDelivery: {
          deliverToSession: mock(async () => undefined),
          queueForActivation,
        },
      })
    );
    expect(result.success).toBe(true);
    expect(result.target).toBe('agent');
    expect(result.delivered_session_id).toBe('session-queued-1');
    expect(queueForActivation).toHaveBeenCalled();
  });

  test('reports failed delivery when no actor matches @handle', async () => {
    const result = await sendTaskMessage(
      { ...baseInput, target: '@unknown' },
      { source: 'mcp' as const },
      baseDeps({
        listNodeExecutions: () => [],
        messageResolver: messageResolverFor(null),
        longTermAgentDelivery: {
          deliverToSession: mock(async () => undefined),
          queueForActivation: mock(async () => undefined),
        },
      })
    );
    expect(result.success).toBe(false);
    expect(result.target).toBe('agent');
    expect(result.deliveries).toBeDefined();
    expect((result.deliveries as Array<{ state: string }>).some((d) => d.state === 'failed')).toBe(
      true
    );
  });

  test('rejects handle or role delivery when long-term agent messaging is unavailable', async () => {
    const result = await sendTaskMessage(
      { ...baseInput, target: '@role:task-manager' },
      { source: 'mcp' as const },
      baseDeps({
        messageResolver: undefined,
        longTermAgentDelivery: undefined,
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Long-term agent messaging is not available in this context.');
  });

  test('registers reply routing for worker targets when mySessionId is provided', async () => {
    const setRouting = mock(() => {});
    const injected = mock(async () => 'sdk-msg-7');
    const result = await sendTaskMessage(
      { ...baseInput, nodeId: 'coder', mySessionId: 'my-session-1' },
      { source: 'mcp' as const },
      baseDeps({
        replyRoutingRegistry: { set: setRouting },
        ensureTargetSession: async () =>
          ({ kind: 'resolved', sessionId: 'session-7', created: false }) as const,
        taskAgentManager: { injectSubSessionMessage: injected },
      })
    );
    expect(result.success).toBe(true);
    expect(setRouting).toHaveBeenCalledWith('task-1', 'my-session-1', 'coder');
  });
});

describe('createSendTaskMessageOperation', () => {
  test('define operation with name task.message.send', () => {
    const op = createSendTaskMessageOperation(baseDeps());
    expect(op.name).toBe('task.message.send');
  });
});
