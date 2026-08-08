/**
 * Rehydrate test for the designated-merger MCP provisioning (task #879 P1-1).
 *
 * After a daemon restart a reused `:exec:` merger session is restored by
 * `TaskAgentManager.rehydrateSubSession`, which rebuilds runtime MCP servers
 * from code (the in-memory eager attach from the spawn path does not persist).
 * For a task whose `postApprovalSessionId === <this session>` AND whose route
 * requires the merge gate (`postApprovalRequiresMerge`), rehydrate must
 * re-attach `space-agent-tools` (hosts merge_pr) and wire the Space-member
 * self-heal — otherwise the resumed first turn throws in
 * `ensureMemberSpaceMcpInvariant` (the policy now requires space-agent-tools for
 * the designated merger). A non-merge reused post-approval worker must NOT get
 * it (the P1-2 precision fix).
 *
 * `rehydrateSubSession` is private and owns a lot of I/O (AgentSession.restore,
 * node-agent build, query restart, …); like the sibling fresh-session test we
 * exercise the real method but spy on `AgentSession.restore` and override the
 * I/O-owning instance methods, so the new provisioning logic runs against a
 * capturing fake session.
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { Space, SpaceTask, SpaceWorkflow, NodeExecution } from '@hyperneo/shared';

const SPACE_ID = 'space-879-r';
const RUN_ID = 'run-879-r';
const TASK_ID = 'task-879-r';
const SUB_SESSION_ID = 'space:space-879-r:task:task-879-r:exec:exec-merger';

interface CapturingSession {
  session: { id: string };
  merged: Record<string, unknown>[];
  onMissingMemberSpaceMcpServers?: (...a: unknown[]) => Promise<void>;
  mergeRuntimeMcpServers: (additional: Record<string, unknown>) => void;
  startStreamingQuery: () => Promise<void>;
}

function makeCapturingSession(id: string): CapturingSession {
  const fake = {
    session: { id },
    merged: [] as Record<string, unknown>[],
    mergeRuntimeMcpServers(additional: Record<string, unknown>) {
      fake.merged.push(additional);
    },
    async startStreamingQuery() {},
  };
  return fake;
}

function makeManager(parentTask: Partial<SpaceTask>): TaskAgentManager {
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as Space;
  const manager = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    internalEventBus: { subscribe: () => () => {} },
    taskRepo: {
      listByWorkflowRunIncludingArchived: () => [
        { id: TASK_ID, spaceId: SPACE_ID, status: 'approved', ...parentTask },
      ],
    },
    nodeExecutionRepo: {},
    spaceManager: { getSpace: async () => space },
    workflowRunRepo: { getRun: () => ({ id: RUN_ID, status: 'in_progress', workflowId: 'wf-1' }) },
    spaceWorkflowManager: {
      getWorkflow: () =>
        ({
          id: 'wf-1',
          nodes: [
            { id: 'pa', name: 'Post-Approval', agents: [{ agentId: 'PR Merger', name: 'merger' }] },
          ],
        }) as unknown as SpaceWorkflow,
    },
    sessionManager: { registerSession: () => {} },
    spaceRuntimeService: {
      buildMemberSpaceToolsMcpServer: () => ({ __builtIn: 'space-agent-tools' }),
      reattachMemberSpaceTools: async () => {},
    },
  } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);

  // Override the I/O-owning instance methods so the real provisioning logic
  // (the designated-merger MCP merge + self-heal wiring) runs in isolation.
  const o = manager as unknown as Record<string, unknown>;
  o.resolveNodeExecutionForSubSession = () =>
    ({
      id: 'exec-merger',
      workflowRunId: RUN_ID,
      workflowNodeId: 'pa',
      agentName: 'merger',
      agentSessionId: SUB_SESSION_ID,
      status: 'in_progress',
    }) as NodeExecution;
  o.resolveCurrentNodeAgentInitForExecution = () => null; // skip prompt re-apply
  o.buildNodeAgentMcpServerForSession = () => ({ __nodeAgent: true });
  o.buildAgentMemoryMcpServers = () => ({});
  o.ensureNodeAgentAttached = async () => {};
  o.registerCompletionCallback = () => {};
  o.sanitizeSDKSessionTranscriptForRehydration = () => {};
  o.replayPendingMessagesAfterRuntimeProvisioning = async () => {};
  return manager;
}

describe('rehydrateSubSession — designated-merger MCP provisioning (#879 P1-1)', () => {
  let restoreSpy: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

  beforeEach(() => {
    restoreSpy = spyOn(AgentSession, 'restore').mockImplementation(((sid: string) =>
      makeCapturingSession(sid)) as unknown as typeof AgentSession.restore);
  });
  afterEach(() => {
    restoreSpy.mockRestore();
  });

  test('re-attaches space-agent-tools and wires the member self-heal for a designated merger', async () => {
    const manager = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: true,
    });
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    const result = await o.rehydrateSubSession(SUB_SESSION_ID);
    expect(result).toBeDefined();

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    // space-agent-tools was merged (alongside node-agent) on rehydrate.
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).toHaveProperty('space-agent-tools');
    // The Space-member self-heal callback is wired (for cache eviction recovery).
    expect(fake.onMissingMemberSpaceMcpServers).toBeDefined();
  });

  test('does NOT attach space-agent-tools for a non-merge reused post-approval worker (#879 P1-2)', async () => {
    // Same session is the post-approval session, but the route is NOT a merge
    // route — rehydrate must provision only node-agent (+ agent-memory).
    const manager = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: false,
    });
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).not.toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeUndefined();
  });
});
