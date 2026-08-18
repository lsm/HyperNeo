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
    // Default idle; individual tests can override to probe other statuses.
    getProcessingState: (): { status: string } => ({ status: 'idle' }),
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
  return makeManagerWithSpaceManager(rows, {
    getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }),
  });
}

/**
 * Space-manager mock that captures the stop/resume registration callbacks the
 * TAM's constructor subscribes to — the peer-injection gate reads the sync
 * stopped-space mirror populated by the onSpaceStopped callback, so tests
 * drive that callback instead of overriding getSpace.
 */
function makeHoldAwareSpaceManager(): {
  manager: {
    getSpace: () => Promise<unknown>;
    onSpaceStoppedRegister: (cb: (id: string) => void) => () => void;
    onSpacePausedRegister: (cb: (id: string) => void) => () => void;
    onSpaceResumedRegister: (cb: (id: string) => void) => () => void;
  };
  stopped: (id: string) => void;
  resumed: (id: string) => void;
} {
  let stoppedCb: ((id: string) => void) | undefined;
  let resumedCb: ((id: string) => void) | undefined;
  return {
    manager: {
      getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws', stopped: false }),
      onSpaceStoppedRegister: (cb) => {
        stoppedCb = cb;
        return () => {};
      },
      onSpacePausedRegister: () => () => {},
      onSpaceResumedRegister: (cb) => {
        resumedCb = cb;
        return () => {};
      },
    },
    stopped: (id) => stoppedCb?.(id),
    resumed: (id) => resumedCb?.(id),
  };
}

function makeManagerWithSpaceManager(rows: unknown[], spaceManager: unknown): TaskAgentManager {
  return new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager: { registerSession: () => {} },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'Task 850' }),
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => rows,
      listByNode: () => rows,
      listByAgentSessionId: () => [],
      update: () => rows[0],
    },
    spaceManager,
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

  test('createSubSession reuses an INTERRUPTED session (resume continues the transcript)', async () => {
    // On resume, a row that kept its binding (e.g. a blocked or non-parked
    // path) reuses the interrupted session — the pause/resume semantic
    // preserves the conversation. The reuse path must NOT treat 'interrupted'
    // as a reason to create a fresh session.
    const tam = makeManager();
    const interrupted = seedLiveSession(tam);
    (
      interrupted as unknown as { getProcessingState: () => { status: string } }
    ).getProcessingState = () => ({ status: 'interrupted' });
    stubReusePathHelpers(tam);

    const memberInfo = {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: REVIEWER_NODE_ID,
    };
    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), memberInfo);

    expect(actual).toBe(REVIEWER_SESSION_ID);
    expect(fromInitSpy).not.toHaveBeenCalled();
  });

  test('stale co-owner sweep preserves blocked status (only active owners become idle)', async () => {
    // The reused session is also referenced by a BLOCKED execution on another
    // node. The sweep must clear the stale session pointer but PRESERVE
    // 'blocked' — rewriting it to idle would suppress processRunTick's
    // blocked-execution detection.
    const NODE_2 = 'node-2';
    const staleCoOwner = {
      id: 'exec-blocked',
      workflowRunId: RUN_ID,
      workflowNodeId: REVIEWER_NODE_ID, // different node
      agentName: REVIEWER_AGENT,
      agentId: 'agent-reviewer',
      agentSessionId: REVIEWER_SESSION_ID, // shared, now owned by node-2
      status: 'blocked',
      result: 'dependency failed',
      data: null,
      createdAt: 0,
      startedAt: 0,
      completedAt: null,
      updatedAt: 0,
    };
    const targetExec = {
      id: 'exec-target',
      workflowRunId: RUN_ID,
      workflowNodeId: NODE_2, // the new owner
      agentName: REVIEWER_AGENT,
      agentId: 'agent-reviewer',
      agentSessionId: null,
      status: 'pending',
      result: null,
      data: null,
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: 0,
    };
    const pendingCoOwner = {
      id: 'exec-pending',
      workflowRunId: RUN_ID,
      workflowNodeId: 'node-3', // another non-owner node
      agentName: REVIEWER_AGENT,
      agentId: 'agent-reviewer',
      agentSessionId: REVIEWER_SESSION_ID, // shared
      status: 'pending', // resetWorkflowNodeExecutionForSpawnRetry keeps the pointer
      result: null,
      data: null,
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      updatedAt: 0,
    };
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: {
        getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, title: 'T' }),
      },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [staleCoOwner, pendingCoOwner, targetExec],
        listByNode: (_runId: string, nodeId: string) =>
          nodeId === NODE_2 ? [targetExec] : [staleCoOwner, pendingCoOwner],
        update: (id: string, payload: Record<string, unknown>) => {
          updates.push({ id, payload });
          return null;
        },
      },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    } as unknown as TaskAgentManagerConfig);
    seedLiveSession(tam);
    stubReusePathHelpers(tam);

    const actual = await tam.createSubSession(TASK_ID, 'proposed-id', minimalInit(), {
      agentId: 'agent-reviewer',
      agentName: REVIEWER_AGENT,
      nodeId: NODE_2,
    });

    expect(actual).toBe(REVIEWER_SESSION_ID);
    const coOwnerUpdate = updates.find((u) => u.id === 'exec-blocked');
    expect(coOwnerUpdate).toBeTruthy();
    // Pointer cleared, and the update does NOT restate a status — the row keeps
    // 'blocked' (only active former owners are transitioned to idle).
    expect(coOwnerUpdate!.payload.agentSessionId).toBeNull();
    expect(coOwnerUpdate!.payload.status).toBeUndefined();
    // A pending co-owner (pointer retained after resetWorkflowNodeExecutionForSpawnRetry)
    // must also keep its status — rewriting it to idle (terminal) would make the
    // runtime treat an agent that never reran as finished.
    const pendingUpdate = updates.find((u) => u.id === 'exec-pending');
    expect(pendingUpdate).toBeTruthy();
    expect(pendingUpdate!.payload.agentSessionId).toBeNull();
    expect(pendingUpdate!.payload.status).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // Stop synchronization: a space.stop landing after the dispatch hold passed
  // must abort BEFORE the merge kickoff is injected — into a live reused
  // session no less than a fresh one. The TransientSpawnError propagates to
  // dispatchPostApproval, which converts it into the durable post-approval
  // deferral (banner + resume re-drive).
  // -------------------------------------------------------------------------
  test('peer-injection gate: a stopped space rejects the inject without reaching the session', async () => {
    // A peer message must not drive a session of a stopped space (the stop
    // quiesce interrupted it; injecting would restart it via
    // ensureQueryStarted). The gate reads the SYNC stopped-space mirror
    // (populated by the onSpaceStopped callback — no DB read), then rejects
    // before injection.
    const hold = makeHoldAwareSpaceManager();
    const tam = makeManagerWithSpaceManager([], hold.manager);
    hold.stopped(SPACE_ID); // space.stop fired the onSpaceStopped callback
    const MERGER_SESSION = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:merger`;
    seedLiveSession(tam, MERGER_SESSION);
    const injected: string[] = [];
    (
      tam as unknown as { injectMessageIntoSession: (...a: unknown[]) => Promise<string> }
    ).injectMessageIntoSession = async () => {
      injected.push('x');
      return 'msg-id';
    };

    await expect(tam.injectSubSessionMessage(MERGER_SESSION, 'peer message')).rejects.toThrow(
      /stopped/
    );
    expect(injected).toEqual([]);
  });

  test('peer-injection gate: a paused space still injects (pause keeps live sessions reachable)', async () => {
    // Pause contract: running work continues — a live session on a paused
    // space must stay reachable. The gate is stopped-ONLY (pause never adds
    // to the stopped-space mirror).
    const hold = makeHoldAwareSpaceManager();
    const tam = makeManagerWithSpaceManager([], hold.manager);
    const MERGER_SESSION = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:merger`;
    seedLiveSession(tam, MERGER_SESSION);
    const injected: string[] = [];
    (
      tam as unknown as { injectMessageIntoSession: (...a: unknown[]) => Promise<string> }
    ).injectMessageIntoSession = async (_s: unknown, m: string) => {
      injected.push(m);
      return 'msg-id';
    };

    await tam.injectSubSessionMessage(MERGER_SESSION, 'peer message');
    expect(injected).toEqual(['peer message']);
  });

  test('peer-injection gate: a stop landing between the gate and the lock is re-checked inside the lock', async () => {
    // TOCTOU: the sync gate passes (space not in the stopped mirror), then
    // the space stops before the lock body (rehydrate branch would re-bind a
    // parked execution and restart the interrupted session). The in-lock
    // DB re-check must reject. Only ONE DB read now — the outer gate no
    // longer reads the row.
    const tam = makeManager([]);
    let calls = 0;
    (tam.config as unknown as Record<string, unknown>).spaceManager = {
      getSpace: async () => {
        calls += 1;
        // The in-lock re-check sees stopped.
        return { id: SPACE_ID, workspacePath: '/tmp/ws', stopped: true };
      },
    };
    const MERGER_SESSION = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:merger`;
    seedLiveSession(tam, MERGER_SESSION);
    const injected: string[] = [];
    (
      tam as unknown as { injectMessageIntoSession: (...a: unknown[]) => Promise<string> }
    ).injectMessageIntoSession = async () => {
      injected.push('x');
      return 'msg-id';
    };

    await expect(tam.injectSubSessionMessage(MERGER_SESSION, 'peer message')).rejects.toThrow(
      /stopped during the inject/
    );
    expect(injected).toEqual([]);
    expect(calls).toBe(1);
  });

  test('peer-injection gate: an active space injects normally', async () => {
    const tam = makeManager([]);
    (tam.config as unknown as Record<string, unknown>).spaceManager = {
      getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws', stopped: false }),
    };
    const MERGER_SESSION = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:merger`;
    seedLiveSession(tam, MERGER_SESSION);
    const injected: string[] = [];
    (
      tam as unknown as { injectMessageIntoSession: (...a: unknown[]) => Promise<string> }
    ).injectMessageIntoSession = async (_s: unknown, m: string) => {
      injected.push(m);
      return 'msg-id';
    };

    await tam.injectSubSessionMessage(MERGER_SESSION, 'peer message');
    expect(injected).toEqual(['peer message']);
  });

  test('isSessionUsableForPostApproval: interrupted/absent are dead, idle/processing are alive', async () => {
    // Direct body coverage of the interruption-aware probe — every guard test
    // stubs the probe, so the real body would otherwise be unpinned (a
    // regression to isAgentSessionAlive, which counts 'interrupted' as alive,
    // would pass the suite and re-open the already-routed wedge).
    const tam = makeManager([]); // no node-execution rows; no live sessions yet
    (
      tam.config as unknown as { sessionManager: { getCachedSession: () => unknown } }
    ).sessionManager = { getCachedSession: () => null };

    const live = makeFakeSession('session-live').session;
    (tam as unknown as { agentSessionIndex: Map<string, typeof live> }).agentSessionIndex.set(
      'session-live',
      live
    );
    const interrupted = makeFakeSession('session-interrupted').session;
    (
      interrupted as unknown as { getProcessingState: () => { status: string } }
    ).getProcessingState = () => ({ status: 'interrupted' });
    (
      tam as unknown as { agentSessionIndex: Map<string, typeof interrupted> }
    ).agentSessionIndex.set('session-interrupted', interrupted);

    // idle → alive; the probe must NOT count 'interrupted' as alive (that is
    // the exact false positive the already-routed guard wedge relied on).
    expect(tam.isSessionUsableForPostApproval('session-live')).toBe(true);
    expect(tam.isSessionUsableForPostApproval('session-interrupted')).toBe(false);
    // Absent from both the index and the SessionManager → dead.
    expect(tam.isSessionUsableForPostApproval('session-absent')).toBe(false);
  });

  test('stopped space: aborts before kickoff injection on the REUSE path', async () => {
    const spaceRow = { id: SPACE_ID, workspacePath: '/tmp/ws', stopped: true };
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: { getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID }) },
      nodeExecutionRepo: { listByWorkflowRun: () => [reviewerExec()], listByNode: () => [] },
      spaceManager: { getSpace: async () => spaceRow },
    } as unknown as TaskAgentManagerConfig);
    seedLiveSession(tam);
    const injected: string[] = [];
    (
      tam as unknown as {
        injectMessageIntoSession: (s: unknown, m: string) => Promise<string>;
      }
    ).injectMessageIntoSession = async (_s, m) => {
      injected.push(m);
      return 'msg-id';
    };
    const cancelled: string[] = [];
    (tam as unknown as { cancelBySessionId: (sid: string) => void }).cancelBySessionId = (sid) => {
      cancelled.push(sid);
    };
    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
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

    await expect(
      tam.spawnPostApprovalSubSession({
        task,
        workflow,
        targetAgent: REVIEWER_AGENT,
        kickoffMessage: 'merge the PR',
      })
    ).rejects.toThrow(/pre-kickoff \(post-approval reuse\)/);
    expect(injected).toEqual([]);
    // The reused session belongs to the node — an aborted merge kickoff must
    // not cancel it (teardown is create-path only).
    expect(cancelled).toEqual([]);
  });

  test('stopped space: aborts before kickoff injection on the CREATE path', async () => {
    const spaceRow = { id: SPACE_ID, workspacePath: '/tmp/ws', stopped: true };
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: { getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID }) },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [] },
      workflowRunRepo: { getRun: () => null },
      spaceManager: { getSpace: async () => spaceRow },
      spaceAgentManager: {
        getById: () => ({
          id: 'agent-reviewer',
          name: REVIEWER_AGENT,
          customPrompt: 'merge',
          model: 'm',
          tools: [],
        }),
      },
      spaceRuntimeService: {
        buildMemberSpaceToolsMcpServer: () => ({ __role: 'space-agent-tools' }),
        reattachMemberSpaceTools: async () => {},
      },
    } as unknown as TaskAgentManagerConfig);
    (
      tam as unknown as { buildNodeAgentMcpServerForSession: () => unknown }
    ).buildNodeAgentMcpServerForSession = () => ({ __role: 'node-agent' });
    (
      tam as unknown as { ensureNodeAgentAttached: (...a: unknown[]) => Promise<void> }
    ).ensureNodeAgentAttached = async () => {};
    const injected: string[] = [];
    (
      tam as unknown as {
        injectMessageIntoSession: (s: unknown, m: string) => Promise<string>;
      }
    ).injectMessageIntoSession = async (_s, m) => {
      injected.push(m);
      return 'msg-id';
    };
    const cancelled: string[] = [];
    (tam as unknown as { cancelBySessionId: (sid: string) => void }).cancelBySessionId = (sid) => {
      cancelled.push(sid);
    };
    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
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

    await expect(
      tam.spawnPostApprovalSubSession({
        task,
        workflow,
        targetAgent: REVIEWER_AGENT,
        kickoffMessage: 'merge the PR',
      })
    ).rejects.toThrow(/pre-kickoff \(post-approval\)/);
    expect(injected).toEqual([]);
    // The registered-but-never-kicked-off session is torn back down — without
    // the rollback it would leak in the SessionManager cache until restart
    // and the resume re-spawn would never reclaim it.
    expect(cancelled).toEqual([
      `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${REVIEWER_AGENT}`,
    ]);
  });

  test('unreadable space state on the post-approval path fails CLOSED (durable deferral)', async () => {
    // A transient getSpace error at the LAST gate before merge instructions
    // are injected must abort into the already-built deferral, not proceed.
    // Call-counting mock: the spawner's own lookup succeeds, the helper's
    // re-check throws.
    let getSpaceCalls = 0;
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: { getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID }) },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [] },
      workflowRunRepo: { getRun: () => null },
      spaceManager: {
        getSpace: async () => {
          if (++getSpaceCalls === 1) return { id: SPACE_ID, workspacePath: '/tmp/ws' };
          throw new Error('db hiccup');
        },
      },
      spaceAgentManager: {
        getById: () => ({
          id: 'agent-reviewer',
          name: REVIEWER_AGENT,
          customPrompt: 'merge',
          model: 'm',
          tools: [],
        }),
      },
      spaceRuntimeService: {
        buildMemberSpaceToolsMcpServer: () => ({ __role: 'space-agent-tools' }),
        reattachMemberSpaceTools: async () => {},
      },
    } as unknown as TaskAgentManagerConfig);
    (
      tam as unknown as { buildNodeAgentMcpServerForSession: () => unknown }
    ).buildNodeAgentMcpServerForSession = () => ({ __role: 'node-agent' });
    (
      tam as unknown as { ensureNodeAgentAttached: (...a: unknown[]) => Promise<void> }
    ).ensureNodeAgentAttached = async () => {};
    const injected: string[] = [];
    (
      tam as unknown as {
        injectMessageIntoSession: (s: unknown, m: string) => Promise<string>;
      }
    ).injectMessageIntoSession = async (_s, m) => {
      injected.push(m);
      return 'msg-id';
    };
    const cancelled: string[] = [];
    (tam as unknown as { cancelBySessionId: (sid: string) => void }).cancelBySessionId = (sid) => {
      cancelled.push(sid);
    };
    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
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

    await expect(
      tam.spawnPostApprovalSubSession({
        task,
        workflow,
        targetAgent: REVIEWER_AGENT,
        kickoffMessage: 'merge the PR',
      })
    ).rejects.toThrow(/state unreadable .*pre-kickoff \(post-approval\)/);
    expect(injected).toEqual([]);
    // Failing closed still rolls the registered session back.
    expect(cancelled).toEqual([
      `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${REVIEWER_AGENT}`,
    ]);
    expect(getSpaceCalls).toBe(2);
  });

  test('createSubSession throwing post-registration rolls the fresh session back', async () => {
    // Registration happens INSIDE createSubSession (before its
    // startStreamingQuery await), so the teardown try must wrap the call
    // itself — a throw there would otherwise leak the registered session
    // exactly as the pre-fix code did. The proposed (deterministic) id is
    // cancelled; cancelBySessionId no-ops safely when nothing registered.
    const spaceRow = { id: SPACE_ID, workspacePath: '/tmp/ws' };
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: { getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID }) },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [] },
      workflowRunRepo: { getRun: () => null },
      spaceManager: { getSpace: async () => spaceRow },
      spaceAgentManager: {
        getById: () => ({
          id: 'agent-reviewer',
          name: REVIEWER_AGENT,
          customPrompt: 'merge',
          model: 'm',
          tools: [],
        }),
      },
      spaceRuntimeService: {
        buildMemberSpaceToolsMcpServer: () => ({ __role: 'space-agent-tools' }),
        reattachMemberSpaceTools: async () => {},
      },
    } as unknown as TaskAgentManagerConfig);
    const proposedId = `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${REVIEWER_AGENT}`;
    (
      tam as unknown as {
        createSubSession: (taskId: string, sessionId: string) => Promise<string>;
      }
    ).createSubSession = async () => {
      throw new Error('attach blew up');
    };
    const cancelled: string[] = [];
    (tam as unknown as { cancelBySessionId: (sid: string) => void }).cancelBySessionId = (sid) => {
      cancelled.push(sid);
    };
    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
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

    await expect(
      tam.spawnPostApprovalSubSession({
        task,
        workflow,
        targetAgent: REVIEWER_AGENT,
        kickoffMessage: 'merge the PR',
      })
    ).rejects.toThrow(/attach blew up/);
    expect(cancelled).toEqual([proposedId]);
  });

  test('internal reuse branch: an abort never tears down the PRE-EXISTING session', async () => {
    // When the merge target has no in-memory session but a DB row (e.g.
    // after a daemon restart), createSubSession's internal reuse path
    // rehydrates and returns the PRE-EXISTING session under a different id.
    // A later failClosed abort must skip the teardown — that session belongs
    // to the run, not this spawn (the outer reuse path's pinned invariant).
    const spaceRow = { id: SPACE_ID, workspacePath: '/tmp/ws', stopped: true };
    const tam = new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskRepo: { getTask: () => ({ id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID }) },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [] },
      workflowRunRepo: { getRun: () => null },
      spaceManager: { getSpace: async () => spaceRow },
      spaceAgentManager: {
        getById: () => ({
          id: 'agent-reviewer',
          name: REVIEWER_AGENT,
          customPrompt: 'merge',
          model: 'm',
          tools: [],
        }),
      },
      spaceRuntimeService: {
        buildMemberSpaceToolsMcpServer: () => ({ __role: 'space-agent-tools' }),
        reattachMemberSpaceTools: async () => {},
      },
    } as unknown as TaskAgentManagerConfig);
    const preexisting = `space:${SPACE_ID}:task:${TASK_ID}:node:old`;
    (
      tam as unknown as {
        createSubSession: (taskId: string, sessionId: string) => Promise<string>;
      }
    ).createSubSession = async () => preexisting; // internal reuse
    (tam as unknown as { getSubSession: (sid: string) => unknown }).getSubSession = () => ({
      id: preexisting,
    });
    (
      tam as unknown as { ensureNodeAgentAttached: (...a: unknown[]) => Promise<void> }
    ).ensureNodeAgentAttached = async () => {};
    const injected: string[] = [];
    (
      tam as unknown as {
        injectMessageIntoSession: (s: unknown, m: string) => Promise<string>;
      }
    ).injectMessageIntoSession = async (_s, m) => {
      injected.push(m);
      return 'msg-id';
    };
    const cancelled: string[] = [];
    (tam as unknown as { cancelBySessionId: (sid: string) => void }).cancelBySessionId = (sid) => {
      cancelled.push(sid);
    };
    const workflow = {
      id: 'wf-1',
      spaceId: SPACE_ID,
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

    await expect(
      tam.spawnPostApprovalSubSession({
        task,
        workflow,
        targetAgent: REVIEWER_AGENT,
        kickoffMessage: 'merge the PR',
      })
    ).rejects.toThrow(/pre-kickoff \(post-approval\)/);
    expect(injected).toEqual([]);
    // The pre-existing session survives the abort.
    expect(cancelled).toEqual([]);
  });
});
