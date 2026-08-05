/**
 * TaskAgentManager.createSubSession — post-approval must spawn a FRESH session.
 *
 * Regression for #850 (repro #816 / GitHub #2323): approving a Coding-Workflow
 * task whose reviewer node-agent session was still live never triggered the
 * post-approval merge. Root cause: `spawnPostApprovalSubSession` targets the
 * `reviewer` agent, and `createSubSession`'s unconditional agentName reuse
 * policy handed back the reviewer's still-live (mid-teardown) session instead
 * of spawning a fresh merge session → the SDK threw "Interrupted by user"
 * before `postApprovalSessionId` was stamped → the task parked in `approved`.
 *
 * Fix: `SubSessionMemberInfo.forceNewSession` bypasses the reuse lookup so the
 * post-approval spawn produces a genuinely fresh session.
 *
 * These tests construct a real TaskAgentManager (the constructor only touches
 * `db.getDatabase()` for an inert McpAuditLogRepository and subscribes to the
 * event bus) and drive `createSubSession` with a stubbed `AgentSession.fromInit`
 * plus stubbed repo / mcp helpers, so the reuse-vs-fresh DECISION is exercised
 * — not a mock of it.
 *
 * Coverage:
 *   - forceNewSession=true with a prior live reviewer session → a fresh id,
 *     distinct from the reviewer's; `AgentSession.fromInit` invoked.
 *   - forceNewSession omitted (normal node re-execution) → reuses the prior
 *     session id; `AgentSession.fromInit` NOT invoked. This is the hard
 *     constraint: reuse MUST still apply for a second review cycle.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { SubSessionMemberInfo } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSession as AgentSessionType } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

const TASK_ID = 'task-850';
const RUN_ID = 'run-850';
const SPACE_ID = 'space-850';
const REVIEWER_NODE_ID = 'node-reviewer';
const REVIEWER_AGENT = 'reviewer';
const REVIEWER_SESSION_ID = 'reviewer-session-live';

/** Fake AgentSession: records the heavy lifecycle methods createSubSession calls. */
function makeFakeSession() {
  const calls: string[] = [];
  const session = {
    skillOverrides: undefined,
    toolGuards: undefined,
    onMissingWorkflowMcpServers: undefined,
    updateConfig: async (): Promise<void> => {
      calls.push('updateConfig');
    },
    mergeRuntimeMcpServers: (): void => {
      calls.push('mergeRuntimeMcpServers');
    },
    startStreamingQuery: async (): Promise<void> => {
      calls.push('startStreamingQuery');
    },
  };
  return { session: session as unknown as AgentSessionType, calls };
}

function makeManager(): TaskAgentManager {
  // Prior reviewer NodeExecution — simulates "reviewer already ran and its
  // session is still live at approval time" (sessions persist until archive).
  const reviewerExec = {
    id: 'reviewer-exec-1',
    workflowRunId: RUN_ID,
    workflowNodeId: REVIEWER_NODE_ID,
    agentName: REVIEWER_AGENT,
    agentId: 'agent-reviewer',
    agentSessionId: REVIEWER_SESSION_ID,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
  };
  const rows = [reviewerExec];

  const taskRepo = {
    getTask: () => ({
      id: TASK_ID,
      spaceId: SPACE_ID,
      workflowRunId: RUN_ID,
      title: 'Task 850',
    }),
  };
  const nodeExecutionRepo = {
    listByWorkflowRun: () => rows,
    listByNode: () => rows,
    update: () => reviewerExec,
  };
  const sessionManager = {
    registerSession: () => {},
  };

  return new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager,
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo,
    nodeExecutionRepo,
    // pendingMessageRepo / appMcpManager intentionally absent → flush + mcp
    // config resolution become no-ops inside createSubSession.
  } as unknown as TaskAgentManagerConfig);
}

/** Pre-seed the reviewer's live session + no-op the reuse-path instance helpers. */
function seedReviewerSession(tam: TaskAgentManager): void {
  (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> }).agentSessionIndex.set(
    REVIEWER_SESSION_ID,
    makeFakeSession().session
  );
  // The reuse path calls these on the seeded session; stub them to no-ops so
  // the decision under test is reached without the full MCP re-injection stack.
  (
    tam as unknown as { reinjectNodeAgentMcpServer: (...a: unknown[]) => Promise<void> }
  ).reinjectNodeAgentMcpServer = async () => {};
  (
    tam as unknown as { ensureRequiredMcpServersAttached: (...a: unknown[]) => Promise<void> }
  ).ensureRequiredMcpServersAttached = async () => {};
  (
    tam as unknown as { registerCompletionCallback: (...a: unknown[]) => void }
  ).registerCompletionCallback = () => {};
}

function minimalInit(): AgentSessionInit {
  // `title` is set so createSubSession skips formatWorkflowNodeSessionTitle().
  return { title: 'post-approval', model: 'm', mcpServers: {} } as unknown as AgentSessionInit;
}

describe('createSubSession — post-approval forceNewSession bypass', () => {
  let fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;

  beforeEach(() => {
    // Stub the heavy real session construction so we exercise ONLY the
    // reuse-vs-fresh decision.
    fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation(
      (() => makeFakeSession().session) as unknown as typeof AgentSession.fromInit
    );
  });
  afterEach(() => {
    fromInitSpy.mockRestore();
  });

  test('forceNewSession spawns a fresh session distinct from the prior reviewer session', async () => {
    const tam = makeManager();
    seedReviewerSession(tam);

    const memberInfo: SubSessionMemberInfo = {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
      forceNewSession: true,
    };
    const freshId = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${REVIEWER_AGENT}`;

    const actual = await tam.createSubSession(TASK_ID, freshId, minimalInit(), memberInfo);

    expect(actual).toBe(freshId);
    expect(actual).not.toBe(REVIEWER_SESSION_ID);
    expect(fromInitSpy).toHaveBeenCalledTimes(1);
  });

  test('without forceNewSession, the second activation reuses the prior session (normal node re-execution)', async () => {
    const tam = makeManager();
    seedReviewerSession(tam);

    const memberInfo: SubSessionMemberInfo = {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
      // forceNewSession intentionally omitted — the reuse policy MUST still apply
      // so a second review cycle injects into the existing session.
    };
    const proposedId = 'some-other-proposed-id';

    const actual = await tam.createSubSession(TASK_ID, proposedId, minimalInit(), memberInfo);

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(actual).not.toBe(proposedId);
    expect(fromInitSpy).not.toHaveBeenCalled();
  });
});
