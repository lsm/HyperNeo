import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Session, SpaceLongHorizonAgent, SpaceTask } from '@hyperneo/shared';
import { longTermAgentSessionId } from '../../helpers/legacy-agent-session-id';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionRole,
  spaceWorkflowWorkerRequiredMcpServers,
} from '../../../../src/lib/space/runtime/space-mcp-session-policy.ts';

const now = Date.now();

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Session',
    workspacePath: '/tmp/ws',
    createdAt: new Date(now).toISOString(),
    lastActiveAt: new Date(now).toISOString(),
    status: 'active',
    config: { tools: {} },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    type: 'worker',
    ...overrides,
  } as Session;
}

function makeNodeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'exec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: null,
    agentSessionId: 'worker-session',
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-from-task',
    taskNumber: 1,
    title: 'Task',
    description: 'Task description',
    status: 'in_progress',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    workflowRunId: null,
    preferredWorkflowId: null,
    createdByTaskId: null,
    createdBy: 'user',
    createdBySession: null,
    createdByTaskScheduleId: null,
    goalId: null,
    evolutionScopeId: null,
    activeSession: null,
    taskAgentSessionId: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    pendingCompletionSubmittedByNodeId: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
    reportedStatus: null,
    reportedSummary: null,
    postApprovalSessionId: null,
    postApprovalStartedAt: null,
    postApprovalBlockedReason: null,
    updatedAt: now,
    ...overrides,
  };
}

describe('resolveSpaceMcpSessionPolicy', () => {
  test('treats a Space session no agent owns as outside any Space', () => {
    const policy = resolveSpaceMcpSessionPolicy(
      makeSession({ id: 'unowned-1', type: 'worker', context: { spaceId: 'space-1' } })
    );

    expect(policy).toEqual({
      role: 'universal_read',
      spaceId: undefined,
      owner: 'none',
      requiredServers: [],
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    });
  });

  test('routes workflow workers by node execution ownership, not session ID shape', () => {
    const session = makeSession({
      id: 'opaque-worker-session',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: (sessionId) =>
          sessionId === session.id ? makeNodeExecution({ agentSessionId: session.id }) : null,
      },
      taskRepo: { getTask: () => makeTask({ id: 'task-1', spaceId: 'space-1' }) },
    });

    expect(policy).toMatchObject({
      role: 'workflow_worker',
      spaceId: 'space-1',
      owner: 'task-agent-manager',
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toEqual(spaceWorkflowWorkerRequiredMcpServers());
  });

  test('resolves workflow worker space from task when session context lacks spaceId', () => {
    const session = makeSession({ id: 'opaque-worker-session', context: { taskId: 'task-1' } });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: () => makeNodeExecution(),
        getById: () => null,
      },
      taskRepo: { getTask: () => makeTask({ id: 'task-1', spaceId: 'space-from-task' }) },
    });

    expect(policy.role).toBe('workflow_worker');
    expect(policy.spaceId).toBe('space-from-task');
  });

  test('routes workflow workers by embedded execution id when session id backfill is missing', () => {
    const session = makeSession({
      id: 'space:space-1:task:task-1:exec:exec-1',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: () => null,
        getById: (id) => (id === 'exec-1' ? makeNodeExecution({ id, agentSessionId: null }) : null),
      },
      taskRepo: { getTask: () => makeTask({ id: 'task-1', spaceId: 'space-1' }) },
    });

    expect(policy).toMatchObject({
      role: 'workflow_worker',
      spaceId: 'space-1',
      owner: 'task-agent-manager',
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toEqual(spaceWorkflowWorkerRequiredMcpServers());
  });

  test('routes suffixed workflow workers by embedded execution id even when another session owns the row', () => {
    const session = makeSession({
      id: 'space:space-1:task:task-1:exec:exec-1:1',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: () => null,
        getById: (id) =>
          id === 'exec-1' ? makeNodeExecution({ id, agentSessionId: 'older-session' }) : null,
      },
      taskRepo: { getTask: () => makeTask({ id: 'task-1', spaceId: 'space-1' }) },
    });

    expect(policy).toMatchObject({
      role: 'workflow_worker',
      spaceId: 'space-1',
      owner: 'task-agent-manager',
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toEqual(spaceWorkflowWorkerRequiredMcpServers());
  });

  test('fails closed (outside any Space) for a canonical long-term-agent session when no context is given', () => {
    const session = makeSession({
      id: longTermAgentSessionId('space-1', 'agent-1'),
      context: { spaceId: 'space-1' },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        promptProvenance: { source: 'custom_agent', hash: 'hash', agentId: 'agent-1' },
      },
    });
    const policy = resolveSpaceMcpSessionPolicy(session);

    expect(policy).toMatchObject({
      role: 'universal_read',
      spaceId: undefined,
      owner: 'none',
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    });
  });

  test('routes long-term agents as active when the repository confirms membership and status', () => {
    const session = makeSession({
      id: longTermAgentSessionId('space-1', 'agent-1'),
      context: { spaceId: 'space-1' },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        promptProvenance: { source: 'custom_agent', hash: 'hash', agentId: 'agent-1' },
      },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      longHorizonAgentRepo: {
        getById: () =>
          ({
            id: 'agent-1',
            spaceId: 'space-1',
            status: 'active',
            sessionId: longTermAgentSessionId('space-1', 'agent-1'),
          }) as SpaceLongHorizonAgent,
      },
    });

    expect(policy.role).toBe('long_term_agent');
  });

  test('a second session stamped with the agent provenance is not the agent', () => {
    const session = makeSession({
      id: 'not-the-canonical-session',
      context: { spaceId: 'space-1' },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        promptProvenance: { source: 'custom_agent', hash: 'hash', agentId: 'agent-1' },
      },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      longHorizonAgentRepo: {
        getById: () =>
          ({
            id: 'agent-1',
            spaceId: 'space-1',
            status: 'active',
            sessionId: longTermAgentSessionId('space-1', 'agent-1'),
          }) as SpaceLongHorizonAgent,
      },
    });

    expect(policy.role).toBe('universal_read');
    expect(policy.attachLongTermAgentTools).toBe(false);
  });

  test.each(['paused', 'disabled', 'archived'] as const)(
    'demotes long-term agent identity when the repository reports status %s',
    (status) => {
      const session = makeSession({
        id: longTermAgentSessionId('space-1', 'agent-1'),
        context: { spaceId: 'space-1' },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          promptProvenance: { source: 'custom_agent', hash: 'hash', agentId: 'agent-1' },
        },
      });
      const policy = resolveSpaceMcpSessionPolicy(session, {
        longHorizonAgentRepo: {
          getById: () => ({ id: 'agent-1', spaceId: 'space-1', status }) as SpaceLongHorizonAgent,
        },
      });

      expect(policy.role).not.toBe('long_term_agent');
      expect(policy.attachLongTermAgentTools).toBe(false);
    }
  );

  test('demotes long-term agent identity when the repository has no record for the agent', () => {
    const session = makeSession({
      id: longTermAgentSessionId('space-1', 'agent-1'),
      context: { spaceId: 'space-1' },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        promptProvenance: { source: 'custom_agent', hash: 'hash', agentId: 'agent-1' },
      },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      longHorizonAgentRepo: { getById: () => null },
    });

    expect(policy.role).not.toBe('long_term_agent');
  });

  test('leaves legacy space_task_agent sessions unowned', () => {
    const policy = resolveSpaceMcpSessionPolicy(
      makeSession({ type: 'space_task_agent', context: { spaceId: 'space-1' } })
    );

    expect(policy).toMatchObject({
      role: 'legacy_task_agent',
      owner: 'none',
      isWorkflowWorker: false,
    });
    expect(policy.requiredServers).toEqual([]);
  });

  test('resolves non-Space sessions to universal_read with no required servers', () => {
    const policy = resolveSpaceMcpSessionPolicy(makeSession({ context: undefined }));

    expect(policy).toMatchObject({
      role: 'universal_read',
      owner: 'none',
      isWorkflowWorker: false,
    });
    expect(policy.spaceId).toBeUndefined();
    expect(policy.requiredServers).toEqual([]);
  });
});

describe('SpaceMcpSessionRole', () => {
  test('accepts universal_read as a union member with no dispatchable actions', () => {
    const role: SpaceMcpSessionRole = 'universal_read';
    expect(role).toBe('universal_read');
  });
});

describe('missingMcpServers', () => {
  test('returns only required servers missing from the MCP map', () => {
    expect(
      missingMcpServers({ 'other-server': {} }, spaceWorkflowWorkerRequiredMcpServers())
    ).toEqual([...spaceWorkflowWorkerRequiredMcpServers()]);
  });
});

describe('post-approval sessions', () => {
  test('a post-approval sub-session with no node execution stays a workflow worker in its Space', () => {
    const policy = resolveSpaceMcpSessionPolicy(
      makeSession({
        id: 'space:space-1:task:t1:post-approval:p1',
        context: { spaceId: 'space-1', taskId: 't1' },
      })
    );
    expect(policy.role).toBe('workflow_worker');
    expect(policy.spaceId).toBe('space-1');
  });
});
