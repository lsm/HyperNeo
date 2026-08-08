import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/preact';
import type { SpaceTaskActivityMember, ModelInfo } from '@hyperneo/shared';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockOnEvent = vi.fn();
const mockJoinChannel = vi.fn();
const mockLeaveChannel = vi.fn();
const mockConnectionState = vi.hoisted(() => ({ value: 'connected' }));

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

vi.mock('../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../lib/state', () => ({
  connectionState: mockConnectionState,
}));

import { useTargetSessionContext, resolveTargetSessionId } from '../useTargetSessionContext';

describe('resolveTargetSessionId', () => {
  const members: SpaceTaskActivityMember[] = [
    {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    },
  ];

  it.skip('returns null for target without matching agent name', () => {
    const target = { id: 'task-agent', kind: 'node_agent' as const, label: 'Task Agent' };
    expect(resolveTargetSessionId(target, members)).toBe(null);
  });

  it('returns member sessionId for node_agent target', () => {
    const target = {
      id: 'node:n1:coder',
      kind: 'node_agent' as const,
      label: 'Coder',
      agentName: 'coder',
    };
    expect(resolveTargetSessionId(target, members)).toBe('coder-session');
  });

  it('returns null for not-yet-started node_agent', () => {
    const target = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };
    expect(resolveTargetSessionId(target, members)).toBeNull();
  });

  it('returns null when target is null', () => {
    expect(resolveTargetSessionId(null, members)).toBeNull();
  });

  it('prefers nodeExecutionId over agentName when resolving node_agent', () => {
    const membersWithNodeExecution: SpaceTaskActivityMember[] = [
      {
        id: 'm1',
        sessionId: 'reviewer-a-session',
        kind: 'node_agent',
        label: 'Reviewer A',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'ne-a',
          nodeId: 'n1',
          agentName: 'reviewer',
          status: 'in_progress',
        },
      },
      {
        id: 'm2',
        sessionId: 'reviewer-b-session',
        kind: 'node_agent',
        label: 'Reviewer B',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'ne-b',
          nodeId: 'n2',
          agentName: 'reviewer',
          status: 'in_progress',
        },
      },
    ];

    const targetA = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer A',
      agentName: 'reviewer',
      nodeExecutionId: 'ne-a',
    };
    const targetB = {
      id: 'node:n2:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer B',
      agentName: 'reviewer',
      nodeExecutionId: 'ne-b',
    };

    expect(resolveTargetSessionId(targetA, membersWithNodeExecution)).toBe('reviewer-a-session');
    expect(resolveTargetSessionId(targetB, membersWithNodeExecution)).toBe('reviewer-b-session');
  });

  it('prefers the current post-approval worker over a historical one (same node+name)', () => {
    // Repeated approvals spawn W1/W2 workers that both surface as members with
    // the same node+role; only W2 is current. The composer must bind to W2.
    const workers: SpaceTaskActivityMember[] = [
      {
        id: 'w1',
        sessionId: 'worker-old',
        kind: 'node_agent',
        label: 'Merger',
        role: 'merger',
        state: 'completed',
        processingStatus: 'idle',
        messageCount: 5,
        nodeExecution: {
          nodeExecutionId: 'ne-w1',
          nodeId: 'n-merger',
          agentName: 'merger',
          status: 'idle',
        },
      },
      {
        id: 'w2',
        sessionId: 'worker-current',
        kind: 'node_agent',
        label: 'Merger',
        role: 'merger',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'ne-w2',
          nodeId: 'n-merger',
          agentName: 'merger',
          status: 'in_progress',
          isCurrentPostApproval: true,
        },
      },
    ];
    const target = {
      id: 'node:n-merger:merger',
      kind: 'node_agent' as const,
      label: 'Merger',
      agentName: 'merger',
      nodeId: 'n-merger',
    };
    expect(resolveTargetSessionId(target, workers)).toBe('worker-current');
  });

  it('prefers the current worker even when the target carries a stale ordinary nodeExecutionId', () => {
    // Review-then-merge: the post-approval slot also has an ordinary
    // node_execution row, so the composer target carries its (stale)
    // nodeExecutionId. The execution-less current worker can't match that id,
    // but must still be admitted + chosen so the composer doesn't bind to the
    // stale ordinary session.
    const members: SpaceTaskActivityMember[] = [
      {
        id: 'stale-ordinary',
        sessionId: 'stale-ordinary-session',
        kind: 'node_agent',
        label: 'Merger',
        role: 'merger',
        state: 'idle',
        processingStatus: 'idle',
        messageCount: 3,
        nodeExecution: {
          nodeExecutionId: 'stale-ordinary-exec',
          nodeId: 'n-merger',
          agentName: 'merger',
          status: 'idle',
        },
      },
      {
        id: 'worker-current',
        sessionId: 'worker-current-session',
        kind: 'node_agent',
        label: 'Merger',
        role: 'merger',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'worker-exec',
          nodeId: 'n-merger',
          agentName: 'merger',
          status: 'in_progress',
          isCurrentPostApproval: true,
        },
      },
    ];
    const target = {
      id: 'node:n-merger:merger',
      kind: 'node_agent' as const,
      label: 'Merger',
      agentName: 'merger',
      nodeId: 'n-merger',
      nodeExecutionId: 'stale-ordinary-exec',
    };
    expect(resolveTargetSessionId(target, members)).toBe('worker-current-session');
  });

  it('does not hijack a separator-distinct slot for the current worker (qa-one vs qa_one)', () => {
    // A node declares both 'qa-one' (the current post-approval worker) and
    // 'qa_one' (an ordinary live session). The target is pinned to qa_one's
    // execution. The worker must NOT be admitted (exact name 'qa-one' !==
    // 'qa_one'), so the composer resolves to qa_one's session — not the worker.
    const members: SpaceTaskActivityMember[] = [
      {
        id: 'worker',
        sessionId: 'worker-session',
        kind: 'node_agent',
        label: 'QA One',
        role: 'qa-one',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'worker-exec',
          nodeId: 'n-qa',
          agentName: 'qa-one',
          status: 'in_progress',
          isCurrentPostApproval: true,
        },
      },
      {
        id: 'ordinary',
        sessionId: 'qa-underscore-session',
        kind: 'node_agent',
        label: 'QA Underscore',
        role: 'qa_one',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 1,
        nodeExecution: {
          nodeExecutionId: 'qa-underscore-exec',
          nodeId: 'n-qa',
          agentName: 'qa_one',
          status: 'in_progress',
        },
      },
    ];
    const target = {
      id: 'node:n-qa:qa_one',
      kind: 'node_agent' as const,
      label: 'QA Underscore',
      agentName: 'qa_one',
      nodeId: 'n-qa',
      nodeExecutionId: 'qa-underscore-exec',
    };
    expect(resolveTargetSessionId(target, members)).toBe('qa-underscore-session');
  });

  it('scopes an agentName-only target by nodeId so unstarted node B does not bind to node A', () => {
    // Node A (reviewer) is live; node B (reviewer, unstarted) has no
    // nodeExecutionId. Selecting B must NOT resolve to A's session.
    const members = [
      {
        id: 'm1',
        sessionId: 'reviewer-a-session',
        kind: 'node_agent' as const,
        label: 'Reviewer A',
        role: 'reviewer',
        state: 'active' as const,
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'ne-a',
          nodeId: 'n1',
          agentName: 'reviewer',
          status: 'in_progress' as const,
        },
      },
    ];
    const targetB = {
      id: 'node:n2:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer B',
      agentName: 'reviewer',
      nodeId: 'n2',
      // no nodeExecutionId — unstarted
    };
    expect(resolveTargetSessionId(targetB, members)).toBeNull();
  });

  it('normalizes agent names for fallback matching', () => {
    const membersWithMixedNames: SpaceTaskActivityMember[] = [
      {
        id: 'm1',
        sessionId: 'code-reviewer-session',
        kind: 'node_agent',
        label: 'Code Reviewer',
        role: 'code-reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
      {
        id: 'm2',
        sessionId: 'other-session',
        kind: 'node_agent',
        label: 'Other',
        role: 'other_agent',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: 'ne-other',
          nodeId: 'n2',
          agentName: 'Other Agent',
          status: 'in_progress',
        },
      },
    ];

    // role 'code-reviewer' should match target agentName 'code_reviewer' (underscore vs hyphen)
    expect(
      resolveTargetSessionId(
        {
          id: 'node:n1:code_reviewer',
          kind: 'node_agent' as const,
          label: 'Code Reviewer',
          agentName: 'code_reviewer',
        },
        membersWithMixedNames
      )
    ).toBe('code-reviewer-session');

    // role 'code-reviewer' should also match target agentName 'CodeReviewer' (casing)
    expect(
      resolveTargetSessionId(
        {
          id: 'node:n1:CodeReviewer',
          kind: 'node_agent' as const,
          label: 'Code Reviewer',
          agentName: 'CodeReviewer',
        },
        membersWithMixedNames
      )
    ).toBe('code-reviewer-session');

    // nodeExecution.agentName 'Other Agent' should match target 'other_agent' (trailing "agent" stripped)
    expect(
      resolveTargetSessionId(
        {
          id: 'node:n2:other_agent',
          kind: 'node_agent' as const,
          label: 'Other',
          agentName: 'other_agent',
        },
        membersWithMixedNames
      )
    ).toBe('other-session');
  });
});

describe('useTargetSessionContext', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue({
      request: mockRequest,
      onEvent: mockOnEvent,
      joinChannel: mockJoinChannel,
      leaveChannel: mockLeaveChannel,
    });
    mockOnEvent.mockReturnValue(vi.fn());
    mockJoinChannel.mockResolvedValue(undefined);
    mockLeaveChannel.mockResolvedValue(undefined);
    mockRequest.mockImplementation((method: string) => {
      if (method === 'state.session') {
        return Promise.resolve({
          sessionInfo: null,
          agentState: { isProcessing: false },
          commandsData: { availableCommands: [] },
          error: null,
          timestamp: Date.now(),
        });
      }
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'claude-sonnet-4-6',
              display_name: 'Claude Sonnet 4.6',
              description: '',
              provider: 'anthropic',
            },
            {
              id: 'claude-opus-4-5',
              display_name: 'Claude Opus 4.5',
              description: '',
              provider: 'anthropic',
            },
          ],
        });
      }
      if (method === 'session.model.get') {
        return Promise.resolve({
          currentModel: 'claude-sonnet-4-6',
          modelInfo: {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            family: 'sonnet',
            provider: 'anthropic',
          },
        });
      }
      if (method === 'session.model.switch') {
        return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      return Promise.resolve({});
    });
  });

  const taskAgentTarget = {
    id: 'task-agent',
    kind: 'node_agent' as const,
    label: 'Task Agent',
  };

  const coderTarget = {
    id: 'node:n1:coder',
    kind: 'node_agent' as const,
    label: 'Coder',
    agentName: 'coder',
  };

  const members: SpaceTaskActivityMember[] = [
    {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'processing',
      messageCount: 0,
    },
  ];

  it.skip('resolves target without agentName to null', async () => {
    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [taskAgentTarget],
        selectedTarget: taskAgentTarget,
        activityMembers: [],
      })
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('task-sess-123');
    });
    expect(result.current.isStarted).toBe(true);
  });

  it('resolves node_agent to member sessionId', async () => {
    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });
    expect(result.current.isStarted).toBe(true);
  });

  it('latches the resolved session across transient activity gaps', async () => {
    // Regression: composerTargets (nodeExecutions.byRun) and activityMembers
    // (spaceTaskActivity.byTask) are independent LiveQueries that can momentarily
    // disagree — e.g. a re-snapshot landing with the node-agent member omitted for
    // a tick. Without latching, targetSessionId flips to null, which makes
    // useInputDraft clobber + reload the stale server draft, restoring text the
    // user just deleted. The resolved session must stay latched until the target
    // genuinely changes.
    const coderMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    const target = {
      ...coderTarget,
      nodeExecutionId: 'ne-1',
      nodeExecutionSessionId: 'coder-session',
    };

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [target],
          selectedTarget: target,
          activityMembers: props.members,
        }),
      { initialProps: { members: [coderMember] as SpaceTaskActivityMember[] } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });

    // Transient resolution gap — member list momentarily empty. Execution
    // liveness (nodeExecutionSessionId) still reports the live session, so the
    // latch holds and the composer doesn't clobber + reload the draft.
    rerender({ members: [] });
    expect(result.current.targetSessionId).toBe('coder-session');
    expect(result.current.isStarted).toBe(true);

    // Member reappears — still the same session, no spurious reload.
    rerender({ members: [coderMember] });
    expect(result.current.targetSessionId).toBe('coder-session');
  });

  it('does not latch before execution liveness loads (loading window)', async () => {
    // If nodeExecutions hasn't loaded yet (e.g. the task thread was opened
    // directly), nodeExecutionSessionId is undefined. The latch must not be set
    // — it couldn't be refuted on detach — so when the activity member later
    // drops the target resolves to null instead of resurrecting a stale session.
    const coderMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    };

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [coderTarget],
          selectedTarget: coderTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [coderMember] as SpaceTaskActivityMember[] } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });

    // Activity member drops before liveness loaded — nothing latched, resolves null.
    rerender({ members: [] });
    expect(result.current.targetSessionId).toBeNull();
  });

  it('treats the target as unresolved when activity lags the execution session', async () => {
    // Recovery race: nodeExecutions.byRun already reports the fresh session B,
    // but spaceTaskActivity.byTask still carries the stale member A. The stale A
    // must not be returned as the target session on that render.
    const memberA: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    const target = {
      ...coderTarget,
      nodeExecutionId: 'ne-1',
      nodeExecutionSessionId: 'coder-session-2',
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [target],
        selectedTarget: target,
        activityMembers: [memberA],
      })
    );

    expect(result.current.targetSessionId).toBeNull();
  });

  it('treats a loaded execution with no live session as detached', async () => {
    // nodeExecutionId present but nodeExecutionSessionId undefined means the
    // execution row is loaded and reports no live agentSessionId — the worker
    // detached. A stale activity member still present must NOT be treated as
    // consistent (the trust signal is nodeExecutionLoaded, not execSessionId).
    const staleMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    const target = {
      ...coderTarget,
      nodeExecutionId: 'ne-1',
      // nodeExecutionSessionId intentionally absent — loaded but detached.
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [target],
        selectedTarget: target,
        activityMembers: [staleMember],
      })
    );

    expect(result.current.targetSessionId).toBeNull();
    expect(result.current.isStarted).toBe(false);
  });

  it('resets the latch when switching to a genuinely different target', async () => {
    const coderMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    };
    const reviewerTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const { result, rerender } = renderHook(
      (props: { target: typeof coderTarget | typeof reviewerTarget }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [coderTarget, reviewerTarget],
          selectedTarget: props.target,
          activityMembers: [coderMember],
        }),
      { initialProps: { target: coderTarget } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });

    // Switch to a different, not-yet-started target — must NOT inherit coder's
    // latched session.
    rerender({ target: reviewerTarget });
    expect(result.current.targetSessionId).toBeNull();
    expect(result.current.isStarted).toBe(false);
  });

  it('does not leak the latched session across a task switch with a reused target id', async () => {
    // Regression: SpaceTaskPane stays mounted across task switches and workflow
    // target ids are reused across tasks (node:<nodeId>:<agentName>). Without
    // task-scoping the latch, selecting a second task whose activity hasn't
    // loaded yet would inherit the first task's coder session — marking an
    // unstarted agent as started and wiring its draft/model state to the wrong
    // task's session.
    const task1CoderMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'task1-coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    };
    const task2CoderMember: SpaceTaskActivityMember = {
      id: 'm2',
      sessionId: 'task2-coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    };

    const { result, rerender } = renderHook(
      (props: { taskId: string; members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: props.taskId,
          targets: [coderTarget],
          selectedTarget: coderTarget,
          activityMembers: props.members,
        }),
      { initialProps: { taskId: 'task-1', members: [task1CoderMember] } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('task1-coder-session');
    });

    // Switch to task-2 — same reused target id, activity not loaded yet.
    // Must NOT inherit task-1's latched session.
    rerender({ taskId: 'task-2', members: [] });
    expect(result.current.targetSessionId).toBeNull();
    expect(result.current.isStarted).toBe(false);

    // Task-2 activity arrives with its own session — resolves cleanly, no leak.
    rerender({ taskId: 'task-2', members: [task2CoderMember] });
    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('task2-coder-session');
    });
  });

  it('clears the latch when the worker execution detaches (live agentSessionId gone)', async () => {
    // Regression: when a worker fails and is detached,
    // detachSessionFromAllExecutions sets the node_execution row's
    // agentSessionId to null. NODE_EXECUTIONS_BY_RUN_SQL is NOT filtered by
    // `agent_session_id IS NOT NULL`, so the execution (and nodeExecutionId)
    // STAYS in composerTargets — only nodeExecutionSessionId drops to
    // undefined, while spaceTaskActivity.byTask (filtered) drops the member.
    // resolvedSessionId becomes null but the latch must NOT keep returning the
    // canceled session; the composer should treat the agent as not-started
    // (preconfiguration enabled) until recovery spawns a fresh session.
    const attachedMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    type DetachTarget = {
      id: string;
      kind: 'node_agent';
      label: string;
      agentName: string;
      nodeExecutionId?: string;
      nodeExecutionSessionId?: string;
    };
    const attachedTarget: DetachTarget = {
      id: 'node:n1:coder',
      kind: 'node_agent',
      label: 'Coder',
      agentName: 'coder',
      nodeExecutionId: 'ne-1',
      nodeExecutionSessionId: 'coder-session',
    };

    const { result, rerender } = renderHook(
      (props: { target: DetachTarget; members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [props.target],
          selectedTarget: props.target,
          activityMembers: props.members,
        }),
      { initialProps: { target: attachedTarget, members: [attachedMember] } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });

    // Worker detaches: nodeExecutionId stays (execution still in
    // composerTargets) but its live agentSessionId is cleared, and the activity
    // member disappears. The latch must drop the stale session.
    rerender({
      target: { ...attachedTarget, nodeExecutionSessionId: undefined },
      members: [],
    });
    expect(result.current.targetSessionId).toBeNull();
    expect(result.current.isStarted).toBe(false);

    // Recovery spawns a fresh session under the same execution id — resolves
    // cleanly to the new session, no stale leak.
    const recoveredMember: SpaceTaskActivityMember = {
      id: 'm2',
      sessionId: 'coder-session-2',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    rerender({
      target: { ...attachedTarget, nodeExecutionSessionId: 'coder-session-2' },
      members: [recoveredMember],
    });
    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session-2');
    });
  });

  it('holds the latch across a transient member gap while the live agentSessionId is unchanged', async () => {
    // Complement to the detach case: a transient desync (member momentarily
    // absent) must STILL hold the latch, because nodeExecutionSessionId keeps
    // reporting the same live session. Only a real detach (live session gone)
    // clears it. This is the deleted-text fix — without holding, the null flip
    // would make useInputDraft restore deleted text.
    const coderMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    type LiveTarget = {
      id: string;
      kind: 'node_agent';
      label: string;
      agentName: string;
      nodeExecutionId?: string;
      nodeExecutionSessionId?: string;
    };
    const target: LiveTarget = {
      id: 'node:n1:coder',
      kind: 'node_agent',
      label: 'Coder',
      agentName: 'coder',
      nodeExecutionId: 'ne-1',
      nodeExecutionSessionId: 'coder-session',
    };

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [target],
          selectedTarget: target,
          activityMembers: props.members,
        }),
      { initialProps: { members: [coderMember] } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });

    // Transient gap: member list momentarily empty, but nodeExecutionSessionId
    // still reports the same live session. Latch must hold.
    rerender({ members: [] });
    expect(result.current.targetSessionId).toBe('coder-session');
    expect(result.current.isStarted).toBe(true);
  });

  it('does not latch a stale activity session during a worker-recovery race', async () => {
    // Regression: nodeExecutions.byRun (lighter) can advance to the new session
    // before the heavier spaceTaskActivity.byTask snapshot drops the old member,
    // so resolvedSessionId can momentarily lag nodeExecutionSessionId. Latching
    // the stale activity session would resurrect it on the next activity gap.
    type RaceTarget = {
      id: string;
      kind: 'node_agent';
      label: string;
      agentName: string;
      nodeExecutionId?: string;
      nodeExecutionSessionId?: string;
    };
    const target: RaceTarget = {
      id: 'node:n1:coder',
      kind: 'node_agent',
      label: 'Coder',
      agentName: 'coder',
      nodeExecutionId: 'ne-1',
      nodeExecutionSessionId: 'coder-session',
    };
    const memberA: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };

    const { result, rerender } = renderHook(
      (props: { target: RaceTarget; members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [props.target],
          selectedTarget: props.target,
          activityMembers: props.members,
        }),
      { initialProps: { target, members: [memberA] } }
    );

    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session');
    });

    // Execution advances to the fresh session, but the activity snapshot still
    // reports the stale member. The stale activity session must NOT be latched
    // against the new execution session.
    rerender({
      target: { ...target, nodeExecutionSessionId: 'coder-session-2' },
      members: [memberA],
    });

    // Stale member drops before the fresh one arrives. The latch must not
    // resurrect the canceled 'coder-session'.
    rerender({
      target: { ...target, nodeExecutionSessionId: 'coder-session-2' },
      members: [],
    });
    expect(result.current.targetSessionId).toBeNull();

    // Fresh session's member arrives — resolves cleanly.
    const memberB: SpaceTaskActivityMember = {
      id: 'm2',
      sessionId: 'coder-session-2',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    rerender({
      target: { ...target, nodeExecutionSessionId: 'coder-session-2' },
      members: [memberB],
    });
    await waitFor(() => {
      expect(result.current.targetSessionId).toBe('coder-session-2');
    });
  });

  it('marks not-yet-started agent as isStarted=false', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [notStartedTarget],
        selectedTarget: notStartedTarget,
        activityMembers: members,
        defaultAgentModels: new Map([['node:n1:reviewer', 'claude-opus-4-5']]),
      })
    );

    await waitFor(() => {
      expect(result.current.isStarted).toBe(false);
    });
    expect(result.current.targetSessionId).toBeNull();
  });

  it('uses workflow default model for not-yet-started agents', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [notStartedTarget],
        selectedTarget: notStartedTarget,
        activityMembers: members,
        defaultAgentModels: new Map([['node:n1:reviewer', 'claude-opus-4-5']]),
      })
    );

    await waitFor(() => {
      expect(result.current.currentModel).toBe('claude-opus-4-5');
    });
  });

  it('derives isProcessing from activity member processingStatus', async () => {
    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    await waitFor(() => {
      expect(result.current.isProcessing).toBe(true);
    });
  });

  it('loads contextInfo from initial session metadata', async () => {
    const initialContextInfo = {
      model: 'claude-sonnet-4-6',
      totalUsed: 12_000,
      totalCapacity: 200_000,
      percentUsed: 6,
      breakdown: {},
      lastUpdated: 123,
      source: 'sdk-get-context-usage' as const,
    };
    mockRequest.mockImplementation((method: string) => {
      if (method === 'state.session') {
        return Promise.resolve({
          sessionInfo: {
            id: 'coder-session',
            metadata: { lastContextInfo: initialContextInfo },
          },
          agentState: { isProcessing: false },
          commandsData: { availableCommands: [] },
          error: null,
          timestamp: Date.now(),
        });
      }
      if (method === 'models.list') {
        return Promise.resolve({ models: [] });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    await waitFor(() => {
      expect(result.current.contextInfo).toEqual(initialContextInfo);
    });
    expect(mockJoinChannel).toHaveBeenCalledWith('session:coder-session');
    expect(mockRequest).toHaveBeenCalledWith('state.session', { sessionId: 'coder-session' });
  });

  it('updates contextInfo from context.updated events for the target session', async () => {
    const handlers = new Map<string, Function>();
    mockOnEvent.mockImplementation((method: string, handler: Function) => {
      handlers.set(method, handler);
      return vi.fn();
    });
    const updatedContextInfo = {
      model: 'claude-sonnet-4-6',
      totalUsed: 50_000,
      totalCapacity: 200_000,
      percentUsed: 25,
      breakdown: {},
      lastUpdated: 456,
      source: 'stream' as const,
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    await waitFor(() => {
      expect(handlers.has('context.updated')).toBe(true);
    });

    act(() => {
      handlers.get('context.updated')?.(updatedContextInfo, { channel: 'session:other-session' });
    });
    expect(result.current.contextInfo).toBeNull();

    act(() => {
      handlers.get('context.updated')?.(updatedContextInfo, { channel: 'session:coder-session' });
    });

    expect(result.current.contextInfo).toEqual(updatedContextInfo);
  });

  it('does not let initial state overwrite newer context.updated data', async () => {
    const handlers = new Map<string, Function>();
    let resolveInitialState: (value: unknown) => void = () => {};
    mockRequest.mockImplementation((method: string) => {
      if (method === 'state.session') {
        return new Promise((resolve) => {
          resolveInitialState = resolve;
        });
      }
      if (method === 'models.list') return Promise.resolve({ models: [] });
      if (method === 'session.thinking.get') return Promise.resolve({ thinkingLevel: 'off' });
      return Promise.resolve({});
    });
    mockOnEvent.mockImplementation((method: string, handler: Function) => {
      handlers.set(method, handler);
      return vi.fn();
    });
    const staleContextInfo = {
      model: 'claude-sonnet-4-6',
      totalUsed: 12_000,
      totalCapacity: 200_000,
      percentUsed: 6,
      breakdown: {},
      lastUpdated: 123,
      source: 'sdk-get-context-usage' as const,
    };
    const liveContextInfo = {
      model: 'claude-sonnet-4-6',
      totalUsed: 50_000,
      totalCapacity: 200_000,
      percentUsed: 25,
      breakdown: {},
      lastUpdated: 456,
      source: 'stream' as const,
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    await waitFor(() => {
      expect(handlers.has('context.updated')).toBe(true);
    });

    act(() => {
      handlers.get('context.updated')?.(liveContextInfo, { channel: 'session:coder-session' });
    });
    expect(result.current.contextInfo).toEqual(liveContextInfo);

    await act(async () => {
      resolveInitialState({
        sessionInfo: { id: 'coder-session', metadata: { lastContextInfo: staleContextInfo } },
        agentState: { isProcessing: false },
        commandsData: { availableCommands: [] },
        error: null,
        timestamp: Date.now(),
      });
    });

    expect(result.current.contextInfo).toEqual(liveContextInfo);
  });

  it('clears contextInfo when session metadata clears it', async () => {
    const initialContextInfo = {
      model: 'claude-sonnet-4-6',
      totalUsed: 12_000,
      totalCapacity: 200_000,
      percentUsed: 6,
      breakdown: {},
      lastUpdated: 123,
      source: 'sdk-get-context-usage' as const,
    };
    const handlers = new Map<string, Function>();
    mockOnEvent.mockImplementation((method: string, handler: Function) => {
      handlers.set(method, handler);
      return vi.fn();
    });

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    await waitFor(() => {
      expect(handlers.has('context.updated')).toBe(true);
    });
    act(() => {
      handlers.get('context.updated')?.(initialContextInfo, { channel: 'session:coder-session' });
    });
    expect(result.current.contextInfo).toEqual(initialContextInfo);

    act(() => {
      handlers.get('state.session')?.(
        {
          sessionInfo: { id: 'coder-session', metadata: { lastContextInfo: null } },
          agentState: { isProcessing: false },
          commandsData: { availableCommands: [] },
          error: null,
          timestamp: Date.now(),
        },
        { channel: 'session:coder-session' }
      );
    });

    expect(result.current.contextInfo).toBeNull();
  });

  it('keeps existing contextInfo when reconnect state fetch fails for the same session', async () => {
    const handlers = new Map<string, Function>();
    mockOnEvent.mockImplementation((method: string, handler: Function) => {
      handlers.set(method, handler);
      return vi.fn();
    });
    const existingContextInfo = {
      model: 'claude-sonnet-4-6',
      totalUsed: 50_000,
      totalCapacity: 200_000,
      percentUsed: 25,
      breakdown: {},
      lastUpdated: 456,
      source: 'stream' as const,
    };

    const { result, rerender } = renderHook(
      (props: { renderMarker: number }) => {
        void props.renderMarker;
        return useTargetSessionContext({
          taskId: 'task-1',
          targets: [coderTarget],
          selectedTarget: coderTarget,
          activityMembers: members,
        });
      },
      { initialProps: { renderMarker: 1 } }
    );

    await waitFor(() => {
      expect(handlers.has('context.updated')).toBe(true);
    });
    act(() => {
      handlers.get('context.updated')?.(existingContextInfo, { channel: 'session:coder-session' });
    });
    expect(result.current.contextInfo).toEqual(existingContextInfo);

    mockRequest.mockImplementation((method: string) => {
      if (method === 'state.session') return Promise.reject(new Error('offline'));
      if (method === 'models.list') return Promise.resolve({ models: [] });
      if (method === 'session.thinking.get') return Promise.resolve({ thinkingLevel: 'off' });
      return Promise.resolve({});
    });
    mockConnectionState.value = 'reconnecting';
    rerender({ renderMarker: 2 });

    expect(result.current.contextInfo).toEqual(existingContextInfo);
  });

  it('leaves a stale channel if join resolves after cleanup', async () => {
    const joinResolvers: Array<() => void> = [];
    mockJoinChannel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          joinResolvers.push(resolve);
        })
    );
    const reviewerTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };
    const reviewerMember: SpaceTaskActivityMember = {
      id: 'm2',
      sessionId: 'reviewer-session',
      kind: 'node_agent',
      label: 'Reviewer',
      role: 'reviewer',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    };

    const { rerender } = renderHook(
      (props: { selectedTarget: typeof coderTarget | typeof reviewerTarget }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [coderTarget, reviewerTarget],
          selectedTarget: props.selectedTarget,
          activityMembers: [...members, reviewerMember],
        }),
      { initialProps: { selectedTarget: coderTarget } }
    );

    rerender({ selectedTarget: reviewerTarget });
    expect(mockLeaveChannel).not.toHaveBeenCalledWith('session:coder-session');

    await act(async () => {
      joinResolvers[0]?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockLeaveChannel).toHaveBeenCalledWith('session:coder-session');
    });
  });

  it('cleans up context subscriptions when the target session changes', async () => {
    const unsubscribeState = vi.fn();
    const unsubscribeContext = vi.fn();
    mockOnEvent.mockImplementation((method: string) => {
      if (method === 'state.session') return unsubscribeState;
      if (method === 'context.updated') return unsubscribeContext;
      return vi.fn();
    });
    const reviewerTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };
    const reviewerMember: SpaceTaskActivityMember = {
      id: 'm2',
      sessionId: 'reviewer-session',
      kind: 'node_agent',
      label: 'Reviewer',
      role: 'reviewer',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
    };

    const { rerender } = renderHook(
      (props: { selectedTarget: typeof coderTarget | typeof reviewerTarget }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [coderTarget, reviewerTarget],
          selectedTarget: props.selectedTarget,
          activityMembers: [...members, reviewerMember],
        }),
      { initialProps: { selectedTarget: coderTarget } }
    );

    await waitFor(() => {
      expect(mockJoinChannel).toHaveBeenCalledWith('session:coder-session');
    });

    rerender({ selectedTarget: reviewerTarget });

    await waitFor(() => {
      expect(unsubscribeState).toHaveBeenCalled();
      expect(unsubscribeContext).toHaveBeenCalled();
      expect(mockLeaveChannel).toHaveBeenCalledWith('session:coder-session');
      expect(mockJoinChannel).toHaveBeenCalledWith('session:reviewer-session');
    });
  });

  it('pre-configures model for not-yet-started agents', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [notStartedTarget],
        selectedTarget: notStartedTarget,
        activityMembers: members,
      })
    );

    await act(async () => {
      await result.current.switchModel(model);
    });

    expect(result.current.currentModel).toBe('claude-opus-4-5');
  });

  it('sets thinking level for started agents via RPC', async () => {
    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [coderTarget],
        selectedTarget: coderTarget,
        activityMembers: members,
      })
    );

    // Wait for the async live thinking-level load to settle so it doesn't
    // race with the manual setThinkingLevel call.
    await waitFor(() => {
      expect(result.current.thinkingLevel).toBe('off');
    });

    await act(async () => {
      await result.current.setThinkingLevel('think16k');
    });

    expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
      sessionId: 'coder-session',
      level: 'think16k',
    });
    expect(result.current.thinkingLevel).toBe('think16k');
  });

  it('pre-configures thinking level for not-yet-started agents', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const { result } = renderHook(() =>
      useTargetSessionContext({
        taskId: 'task-1',
        targets: [notStartedTarget],
        selectedTarget: notStartedTarget,
        activityMembers: members,
      })
    );

    await act(async () => {
      await result.current.setThinkingLevel('think32k');
    });

    expect(result.current.thinkingLevel).toBe('think32k');
    expect(mockRequest).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());
  });

  it('auto-applies pre-configured model and thinking when session spawns', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[] } }
    );

    // Pre-configure model and thinking while agent is not started
    await act(async () => {
      await result.current.switchModel(model);
    });
    await act(async () => {
      await result.current.setThinkingLevel('think16k');
    });

    expect(result.current.currentModel).toBe('claude-opus-4-5');
    expect(result.current.thinkingLevel).toBe('think16k');
    expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
    expect(mockRequest).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());

    // Spawn the agent session
    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembers });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'reviewer-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });

    expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
      sessionId: 'reviewer-session',
      level: 'think16k',
    });
  });

  it('does not auto-apply preconfiguration to a stale activity session', async () => {
    // Recovery race / detach: the activity snapshot carries a stale member while
    // the execution's live agentSessionId is gone (nodeExecutionId loaded but
    // nodeExecutionSessionId undefined). Auto-apply must skip — no RPCs to the
    // canceled session, and the target stays unmarked so the fresh session later
    // receives the settings.
    type StaleTarget = {
      id: string;
      kind: 'node_agent';
      label: string;
      agentName: string;
      nodeExecutionId?: string;
      nodeExecutionSessionId?: string;
    };
    const target: StaleTarget = {
      id: 'node:n1:coder',
      kind: 'node_agent',
      label: 'Coder',
      agentName: 'coder',
      nodeExecutionId: 'ne-1',
      // nodeExecutionSessionId absent — loaded but detached.
    };
    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    const { result, rerender } = renderHook(
      (props: { target: StaleTarget; members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [props.target],
          selectedTarget: props.target,
          activityMembers: props.members,
        }),
      { initialProps: { target, members: [] as SpaceTaskActivityMember[] } }
    );

    // Pre-configure while the agent is not started.
    await act(async () => {
      await result.current.switchModel(model);
    });
    await act(async () => {
      await result.current.setThinkingLevel('think16k');
    });

    // Stale member appears for a loaded-but-detached execution.
    const staleMember: SpaceTaskActivityMember = {
      id: 'm1',
      sessionId: 'coder-session',
      kind: 'node_agent',
      label: 'Coder',
      role: 'coder',
      state: 'active',
      processingStatus: 'idle',
      messageCount: 0,
      nodeExecution: {
        nodeExecutionId: 'ne-1',
        nodeId: 'n1',
        agentName: 'coder',
        status: 'in_progress',
      },
    };
    rerender({ target, members: [staleMember] });

    expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
    expect(mockRequest).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());

    // Once liveness lands and agrees with the live session, auto-apply fires —
    // proving the target was not prematurely marked applied during the stale window.
    rerender({
      target: { ...target, nodeExecutionSessionId: 'coder-session' },
      members: [staleMember],
    });
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'coder-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });
    expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
      sessionId: 'coder-session',
      level: 'think16k',
    });
  });

  it('retries auto-apply when pre-config persistence fails', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    // First call fails, second succeeds
    let callCount = 0;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'claude-opus-4-5',
              display_name: 'Claude Opus 4.5',
              description: '',
              provider: 'anthropic',
            },
          ],
        });
      }
      if (method === 'session.model.get') {
        return Promise.resolve({
          currentModel: 'claude-sonnet-4-6',
          modelInfo: {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            family: 'sonnet',
            provider: 'anthropic',
          },
        });
      }
      if (method === 'session.model.switch') {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Switch failed'));
        }
        return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      return Promise.resolve({});
    });

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[] } }
    );

    await act(async () => {
      await result.current.switchModel(model);
    });

    // Spawn session — first attempt fails
    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembers });

    // Wait for the first auto-apply attempt to run (may be preceded by a
    // no-op run while switcherModels is still empty from the fresh
    // useModelSwitcher instance).
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'reviewer-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });

    // The first attempt fails, so the target is not marked as applied.
    // A subsequent re-render should trigger a retry.
    rerender({ members: [...spawnedMembers] });

    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  it('resets preconfiguration when taskId changes', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    const { result, rerender } = renderHook(
      (props: { taskId: string }) =>
        useTargetSessionContext({
          taskId: props.taskId,
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: [],
        }),
      { initialProps: { taskId: 'task-a' } }
    );

    // Pre-configure model for task-a
    await act(async () => {
      await result.current.switchModel(model);
    });

    expect(result.current.currentModel).toBe('claude-opus-4-5');

    // Switch to a different task — preconfiguration should reset
    rerender({ taskId: 'task-b' });

    // Default model is empty for this target, so after reset currentModel
    // should fall back to empty string.
    await waitFor(() => {
      expect(result.current.currentModel).toBe('');
    });
  });

  it('does not auto-apply stale preconfiguration after taskId changes', async () => {
    const sharedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    const { result, rerender } = renderHook(
      (props: { taskId: string; members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: props.taskId,
          targets: [sharedTarget],
          selectedTarget: sharedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { taskId: 'task-a', members: [] as SpaceTaskActivityMember[] } }
    );

    // Pre-configure model for task-a while agent is not started
    await act(async () => {
      await result.current.switchModel(model);
    });
    expect(result.current.currentModel).toBe('claude-opus-4-5');
    expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', expect.anything());

    // Switch to task-b where the same target already has a spawned session.
    // The stale preconfiguration from task-a must NOT trigger auto-apply.
    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session-b',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ taskId: 'task-b', members: spawnedMembers });

    // Wait a tick for any effect runs to settle
    await new Promise((r) => setTimeout(r, 10));

    // The model switch should NOT have been called because the preconfig
    // belonged to task-a, not task-b.
    expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', {
      sessionId: 'reviewer-session-b',
      model: 'claude-opus-4-5',
      provider: 'anthropic',
    });
  });

  it('auto-applies preconfiguration for non-selected targets when their session spawns', async () => {
    const targetA = {
      id: 'node:n1:coder',
      kind: 'node_agent' as const,
      label: 'Coder',
      agentName: 'coder',
    };
    const targetB = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    // Phase 1: select target A and pre-configure it
    const { result, rerender } = renderHook(
      (props: {
        members: SpaceTaskActivityMember[];
        selectedTarget: typeof targetA | typeof targetB;
      }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [targetA, targetB],
          selectedTarget: props.selectedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[], selectedTarget: targetA } }
    );

    await act(async () => {
      await result.current.switchModel(model);
    });
    await act(async () => {
      await result.current.setThinkingLevel('think16k');
    });

    expect(result.current.currentModel).toBe('claude-opus-4-5');
    expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', expect.anything());

    // Phase 2: switch selection to target B
    rerender({ members: [] as SpaceTaskActivityMember[], selectedTarget: targetB });

    // Phase 3: target A's session spawns in the background
    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-coder',
        sessionId: 'coder-session',
        kind: 'node_agent',
        label: 'Coder',
        role: 'coder',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembers, selectedTarget: targetB });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'coder-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });

    expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
      sessionId: 'coder-session',
      level: 'think16k',
    });
  });

  it('does not mark auto-config applied when no RPC was attempted', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[] } }
    );

    // Phase 1: let models load while hub is connected so switcherModels is populated
    await waitFor(() => {
      expect(result.current.availableModels.length).toBeGreaterThan(0);
    });

    // Phase 2: disconnect hub and pre-configure model
    mockGetHubIfConnected.mockReturnValue(null);
    await act(async () => {
      await result.current.switchModel(model);
    });

    // Phase 3: spawn session while hub is still disconnected
    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembers });

    // Wait a tick to let any effect runs settle
    await new Promise((r) => setTimeout(r, 10));

    // No RPCs should have been attempted because hub is null
    expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
    expect(mockRequest).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());

    // Phase 4: reconnect the hub and re-render
    mockGetHubIfConnected.mockReturnValue({
      request: mockRequest,
      onEvent: mockOnEvent,
      joinChannel: mockJoinChannel,
      leaveChannel: mockLeaveChannel,
    });
    rerender({ members: [...spawnedMembers] });

    // The effect should retry now that the hub is available
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'reviewer-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });
  });

  it('retries model auto-apply when model info is initially missing but thinking succeeds', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    // Start with empty models so switcherModels is empty when the session spawns
    mockRequest.mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({ models: [] });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      if (method === 'session.thinking.set') {
        return Promise.resolve({ success: true });
      }
      if (method === 'session.model.switch') {
        return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
      }
      return Promise.resolve({});
    });

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[] } }
    );

    // Pre-configure model and thinking while agent is not started
    await act(async () => {
      await result.current.switchModel(model);
    });
    await act(async () => {
      await result.current.setThinkingLevel('think16k');
    });

    // Spawn the agent session — models.list returns empty, so model lookup fails
    const spawnedMembersA: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session-a',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembersA });

    // Wait a tick for effects to settle
    await new Promise((r) => setTimeout(r, 10));

    // Thinking should have been applied because hub is connected
    expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
      sessionId: 'reviewer-session-a',
      level: 'think16k',
    });

    // Model should NOT have been applied because switcherModels was empty
    const modelSwitchCallsBefore = mockRequest.mock.calls.filter(
      (call) => call[0] === 'session.model.switch'
    );
    expect(modelSwitchCallsBefore).toHaveLength(0);

    // Now make models available and spawn a new session (different sessionId
    // forces useModelSwitcher to reload models)
    mockRequest.mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'claude-opus-4-5',
              display_name: 'Claude Opus 4.5',
              description: '',
              provider: 'anthropic',
            },
          ],
        });
      }
      if (method === 'session.model.get') {
        return Promise.resolve({
          currentModel: 'claude-sonnet-4-6',
          modelInfo: {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            family: 'sonnet',
            provider: 'anthropic',
          },
        });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      if (method === 'session.thinking.set') {
        return Promise.resolve({ success: true });
      }
      if (method === 'session.model.switch') {
        return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
      }
      return Promise.resolve({});
    });

    const spawnedMembersB: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session-b',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembersB });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'reviewer-session-b',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });

    // thinking.set should NOT have been called again for the new session
    const thinkingSetCallsForB = mockRequest.mock.calls.filter(
      (call) => call[0] === 'session.thinking.set' && call[1]?.sessionId === 'reviewer-session-b'
    );
    expect(thinkingSetCallsForB).toHaveLength(0);
  });
  it('retries model auto-apply when session.model.switch returns failure', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    // Always return failure so the target is never marked applied
    mockRequest.mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'claude-opus-4-5',
              display_name: 'Claude Opus 4.5',
              description: '',
              provider: 'anthropic',
            },
          ],
        });
      }
      if (method === 'session.model.get') {
        return Promise.resolve({
          currentModel: 'claude-sonnet-4-6',
          modelInfo: {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            family: 'sonnet',
            provider: 'anthropic',
          },
        });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      if (method === 'session.model.switch') {
        return Promise.resolve({ success: false, error: 'Provider unavailable' });
      }
      return Promise.resolve({});
    });

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[] } }
    );

    await act(async () => {
      await result.current.switchModel(model);
    });

    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembers });

    // Wait for the failure call to happen
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'reviewer-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });

    const callsBefore = mockRequest.mock.calls.filter(
      (call) => call[0] === 'session.model.switch'
    ).length;

    // Now make the mock return success and re-render
    mockRequest.mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'claude-opus-4-5',
              display_name: 'Claude Opus 4.5',
              description: '',
              provider: 'anthropic',
            },
          ],
        });
      }
      if (method === 'session.model.get') {
        return Promise.resolve({
          currentModel: 'claude-sonnet-4-6',
          modelInfo: {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            family: 'sonnet',
            provider: 'anthropic',
          },
        });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      if (method === 'session.model.switch') {
        return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
      }
      return Promise.resolve({});
    });

    rerender({ members: [...spawnedMembers] });

    await waitFor(() => {
      const callsAfter = mockRequest.mock.calls.filter(
        (call) => call[0] === 'session.model.switch'
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it('refreshes model state after successful auto-apply for selected target', async () => {
    const notStartedTarget = {
      id: 'node:n1:reviewer',
      kind: 'node_agent' as const,
      label: 'Reviewer',
      agentName: 'reviewer',
    };

    const model: ModelInfo = {
      id: 'claude-opus-4-5',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      alias: 'opus',
      contextWindow: 200000,
      description: '',
      releaseDate: '',
      available: true,
    };

    let modelGetCallCount = 0;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'claude-opus-4-5',
              display_name: 'Claude Opus 4.5',
              description: '',
              provider: 'anthropic',
            },
          ],
        });
      }
      if (method === 'session.model.get') {
        modelGetCallCount++;
        return Promise.resolve({
          currentModel: 'claude-sonnet-4-6',
          modelInfo: {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            family: 'sonnet',
            provider: 'anthropic',
          },
        });
      }
      if (method === 'session.thinking.get') {
        return Promise.resolve({ thinkingLevel: 'off' });
      }
      if (method === 'session.model.switch') {
        return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
      }
      return Promise.resolve({});
    });

    const { result, rerender } = renderHook(
      (props: { members: SpaceTaskActivityMember[] }) =>
        useTargetSessionContext({
          taskId: 'task-1',
          targets: [notStartedTarget],
          selectedTarget: notStartedTarget,
          activityMembers: props.members,
        }),
      { initialProps: { members: [] as SpaceTaskActivityMember[] } }
    );

    await act(async () => {
      await result.current.switchModel(model);
    });

    const spawnedMembers: SpaceTaskActivityMember[] = [
      {
        id: 'm-reviewer',
        sessionId: 'reviewer-session',
        kind: 'node_agent',
        label: 'Reviewer',
        role: 'reviewer',
        state: 'active',
        processingStatus: 'idle',
        messageCount: 0,
      },
    ];

    rerender({ members: spawnedMembers });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'reviewer-session',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      });
    });

    // After auto-apply succeeds, reload() should trigger an additional
    // session.model.get so the UI reflects the newly applied model.
    await waitFor(() => {
      expect(modelGetCallCount).toBeGreaterThanOrEqual(2);
    });
  });
});
