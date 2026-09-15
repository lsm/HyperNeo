import { describe, expect, mock, test } from 'bun:test';
import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import {
  createSendTaskMessageOperation,
  sendTaskMessage,
} from '../../../../src/lib/space/operations/task-message-send.ts';

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

function workflow(): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Test workflow',
    description: '',
    nodes: [{ id: 'node-1', name: 'Work', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
    channels: [],
    tags: [],
    version: '1',
    createdAt: 0,
    updatedAt: 0,
    disabled: false,
    hooks: [],
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

describe('createSendTaskMessageOperation', () => {
  test('define operation with name task.message.send', () => {
    const op = createSendTaskMessageOperation(baseDeps());
    expect(op.name).toBe('task.message.send');
  });
});
