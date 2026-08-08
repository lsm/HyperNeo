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
 * from the persisted dispatched kickoff (falling back to the workflow's route
 * instructions), re-attaches space-agent-tools, AND persists the derived flag so
 * subsequent query-time policy reads agree.
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
import { appendPostApprovalCompletionInstructions } from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { Space, SpaceTask, SpaceWorkflow, NodeExecution } from '@hyperneo/shared';

const SPACE_ID = 'space-879-r';
const RUN_ID = 'run-879-r';
const TASK_ID = 'task-879-r';
const SUB_SESSION_ID = 'space:space-879-r:task:task-879-r:exec:exec-merger';

interface CapturingSession {
  session: { id: string };
  config: { mcpServers: Record<string, unknown>; disallowedTools: string[] };
  merged: Record<string, unknown>[];
  onMissingMemberSpaceMcpServers?: (...a: unknown[]) => Promise<void>;
  mergeRuntimeMcpServers: (additional: Record<string, unknown>) => void;
  getSessionData: () => { config: CapturingSession['config'] };
  startStreamingQuery: () => Promise<void>;
}

// Module-level ordered-events log: CapturingSession.mergeRuntimeMcpServers
// records 'attach', and the replay override records 'replay'. Reset per test so
// each can assert the attach-before-replay ordering.
let orderedEvents: string[] = [];

function makeCapturingSession(id: string): CapturingSession {
  const config = { mcpServers: { 'node-agent': {} }, disallowedTools: [] };
  const fake = {
    session: { id },
    config,
    merged: [] as Record<string, unknown>[],
    mergeRuntimeMcpServers(additional: Record<string, unknown>) {
      fake.merged.push(additional);
      fake.config.mcpServers = { ...fake.config.mcpServers, ...additional };
      orderedEvents.push('attach');
    },
    getSessionData() {
      return { config: fake.config };
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
    db: {
      getDatabase: () => new BunDatabase(':memory:'),
      // No persisted user messages by default → sessionRequiresMergeGate returns
      // false and the template scan is the legacy-derive fallback. Tests that
      // exercise the persisted-kickoff derive override this.
      getUserMessages: () => [] as Array<{ uuid: string; timestamp: number; content: string }>,
    },
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
  o.replayPendingMessagesAfterRuntimeProvisioning = async () => {
    orderedEvents.push('replay');
  };
  return { manager, taskUpdates };
}

describe('rehydrateSubSession — designated-merger MCP provisioning (#879 P1-1)', () => {
  let restoreSpy: ReturnType<typeof spyOn<typeof AgentSession, 'restore'>>;

  beforeEach(() => {
    orderedEvents = [];
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
    // The restore attached space-agent-tools BEFORE replaying pending input —
    // a regression that replayed first (running the kickoff without the gate)
    // would fail this ordering check.
    expect(orderedEvents.indexOf('attach')).toBeLessThan(orderedEvents.indexOf('replay'));
  });

  test('throws before replay if the restored config disallows merge_pr (#879 3740839499)', async () => {
    // The restore path must assert merge_pr availability like the spawn path —
    // a designated merger whose persisted config disallows merge_pr must NOT
    // resume (it would fall back to the forbidden raw path). Throws before
    // replay, so replay never runs.
    const { manager } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: true,
    });
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    // Disallow merge_pr on the restored session (simulates a persisted
    // disallowedTools entry carried into restore).
    restoreSpy.mockImplementationOnce(((sid: string) => {
      const fake = makeCapturingSession(sid);
      fake.config.disallowedTools = ['mcp__space-agent-tools__*'];
      return fake;
    }) as unknown as typeof AgentSession.restore);

    await expect(o.rehydrateSubSession(SUB_SESSION_ID)).rejects.toThrow(/merge_pr/);
    // The assert fired before replay, so the kickoff was not replayed.
    expect(orderedEvents).not.toContain('replay');
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

  test('derives the role from the persisted interpolated kickoff when the template is interpolated (#879 3740919588)', async () => {
    // A legacy NULL row whose route template delegates the procedure to signal
    // data — e.g. `instructions: '{{next_action}}'`, interpolated at dispatch to
    // "Call merge_pr(...)" — was provisioned at dispatch but a raw template scan
    // returns false. The persisted (interpolated) kickoff is the authoritative
    // record of what was dispatched, so rehydrate must derive from IT.
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: null,
    });
    // Template has NO merge_pr token (the procedure arrives via interpolation).
    (
      manager.config as unknown as { spaceWorkflowManager: { getWorkflow: () => SpaceWorkflow } }
    ).spaceWorkflowManager.getWorkflow = () =>
      ({
        id: 'wf-1',
        nodes: [
          {
            id: 'pa',
            name: 'Post-Approval',
            agents: [{ agentId: 'PR Merger', name: 'merger' }],
            postApproval: { targetAgent: 'merger', instructions: '{{next_action}}' },
          },
        ],
      }) as unknown as SpaceWorkflow;
    // The persisted kickoff carries the interpolated merge procedure. It is
    // wrapped in the same completion-instructions block the router appends to
    // every dispatch — that block is how sessionRequiresMergeGate identifies
    // the dispatched kickoff among the session's historical user turns.
    (
      manager.config as unknown as {
        db: { getUserMessages: () => Array<{ uuid: string; timestamp: number; content: string }> };
      }
    ).db.getUserMessages = () => [
      {
        uuid: 'kickoff-1',
        timestamp: 1,
        content: appendPostApprovalCompletionInstructions(
          'Call merge_pr(pr_url="https://x", task_id="t")'
        ),
      },
    ];
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    // Derived from the persisted kickoff (the template scan alone would miss it).
    expect(allMerged).toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeDefined();
    expect(taskUpdates).toEqual([{ id: TASK_ID, params: { postApprovalRequiresMerge: true } }]);
  });

  test('ignores an EARLIER user turn that mentions merge_pr when the dispatched kickoff is non-merge (#879 3740986212)', async () => {
    // A reused worker's history can contain an earlier turn that merely
    // mentions merge_pr (its original node kickoff, a steering relay) while the
    // actual dispatched post-approval kickoff is non-merge. Scanning every
    // historical user row would misclassify the session, persist the flag, and
    // mount space-agent-tools — which loadAuthorizedTask then authorises to
    // merge by session identity. The derive must read ONLY the dispatched
    // kickoff (identified by the appended completion-instructions block).
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: null,
    });
    // Non-merge route so the template-scan fallback also reads non-merge — the
    // ONLY merge_pr mention in play is the earlier non-kickoff user turn.
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
    (
      manager.config as unknown as {
        db: { getUserMessages: () => Array<{ uuid: string; timestamp: number; content: string }> };
      }
    ).db.getUserMessages = () => [
      {
        uuid: 'worker-kickoff',
        timestamp: 1,
        content:
          '## Your Task #1\nReview the PR. Do NOT call merge_pr yourself — the merger handles it.',
      },
      {
        uuid: 'pa-kickoff',
        timestamp: 2,
        content: appendPostApprovalCompletionInstructions(
          'Archive the run artifacts, then finish.'
        ),
      },
    ];
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).not.toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeUndefined();
    expect(taskUpdates).toHaveLength(0);
  });

  test('derives from the LATEST dispatched kickoff when more than one is persisted (#879 3740986212)', async () => {
    // Two marker-carrying kickoffs in one session (e.g. a non-merge re-dispatch
    // after an earlier merge dispatch): the latest dispatch is authoritative.
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: null,
    });
    // Non-merge route so the template-scan fallback cannot mask the result.
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
    (
      manager.config as unknown as {
        db: { getUserMessages: () => Array<{ uuid: string; timestamp: number; content: string }> };
      }
    ).db.getUserMessages = () => [
      {
        uuid: 'pa-kickoff-1',
        timestamp: 1,
        content: appendPostApprovalCompletionInstructions(
          'Call merge_pr(pr_url="https://x", task_id="t")'
        ),
      },
      {
        uuid: 'pa-kickoff-2',
        timestamp: 2,
        content: appendPostApprovalCompletionInstructions('save_artifact then mark_complete'),
      },
    ];
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).not.toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeUndefined();
    expect(taskUpdates).toHaveLength(0);
  });

  test('a dispatched NON-merge kickoff beats a merge-mentioning template fallback (#879 3741142847)', async () => {
    // Tri-state: a FOUND dispatched kickoff is authoritative even when it is
    // non-merge — the workflow-template scan must run ONLY when no dispatched
    // kickoff exists. Without this, a legacy NULL row whose kickoff was
    // explicitly non-merge (e.g. `{{merge_pr}}` interpolated to non-merge text,
    // or a workflow edited after dispatch) would be re-classified as a merger by
    // the now-merge-mentioning template, mounting space-agent-tools and
    // persisting merge authorization for a session whose dispatched route was
    // non-merge.
    const { manager, taskUpdates } = makeManager({
      postApprovalSessionId: SUB_SESSION_ID,
      postApprovalRequiresMerge: null,
    });
    // The CURRENT workflow template DOES mention merge_pr — the fallback scan
    // would classify as merger if it ever ran.
    (
      manager.config as unknown as { spaceWorkflowManager: { getWorkflow: () => SpaceWorkflow } }
    ).spaceWorkflowManager.getWorkflow = () =>
      ({
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
      }) as unknown as SpaceWorkflow;
    // ...but the DISPATCHED kickoff was non-merge.
    (
      manager.config as unknown as {
        db: { getUserMessages: () => Array<{ uuid: string; timestamp: number; content: string }> };
      }
    ).db.getUserMessages = () => [
      {
        uuid: 'pa-kickoff',
        timestamp: 1,
        content: appendPostApprovalCompletionInstructions('save_artifact then mark_complete'),
      },
    ];
    const o = manager as unknown as { rehydrateSubSession: (sid: string) => Promise<unknown> };

    await o.rehydrateSubSession(SUB_SESSION_ID);

    const fake = restoreSpy.mock.results[0]?.value as CapturingSession;
    const allMerged = Object.assign({}, ...fake.merged);
    expect(allMerged).not.toHaveProperty('space-agent-tools');
    expect(fake.onMissingMemberSpaceMcpServers).toBeUndefined();
    // No role rewrite — the found non-merge kickoff is authoritative.
    expect(taskUpdates).toHaveLength(0);
  });
});
