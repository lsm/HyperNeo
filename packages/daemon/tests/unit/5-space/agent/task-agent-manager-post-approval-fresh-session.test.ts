/**
 * Post-approval sub-session delivery — reuse-if-exists else create.
 *
 * Regression for #816 (GitHub #2323): approving a task whose post-approval
 * target agent already had a live session never ran the merge. The earlier
 * #850 fix (force a fresh session) worked but for the wrong reason and
 * contradicted the intended design. The real cause was createSubSession's
 * reuse path calling `restartQuery()` (via reinjectNodeAgentMcpServer), which
 * interrupts the agent's active drive → "Interrupted by user".
 *
 * Current design: `spawnPostApprovalSubSession` reuses the target agent's
 * LIVE session and injects the kickoff directly — bypassing createSubSession's
 * reuse path (and its restartQuery) entirely. It only creates a fresh session
 * when the agent has no live session. Direct injection never interrupts: it
 * enqueues when busy and starts a fresh turn when idle.
 *
 * These tests construct a real TaskAgentManager (the constructor only touches
 * db.getDatabase() for an inert McpAuditLogRepository and subscribes to the
 * event bus) and drive the methods with stubbed AgentSession.fromInit + repo
 * / space / injection helpers, so the reuse-vs-create DECISION is exercised
 * — not a mock of it.
 *
 * Coverage:
 *   - spawnPostApprovalSubSession reuses a live target session (returns its id,
 *     injects the kickoff into it, does NOT create a fresh session).
 *   - createSubSession still reuses the prior session for a normal second node
 *     activation (no special flag) — the hard constraint.
 *   - createSubSession creates a new session when no prior session exists.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSession as AgentSessionType } from '../../../../src/lib/agent/agent-session.ts';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

const TASK_ID = 'task-850';
const RUN_ID = 'run-850';
const SPACE_ID = 'space-850';
const REVIEWER_NODE_ID = 'node-reviewer';
const REVIEWER_AGENT = 'reviewer';
const REVIEWER_SESSION_ID = 'reviewer-session-live';

/** Fake AgentSession: records the heavy lifecycle methods createSubSession calls. */
function makeFakeSession(id: string = REVIEWER_SESSION_ID) {
  const calls: string[] = [];
  const session = {
    session: { id },
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

/**
 * Fake AgentSession that CAPTURES every `mergeRuntimeMcpServers` argument, so a
 * test can assert exactly which MCP servers reached the session's runtime map
 * (the map `QueryRunner.ensureMemberSpaceMcpInvariant` reads at first turn).
 * Also exposes a settable `onMissingMemberSpaceMcpServers` for self-heal wiring.
 */
function makeCapturingFakeSession(id: string): {
  session: AgentSessionType;
  mergedArgs: Record<string, unknown>[];
} {
  const mergedArgs: Record<string, unknown>[] = [];
  const session = {
    session: { id },
    skillOverrides: undefined,
    toolGuards: undefined,
    onMissingWorkflowMcpServers: undefined,
    onMissingMemberSpaceMcpServers: undefined as
      | ((sessionId: string, missing: string[]) => Promise<void>)
      | undefined,
    updateConfig: async (): Promise<void> => {},
    mergeRuntimeMcpServers: (arg: Record<string, unknown>): void => {
      mergedArgs.push(arg);
    },
    startStreamingQuery: async (): Promise<void> => {},
  };
  return { session: session as unknown as AgentSessionType, mergedArgs };
}

function reviewerExec(sessionId: string = REVIEWER_SESSION_ID) {
  return {
    id: 'reviewer-exec-1',
    workflowRunId: RUN_ID,
    workflowNodeId: REVIEWER_NODE_ID,
    agentName: REVIEWER_AGENT,
    agentId: 'agent-reviewer',
    agentSessionId: sessionId,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
  };
}

function makeManager(rows: unknown[] = [reviewerExec()]): TaskAgentManager {
  return new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager: { registerSession: () => {} },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'Task 850' }),
      // spawnPostApprovalSubSession stamps the designated-merger role on the task
      // before the kickoff (#879 / 3740713905); provide a no-op so the create
      // branch under test reaches the kickoff.
      updateTask: () => {},
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => rows,
      listByNode: () => rows,
      update: () => rows[0],
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    // pendingMessageRepo / appMcpManager intentionally absent → flush + mcp
    // config resolution become no-ops inside createSubSession.
  } as unknown as TaskAgentManagerConfig);
}

/** Seed a live session in BOTH indexes getSubSession / findLiveSubSessionForAgent read. */
function seedLiveSession(
  tam: TaskAgentManager,
  sessionId: string = REVIEWER_SESSION_ID
): AgentSessionType {
  const { session } = makeFakeSession(sessionId);
  const subSessions = (
    tam as unknown as {
      subSessions: Map<string, Map<string, AgentSessionType>>;
    }
  ).subSessions;
  if (!subSessions.has(TASK_ID)) subSessions.set(TASK_ID, new Map());
  subSessions.get(TASK_ID)!.set(sessionId, session);
  (tam as unknown as { agentSessionIndex: Map<string, AgentSessionType> }).agentSessionIndex.set(
    sessionId,
    session
  );
  return session;
}

/** No-op the reuse-path instance helpers so the decision under test is reached. */
function stubReusePathHelpers(tam: TaskAgentManager): void {
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

describe('spawnPostApprovalSubSession — reuse-if-exists else create', () => {
  let fromInitSpy: ReturnType<typeof spyOn<typeof AgentSession, 'fromInit'>>;

  beforeEach(() => {
    fromInitSpy = spyOn(AgentSession, 'fromInit').mockImplementation(
      (() => makeFakeSession('fresh-session').session) as unknown as typeof AgentSession.fromInit
    );
  });
  afterEach(() => {
    fromInitSpy.mockRestore();
  });

  test('reuses the target agent live session and injects the kickoff directly (no fresh session)', async () => {
    const tam = makeManager();
    seedLiveSession(tam); // reviewer already has a LIVE session
    const injected: Array<{ sessionId: string; message: string }> = [];
    (
      tam as unknown as {
        injectMessageIntoSession: (s: { session: { id: string } }, m: string) => Promise<string>;
      }
    ).injectMessageIntoSession = async (s, m) => {
      injected.push({ sessionId: s.session.id, message: m });
      return 'msg-id';
    };

    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
      name: 'Coding',
      nodes: [
        {
          id: REVIEWER_NODE_ID,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: REVIEWER_AGENT }],
        },
      ],
      channels: [],
      startNodeId: REVIEWER_NODE_ID,
      endNodeId: REVIEWER_NODE_ID,
    } as unknown as SpaceWorkflow;
    const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID } as unknown as SpaceTask;

    const result = await tam.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent: REVIEWER_AGENT,
      kickoffMessage: 'merge the PR',
    });

    expect(result.sessionId).toBe(REVIEWER_SESSION_ID);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toEqual({ sessionId: REVIEWER_SESSION_ID, message: 'merge the PR' });
    // No fresh session created — the whole point of reuse-if-exists.
    expect(fromInitSpy).not.toHaveBeenCalled();
  });

  test('createSubSession still reuses the prior session for a normal second activation (hard constraint)', async () => {
    const tam = makeManager();
    seedLiveSession(tam);
    stubReusePathHelpers(tam);

    const memberInfo = {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
      // No special flag — reuse MUST still apply so a second review cycle
      // injects into the existing reviewer session.
    };
    const proposedId = 'some-other-proposed-id';

    const actual = await tam.createSubSession(TASK_ID, proposedId, minimalInit(), memberInfo);

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(actual).not.toBe(proposedId);
    expect(fromInitSpy).not.toHaveBeenCalled();
  });

  test('createSubSession creates a new session when no prior session exists', async () => {
    const tam = makeManager([]); // no prior NodeExecution for this agent

    const freshId = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${REVIEWER_AGENT}`;
    const actual = await tam.createSubSession(TASK_ID, freshId, minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    });

    expect(actual).toBe(freshId);
    expect(fromInitSpy).toHaveBeenCalledTimes(1);
  });

  // Regression for #852: the built-in `merger` (and any post-approval target with no
  // live session) takes the CREATE branch. That session is classified as an ad-hoc
  // Space member by resolveSpaceMcpSessionPolicy, so ensureMemberSpaceMcpInvariant
  // REQUIRES `space-agent-tools` on it. Previously the spawn attached only node-agent
  // + agent-memory, so the first turn threw the MCP-invariant error (misrecorded as
  // "Interrupted by user"). This test pins the fix: space-agent-tools is attached via
  // the shared member builder and reaches the session's runtime MCP map (the map the
  // invariant reads) before the first turn, and the self-heal callback is wired.
  test('CREATE branch attaches space-agent-tools before first turn + wires self-heal (#852)', async () => {
    const tam = makeManager([]); // no NodeExecution row → no live session → CREATE branch
    // resolveSessionId probes db.getSession(); makeManager omits it, so add a stub.
    (tam.config as unknown as { db: Record<string, unknown> }).db.getSession = () => null;
    (tam.config as unknown as Record<string, unknown>).workflowRunRepo = { getRun: () => null };
    (tam.config as unknown as Record<string, unknown>).spaceAgentManager = {
      getById: () => ({
        id: 'agent-reviewer',
        name: REVIEWER_AGENT,
        customPrompt: 'merge the approved PR',
        model: 'm',
        tools: [],
      }),
    };

    const satMarker = { __role: 'space-agent-tools' };
    const buildCalls: Array<{ spaceId: string; sessionId: string }> = [];
    const reattachCalls: string[] = [];
    (tam.config as unknown as Record<string, unknown>).spaceRuntimeService = {
      buildMemberSpaceToolsMcpServer: (space: { id: string }, sid: string) => {
        buildCalls.push({ spaceId: space.id, sessionId: sid });
        return satMarker;
      },
      reattachMemberSpaceTools: async (sid: string) => {
        reattachCalls.push(sid);
      },
    };
    // The real node-agent builder needs many config fields; stub it — node-agent
    // attachment is orthogonal to the space-agent-tools fix under test.
    (
      tam as unknown as { buildNodeAgentMcpServerForSession: () => unknown }
    ).buildNodeAgentMcpServerForSession = () => ({ __role: 'node-agent' });
    (
      tam as unknown as { ensureNodeAgentAttached: (...a: unknown[]) => Promise<void> }
    ).ensureNodeAgentAttached = async () => {};
    (
      tam as unknown as { injectMessageIntoSession: (...a: unknown[]) => Promise<string> }
    ).injectMessageIntoSession = async () => 'msg-id';

    const fake = makeCapturingFakeSession('fresh-merger');
    fromInitSpy.mockImplementation((() => fake.session) as unknown as typeof AgentSession.fromInit);

    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
      name: 'Coding',
      nodes: [
        {
          id: REVIEWER_NODE_ID,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: REVIEWER_AGENT }],
        },
      ],
      channels: [],
      gates: [],
      startNodeId: REVIEWER_NODE_ID,
      endNodeId: REVIEWER_NODE_ID,
    } as unknown as SpaceWorkflow;
    const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID } as unknown as SpaceTask;

    const result = await tam.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent: REVIEWER_AGENT,
      kickoffMessage: 'merge the approved PR',
    });

    // `space-agent-tools` reached the session's runtime MCP map — the exact map
    // QueryRunner.ensureMemberSpaceMcpInvariant inspects at first turn.
    const merged = fake.mergedArgs.at(-1)!;
    expect(merged['space-agent-tools']).toBe(satMarker);
    expect(merged['node-agent']).toEqual({ __role: 'node-agent' });
    // Built via the shared member builder (no hand-rolled server), scoped to this
    // space + the spawned session id.
    expect(buildCalls).toEqual([{ spaceId: SPACE_ID, sessionId: result.sessionId }]);

    // Self-heal callback is wired and delegates to the standard reattach path, so a
    // future regression (cache eviction / DB reload) recovers instead of throwing.
    expect(typeof fake.session.onMissingMemberSpaceMcpServers).toBe('function');
    await fake.session.onMissingMemberSpaceMcpServers!(result.sessionId, ['space-agent-tools']);
    expect(reattachCalls).toEqual([result.sessionId]);
  });
});
