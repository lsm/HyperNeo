import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Session, SpaceTask } from '@hyperneo/shared';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
  SPACE_AD_HOC_MEMBER_REQUIRED_MCP_SERVERS,
  SPACE_COORDINATOR_REQUIRED_MCP_SERVERS,
  SPACE_DESIGNATED_MERGER_REQUIRED_MCP_SERVERS,
  SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS,
} from '../../../../src/lib/space/runtime/space-mcp-session-policy.ts';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session.ts';

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
  test('routes space_chat sessions to SpaceRuntime coordinator tools', () => {
    const policy = resolveSpaceMcpSessionPolicy(
      makeSession({ id: 'space:chat:space-1', type: 'space_chat', context: { spaceId: 'space-1' } })
    );

    expect(policy).toMatchObject({
      role: 'coordinator',
      spaceId: 'space-1',
      owner: 'space-runtime',
      attachCoordinatorTools: true,
      attachGenericSpaceTools: false,
      isWorkflowWorker: false,
    });
    expect(policy.requiredServers).toBe(SPACE_COORDINATOR_REQUIRED_MCP_SERVERS);
  });

  test('routes ad-hoc Space sessions to SpaceRuntime generic member tools', () => {
    const policy = resolveSpaceMcpSessionPolicy(
      makeSession({ id: 'ad-hoc-1', type: 'worker', context: { spaceId: 'space-1' } })
    );

    expect(policy).toMatchObject({
      role: 'ad_hoc_member',
      spaceId: 'space-1',
      owner: 'space-runtime',
      attachGenericSpaceTools: true,
      attachCoordinatorTools: false,
      isWorkflowWorker: false,
    });
    expect(policy.requiredServers).toBe(SPACE_AD_HOC_MEMBER_REQUIRED_MCP_SERVERS);
  });

  test('routes post-approval sub-sessions as ad-hoc members requiring space-agent-tools (#852)', () => {
    // A post-approval spawn (e.g. the built-in `merger`) carries NO NodeExecution
    // row and its id has no `:exec:` segment, so it must NOT be mistaken for a
    // workflow worker (which only requires `node-agent`). It is an ad-hoc Space
    // member and therefore requires `space-agent-tools` — the invariant
    // `spawnPostApprovalSubSession` must satisfy by attaching that server, else
    // `ensureMemberSpaceMcpInvariant` throws at first turn.
    const session = makeSession({
      id: 'space:space-1:task:task-1:post-approval:merger',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: () => null,
        getById: () => null,
      },
      taskRepo: { getTask: () => makeTask({ id: 'task-1', spaceId: 'space-1' }) },
    });

    expect(policy).toMatchObject({
      role: 'ad_hoc_member',
      spaceId: 'space-1',
      owner: 'space-runtime',
      attachGenericSpaceTools: true,
      isWorkflowWorker: false,
    });
    expect(policy.requiredServers).toBe(SPACE_AD_HOC_MEMBER_REQUIRED_MCP_SERVERS);
    // Belt-and-braces: this is exactly the set ensureMemberSpaceMcpInvariant enforces.
    expect(missingMcpServers(undefined, policy.requiredServers)).toEqual(['space-agent-tools']);
  });

  test('an execution-less designated merger requires the merge_pr TOOL too (#879 3741226991)', () => {
    // The freshly spawned built-in merger is execution-less (no NodeExecution
    // row, id has no `:exec:` segment) so it resolves as an ad-hoc member — but
    // it IS this task's designated post-approval merger, so the query-time
    // invariant must ALSO assert the qualified merge_pr tool (a live
    // config.tools.update can disallow it while space-agent-tools stays
    // mounted). Without this, the primary CREATE-path merger runs unguarded.
    const session = makeSession({
      id: 'space:space-1:task:task-1:post-approval:merger',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: () => null,
        getById: () => null,
      },
      taskRepo: {
        getTask: () =>
          makeTask({
            id: 'task-1',
            spaceId: 'space-1',
            status: 'approved',
            postApprovalSessionId: session.id,
            postApprovalRequiresMerge: true,
          }),
      },
    });

    expect(policy).toMatchObject({
      role: 'ad_hoc_member',
      owner: 'space-runtime',
      attachGenericSpaceTools: true,
      isWorkflowWorker: false,
    });
    expect(policy.requiredTools).toEqual(['mcp__space-agent-tools__merge_pr']);
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
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toBe(SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS);
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
      attachGenericSpaceTools: false,
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toBe(SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS);
  });

  test('a reused :exec: session designated as the merger requires space-agent-tools (#879)', () => {
    // When PostApprovalRouter reuses a live `:exec:` workflow-worker session for
    // the merge kickoff, that session IS the task's designated post-approval
    // merger (task.postApprovalSessionId === session.id AND the route requires
    // the merge gate, postApprovalRequiresMerge). It must therefore require
    // `space-agent-tools` (hosts merge_pr) — otherwise
    // ensureMemberSpaceMcpInvariant treats it as a plain worker (node-agent
    // only) and the merger's turn lacks merge_pr. attachGenericSpaceTools must
    // also be true so reattachMemberSpaceTools can self-heal the server after
    // cache eviction / daemon restart.
    const mergerSessionId = 'space:space-1:task:task-1:exec:exec-9';
    const session = makeSession({
      id: mergerSessionId,
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: (sid) =>
          sid === mergerSessionId ? makeNodeExecution({ agentSessionId: sid }) : null,
        getById: () => null,
      },
      taskRepo: {
        getTask: () =>
          makeTask({
            id: 'task-1',
            spaceId: 'space-1',
            status: 'approved',
            postApprovalSessionId: mergerSessionId,
            postApprovalRequiresMerge: true,
          }),
      },
    });

    expect(policy).toMatchObject({
      role: 'workflow_worker',
      spaceId: 'space-1',
      owner: 'task-agent-manager',
      attachGenericSpaceTools: true,
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toBe(SPACE_DESIGNATED_MERGER_REQUIRED_MCP_SERVERS);
    // The invariant ensureMemberSpaceMcpInvariant enforces, and the self-heal
    // targets, exactly this set — both `node-agent` AND `space-agent-tools`.
    expect(missingMcpServers({ 'node-agent': {} }, policy.requiredServers)).toEqual([
      'space-agent-tools',
    ]);
    // #879 (3741142853): the merger's invariant must ALSO assert the qualified
    // merge_pr tool is callable (not just its server present), so a live
    // config.tools.update that disallows it is caught on the next turn.
    expect(policy.requiredTools).toEqual(['mcp__space-agent-tools__merge_pr']);
  });

  test('a designated merger requires the merge_pr TOOL, not just the server (#879 3741142853)', () => {
    const mergerSessionId = 'space:space-1:task:task-1:exec:exec-9';
    const session = makeSession({
      id: mergerSessionId,
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: (sid) =>
          sid === mergerSessionId ? makeNodeExecution({ agentSessionId: sid }) : null,
        getById: () => null,
      },
      taskRepo: {
        getTask: () =>
          makeTask({
            id: 'task-1',
            spaceId: 'space-1',
            status: 'approved',
            postApprovalSessionId: mergerSessionId,
            postApprovalRequiresMerge: true,
          }),
      },
    });

    expect(policy.requiredTools).toEqual(['mcp__space-agent-tools__merge_pr']);
  });

  test('a reused post-approval worker that is NOT a merge route is not classified as the merger (#879 P1-2)', () => {
    // The router stamps postApprovalSessionId for EVERY dispatched route, not
    // just merges. A non-merge reused post-approval worker has this session id
    // matching but postApprovalRequiresMerge false — it must NOT be required to
    // carry space-agent-tools (which would throw in ensureMemberSpaceMcpInvariant
    // for a server it was never given). This is the P1-2 regression guard.
    const session = makeSession({
      id: 'space:space-1:task:task-1:exec:exec-9',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: (sid) =>
          sid === session.id ? makeNodeExecution({ agentSessionId: sid }) : null,
        getById: () => null,
      },
      taskRepo: {
        getTask: () =>
          makeTask({
            id: 'task-1',
            spaceId: 'space-1',
            // SAME session id, but the route is NOT a merge route.
            postApprovalSessionId: session.id,
            postApprovalRequiresMerge: false,
          }),
      },
    });

    expect(policy.attachGenericSpaceTools).toBe(false);
    expect(policy.requiredServers).toBe(SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS);
  });

  test('a non-designated :exec: worker still requires only node-agent (#879 regression guard)', () => {
    // Same session shape, but a DIFFERENT task's postApprovalSessionId — i.e. a
    // plain worker, not the designated merger. Must NOT suddenly require
    // space-agent-tools (which would mis-attach generic tools to every worker).
    const session = makeSession({
      id: 'space:space-1:task:task-1:exec:exec-9',
      type: 'worker',
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: {
        getByAgentSessionId: (sid) =>
          sid === session.id ? makeNodeExecution({ agentSessionId: sid }) : null,
        getById: () => null,
      },
      taskRepo: {
        getTask: () =>
          makeTask({
            id: 'task-1',
            spaceId: 'space-1',
            // Designates a DIFFERENT session — this worker is not the merger.
            postApprovalSessionId: 'some-other-session',
          }),
      },
    });

    expect(policy.attachGenericSpaceTools).toBe(false);
    expect(policy.requiredServers).toBe(SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS);
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
      attachGenericSpaceTools: false,
      isWorkflowWorker: true,
    });
    expect(policy.requiredServers).toBe(SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS);
  });

  test('routes long-term agents using canonical session identity and prompt provenance', () => {
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
      role: 'long_term_agent',
      spaceId: 'space-1',
      owner: 'space-runtime',
      attachLongTermAgentTools: true,
      attachGenericSpaceTools: false,
      isWorkflowWorker: false,
    });
  });

  test('leaves legacy space_task_agent sessions unowned', () => {
    const policy = resolveSpaceMcpSessionPolicy(
      makeSession({ type: 'space_task_agent', context: { spaceId: 'space-1' } })
    );

    expect(policy).toMatchObject({
      role: 'legacy_task_agent',
      owner: 'none',
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      isWorkflowWorker: false,
    });
    expect(policy.requiredServers).toEqual([]);
  });

  test('leaves non-Space sessions unowned', () => {
    const policy = resolveSpaceMcpSessionPolicy(makeSession({ context: undefined }));

    expect(policy).toMatchObject({
      role: 'outside_space',
      owner: 'none',
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      isWorkflowWorker: false,
    });
    expect(policy.requiredServers).toEqual([]);
  });
});

describe('missingMcpServers', () => {
  test('returns only required servers missing from the MCP map', () => {
    expect(
      missingMcpServers({ 'other-server': {} }, SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS)
    ).toEqual(['node-agent']);
  });
});
