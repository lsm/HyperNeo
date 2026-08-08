/**
 * Rehydrate test for the designated-merger MCP provisioning (task #879 P1-1).
 *
 * After a daemon restart a reused `:exec:` merger session is restored by
 * `TaskAgentManager.rehydrateSubSession`, which rebuilds runtime MCP servers
 * from code (the in-memory eager attach from the spawn path does not persist).
 * For a task whose `postApprovalSessionId === <this session>` AND whose route
 * requires the merge gate, rehydrate must re-attach `space-agent-tools` (hosts
 * merge_pr) and wire the Space-member self-heal — otherwise the resumed first
 * turn throws in `ensureMemberSpaceMcpInvariant` (the policy requires
 * space-agent-tools for the designated merger). A non-merge reused post-approval
 * worker must NOT get it (the P1-2 precision fix).
 *
 * Also covers a LEGACY row whose `postApprovalRequiresMerge` is NULL (dispatched
 * before migration 179 added the column): rehydrate lazy-derives the requirement
 * from the workflow's route instructions, re-attaches space-agent-tools, AND
 * persists the derived flag so subsequent query-time policy reads agree.
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

/** A workflow whose post-approval route requires the merge gate. */
function makeMergeWorkflow(): SpaceWorkflow {
  return {
    id: 'wf-1',
    nodes: [
      {
        id: 'pa',
        name: 'Post-Approval',
        agents: [{ agentId: 'PR Merger', name: 'merger' }],
        postApproval: {
          targetAgent: 'merger',
          instructions: 'Call merge_pr(pr_url="{{pr_url}}", task_id="{{task_id}}")',
        },
      },
    ],
  } as unknown as SpaceWorkflow;
}

function makeManager(parentTask: Partial<SpaceTask>): {
  manager: TaskAgentManager;
  taskUpdates: Array<{ id: string; params: Record<string, unknown> }>;
} {
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as Space;
  const taskUpdates: Array<{ id: string; params: Record<string, unknown> }> = [];
  const manager = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    internalEventBus: { subscribe: () => () => {} },
    taskRepo: {
      listByWorkflowRunIncludingArchived: () => [
        { id: TASK_ID, spaceId: SPACE_ID, status: 'approved', ...parentTask },
      ],
      updateTask: (id: string, params: Record<string, unknown>) => taskUpdates.push({ id, params }),
    },
    nodeExecutionRepo: {},
    spaceManager: { getSpace: async () => space },
    workflowRunRepo: { getRun: () => ({ id: RUN_ID, status: 'in_progress', workflowId: 'wf-1' }) },
    spaceWorkflowManager: { getWorkflow: () => makeMergeWorkflow() },
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
  return { manager, taskUpdates };
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
    const { manager } = makeManager({
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
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: false,
    });
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).not.toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeUndefined();
    // No role rewrite — the flag is already explicit (false).
    expect(taskUpdates).toHaveLength(0);
  });

  test('lazy-derives + persists the role for a LEGACY NULL flag (#879 round-3)', async () => {
    // A row dispatched before migration 179 has postApprovalRequiresMerge = NULL.
    // rehydrate must derive the requirement from the workflow's route (it
    // references merge_pr), re-attach space-agent-tools, AND persist the derived
    // flag so subsequent query-time policy reads classify this session correctly.
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: null,
    });
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeDefined();
    // Persisted the derived value — replaces the blanket migration backfill.
    expect(taskUpdates).toEqual([{ id: TASK_ID, params: { postApprovalRequiresMerge: true } }]);
  });

  test('does NOT over-provision a legacy NULL row whose workflow has no merge route', async () => {
    // A legacy non-merge route (NULL flag, no merge route in the workflow) must
    // NOT be given space-agent-tools — the precision that the blanket backfill
    // sacrificed. Overrides the workflow to one without a merge route.
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: null,
    });
    (
      manager.config as unknown as { spaceWorkflowManager: { getWorkflow: () => SpaceWorkflow } }
    ).spaceWorkflowManager.getWorkflow = () =>
      ({
        id: 'wf-1',
        nodes: [
          {
            id: 'pa',
            name: 'Post-Approval',
            agents: [{ agentId: 'Deploy', name: 'deployer' }],
            postApproval: {
              targetAgent: 'deployer',
              instructions: 'save_artifact then mark_complete',
            },
          },
        ],
      }) as unknown as SpaceWorkflow;
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).not.toHaveProperty('space-agent-tools');
    // Nothing persisted (the row stays NULL; a future non-merge turn is fine).
    expect(taskUpdates).toHaveLength(0);
  });
});
