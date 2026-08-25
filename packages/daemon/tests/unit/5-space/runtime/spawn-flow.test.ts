import { describe, expect, test } from 'bun:test';
import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import type { SpawnExecutionFlowDeps } from '../../../../src/lib/space/runtime/spawn-flow';
import {
  isSpawnFlowReusedSession,
  isSpawnFlowWaitConcurrent,
  runSpawnExecutionFlow,
} from '../../../../src/lib/space/runtime/spawn-flow';
import { resolveWorkflowNodeSlot } from '../../../../src/lib/space/runtime/spawn-slot-resolution';

const TASK_ID = 'task-1240';
const RUN_ID = 'run-1240';
const SPACE_ID = 'space-1240';
const NODE_ID = 'node-coder';
const AGENT_NAME = 'coder';
const AGENT_ID = 'agent-coder';
const EXECUTION_ID = 'exec-1240';
const SPAWNED_SESSION_ID = 'spawned-session-1';

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: EXECUTION_ID,
    workflowRunId: RUN_ID,
    workflowNodeId: NODE_ID,
    agentName: AGENT_NAME,
    agentId: AGENT_ID,
    agentSessionId: null,
    status: 'pending',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeTask(status: string): SpaceTask {
  return {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    title: 'Compose the spawn flow',
    description: 'Staged spawn composition over the admission union',
    taskNumber: 1240,
    status,
  } as unknown as SpaceTask;
}

function makeWorkflow(): SpaceWorkflow {
  return {
    id: 'wf-1240',
    spaceId: SPACE_ID,
    name: 'Coding',
    nodes: [{ id: NODE_ID, agents: [{ agentId: AGENT_ID, name: AGENT_NAME }] }],
    channels: [],
    startNodeId: NODE_ID,
    endNodeId: NODE_ID,
  } as unknown as SpaceWorkflow;
}

interface FlowFixture {
  deps: SpawnExecutionFlowDeps;
  calls: string[];
  cancels: string[];
  releases: string[];
  reservations: string[];
  taskReservations: string[];
  taskReservationReleases: string[];
  rebinds: Array<{ executionId: string; sessionId: string }>;
  binds: Array<{ executionId: string; sessionId: string }>;
  attaches: NodeExecution[];
  kickoffMessages: string[];
  injected: Array<{ sessionId: string; message: string }>;
  liveIndexedSessionId: string | null;
  spawningExecutionIds: Set<string>;
  workspaceGate: Promise<string> | null;
  input: {
    task: SpaceTask;
    space: Space;
    workflow: SpaceWorkflow;
    workflowRun: SpaceWorkflowRun;
    execution: NodeExecution;
    kickoff: boolean;
  };
  run: (
    overrides?: Partial<SpawnExecutionFlowDeps>
  ) => Promise<ReturnType<typeof runSpawnExecutionFlow>>;
}

function makeFlowFixture(options: { taskStatus?: string; kickoff?: boolean } = {}): FlowFixture {
  const calls: string[] = [];
  const cancels: string[] = [];
  const releases: string[] = [];
  const reservations: string[] = [];
  const taskReservations: string[] = [];
  const taskReservationReleases: string[] = [];
  const rebinds: Array<{ executionId: string; sessionId: string }> = [];
  const binds: Array<{ executionId: string; sessionId: string }> = [];
  const attaches: NodeExecution[] = [];
  const kickoffMessages: string[] = [];
  const injected: Array<{ sessionId: string; message: string }> = [];
  const spawningExecutionIds = new Set<string>();
  const task = makeTask(options.taskStatus ?? 'in_progress');
  const execution = makeExecution();
  const boundExecution = {
    ...execution,
    status: 'in_progress' as const,
    agentSessionId: SPAWNED_SESSION_ID,
  };
  const liveIndexedSessionId: string | null = null;
  const workspaceGate: Promise<string> | null = null;
  const heldTaskReservations = new Set<string>();

  const deps: SpawnExecutionFlowDeps = {
    getFreshTask: () => task,
    getNodeExecution: () => boundExecution,
    isSpawningExecution: (executionId) => spawningExecutionIds.has(executionId),
    inspectIndexedSession: (agentSessionId) => ({ sessionId: agentSessionId, alive: false }),
    resolveSlot: (_space, workflow, execution, _task) =>
      resolveWorkflowNodeSlot(workflow, execution.workflowNodeId, execution.agentName),
    reserveExecution: (executionId) => {
      calls.push('reserve');
      reservations.push(executionId);
      spawningExecutionIds.add(executionId);
    },
    releaseExecution: (executionId) => {
      calls.push('release');
      releases.push(executionId);
      spawningExecutionIds.delete(executionId);
    },
    reserveTaskSpawn: (taskId) => {
      calls.push(`reserve-task:${taskId}`);
      taskReservations.push(taskId);
      if (heldTaskReservations.has(taskId)) return 'superseded';
      heldTaskReservations.add(taskId);
      return 'won';
    },
    releaseTaskSpawn: (taskId) => {
      calls.push(`release-task:${taskId}`);
      if (!heldTaskReservations.has(taskId)) return;
      heldTaskReservations.delete(taskId);
      taskReservationReleases.push(taskId);
    },
    cancelSpawnedSession: (sessionId) => {
      calls.push(`cancel:${sessionId}`);
      cancels.push(sessionId);
    },
    rebindLiveExecution: (row, sessionId) => {
      calls.push(`rebind:${sessionId}`);
      rebinds.push({ executionId: row.id, sessionId });
      return 'won';
    },
    raiseSpawnRejection: () => {
      calls.push('reject');
      throw new Error('admission rejected');
    },
    resolveSpawnSessionId: () => {
      calls.push('resolve-session-id');
      return 'base-session-1';
    },
    resolveWorkspacePath: async () => {
      calls.push('resolve-workspace');
      return workspaceGate === null ? '/tmp/ws' : await workspaceGate;
    },
    createSpawnedSession: async () => {
      calls.push('create');
      return SPAWNED_SESSION_ID;
    },
    bindExecutionToSession: (row, sessionId) => {
      calls.push(`bind:${sessionId}`);
      binds.push({ executionId: row.id, sessionId });
      return 'won';
    },
    flushPendingMessagesForTarget: (workflowRunId, agentName) => {
      calls.push(`flush-pending:${workflowRunId}:${agentName}`);
    },
    attachNodeAgent: async (request) => {
      calls.push('attach');
      attaches.push(request.execution);
    },
    registerSpawnCompletionCallback: (taskId, workflowNodeId, sessionId) => {
      calls.push(`register:${taskId}:${workflowNodeId}:${sessionId}`);
    },
    buildKickoffMessage: async () => {
      calls.push('kickoff-message');
      kickoffMessages.push('kickoff-msg');
      return 'kickoff-msg';
    },
    injectKickoffMessage: async (sessionId, message) => {
      calls.push(`inject:${sessionId}`);
      injected.push({ sessionId, message });
    },
    activateSpawnedSessionPoolAssignment: (executionId, sessionId) => {
      calls.push(`activate-pool:${executionId}:${sessionId}`);
    },
  };

  return {
    deps,
    calls,
    cancels,
    releases,
    reservations,
    taskReservations,
    taskReservationReleases,
    rebinds,
    binds,
    attaches,
    kickoffMessages,
    injected,
    liveIndexedSessionId,
    spawningExecutionIds,
    workspaceGate,
    input: {
      task,
      space: { id: SPACE_ID, workspacePath: '/tmp/ws' } as unknown as Space,
      workflow: makeWorkflow(),
      workflowRun: {
        id: RUN_ID,
        workflowId: 'wf-1240',
        status: 'in_progress',
      } as unknown as SpaceWorkflowRun,
      execution,
      kickoff: options.kickoff ?? true,
    },
    run: (overrides) =>
      runSpawnExecutionFlow(
        { ...deps, ...overrides },
        {
          task,
          space: { id: SPACE_ID, workspacePath: '/tmp/ws' } as unknown as Space,
          workflow: makeWorkflow(),
          workflowRun: {
            id: RUN_ID,
            workflowId: 'wf-1240',
            status: 'in_progress',
          } as unknown as SpaceWorkflowRun,
          execution,
          kickoff: options.kickoff ?? true,
        }
      ),
  };
}

describe('spawn flow — proceed_fresh path', () => {
  test('runs admission, task reservation, reserve, spawn, bind, early reservation release, attach, register, kickoff, pool activation, and halts with the session id', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run();
    expect(outcome).toEqual({ status: 'completed', result: SPAWNED_SESSION_ID });
    expect(h.calls).toEqual([
      `reserve-task:${TASK_ID}`,
      'reserve',
      'resolve-session-id',
      'resolve-workspace',
      'create',
      `bind:${SPAWNED_SESSION_ID}`,
      `release-task:${TASK_ID}`,
      'attach',
      `register:${TASK_ID}:${NODE_ID}:${SPAWNED_SESSION_ID}`,
      'kickoff-message',
      `inject:${SPAWNED_SESSION_ID}`,
      `activate-pool:${EXECUTION_ID}:${SPAWNED_SESSION_ID}`,
      `flush-pending:${RUN_ID}:${AGENT_NAME}`,
    ]);
    expect(h.cancels).toEqual([]);
    expect(h.releases).toEqual([]);
    expect(h.reservations).toEqual([EXECUTION_ID]);
    expect(h.taskReservations).toEqual([TASK_ID]);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
  });

  test('a kickoff-disabled spawn skips the kickoff message and inject but still binds and attaches', async () => {
    const h = makeFlowFixture({ kickoff: false });
    const outcome = await h.run();
    expect(outcome).toEqual({ status: 'completed', result: SPAWNED_SESSION_ID });
    expect(h.calls).toEqual([
      `reserve-task:${TASK_ID}`,
      'reserve',
      'resolve-session-id',
      'resolve-workspace',
      'create',
      `bind:${SPAWNED_SESSION_ID}`,
      `release-task:${TASK_ID}`,
      'attach',
      `register:${TASK_ID}:${NODE_ID}:${SPAWNED_SESSION_ID}`,
      `activate-pool:${EXECUTION_ID}:${SPAWNED_SESSION_ID}`,
      `flush-pending:${RUN_ID}:${AGENT_NAME}`,
    ]);
  });

  test('the attach stage consumes the re-read bound execution row, not the admission-time snapshot', async () => {
    const h = makeFlowFixture();
    await h.run();
    expect(h.attaches).toHaveLength(1);
    expect(h.attaches[0]).toBe(h.deps.getNodeExecution(EXECUTION_ID) as NodeExecution);
    expect(h.attaches[0].status).toBe('in_progress');
    expect(h.attaches[0].agentSessionId).toBe(SPAWNED_SESSION_ID);
  });

  test('a missing fresh task falls back to the caller task snapshot', async () => {
    const h = makeFlowFixture({ taskStatus: 'in_progress' });
    const outcome = await h.run({ getFreshTask: () => null });
    expect(outcome).toEqual({ status: 'completed', result: SPAWNED_SESSION_ID });
    expect(h.calls).toContain('create');
  });
});

describe('spawn flow — alternative admission branches', () => {
  test('reuse_live rebinds the indexed session and halts with a reused-session result', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      inspectIndexedSession: (agentSessionId) => ({
        sessionId: agentSessionId ?? 'live-1',
        alive: true,
      }),
    });
    expect(outcome).toEqual({
      status: 'completed',
      result: { kind: 'reused_session', sessionId: 'live-1' },
    });
    expect(isSpawnFlowReusedSession(outcome.result)).toBe(true);
    expect(h.rebinds).toEqual([{ executionId: EXECUTION_ID, sessionId: 'live-1' }]);
    expect(h.calls).toEqual(['rebind:live-1']);
    expect(h.reservations).toEqual([]);
  });

  test('wait_concurrent halts with the wait marker and runs no effect stage', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      isSpawningExecution: () => true,
    });
    expect(outcome).toEqual({ status: 'completed', result: { kind: 'wait_concurrent' } });
    expect(isSpawnFlowWaitConcurrent(outcome.result)).toBe(true);
    expect(h.calls).toEqual([]);
  });

  test('reject branches route through the rejection halt and surface its error', async () => {
    const h = makeFlowFixture({ taskStatus: 'archived' });
    const outcome = await h.run();
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.stage).toBe('raise-spawn-rejection');
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe('admission rejected');
      expect(outcome.unwind).toEqual([]);
    }
    expect(h.calls).toEqual(['reject']);
    expect(h.cancels).toEqual([]);
  });
});

describe('spawn flow — failure unwind (the catch-path cancel compensation)', () => {
  test('a bind failure after session creation cancels the spawned session and releases both reservations', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      bindExecutionToSession: () => {
        throw new Error('bind boom');
      },
    });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.stage).toBe('bind-execution-session');
      expect((outcome.error as Error).message).toBe('bind boom');
      expect(outcome.unwind).toEqual([
        { stage: 'reserve-and-spawn-session', status: 'compensated' },
        { stage: 'reserve-task-spawn', status: 'compensated' },
      ]);
    }
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.releases).toEqual([EXECUTION_ID]);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
    expect(h.calls.indexOf(`cancel:${SPAWNED_SESSION_ID}`)).toBeLessThan(
      h.calls.indexOf('release')
    );
  });

  test('a create failure before the session exists releases both reservations without cancelling', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      createSpawnedSession: async () => {
        throw new Error('create boom');
      },
    });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.stage).toBe('reserve-and-spawn-session');
      expect((outcome.error as Error).message).toBe('create boom');
    }
    expect(h.cancels).toEqual([]);
    expect(h.releases).toEqual([EXECUTION_ID]);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
  });

  test('an attach failure cancels the spawned session and releases both reservations', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      attachNodeAgent: async () => {
        throw new Error('attach boom');
      },
    });
    expect(outcome.status).toBe('error');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.releases).toEqual([EXECUTION_ID]);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
    expect(h.binds).toHaveLength(1);
  });

  test('a kickoff inject failure cancels the spawned session and releases both reservations', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      injectKickoffMessage: async () => {
        throw new Error('inject boom');
      },
    });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.stage).toBe('kickoff-session');
    }
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.releases).toEqual([EXECUTION_ID]);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
  });

  test('the compensation runs even when the spawn reservation was the only committed write', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      resolveWorkspacePath: async () => {
        throw new Error('worktree boom');
      },
    });
    expect(outcome.status).toBe('error');
    expect(h.cancels).toEqual([]);
    expect(h.releases).toEqual([EXECUTION_ID]);
    expect(h.spawningExecutionIds.has(EXECUTION_ID)).toBe(false);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
  });
});

describe('spawn flow — superseded CAS outcomes (ADR 0004 Phase 0 condition 3)', () => {
  test('a lost task-spawn reservation supersedes before any spawn work and releases nothing', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      reserveTaskSpawn: (taskId) => {
        h.deps.reserveTaskSpawn(taskId);
        return 'superseded' as const;
      },
    });
    expect(outcome).toEqual({
      status: 'superseded',
      stage: 'reserve-task-spawn',
      unwind: [{ stage: 'reserve-task-spawn', status: 'compensated' }],
    });
    expect(h.calls).toEqual([`reserve-task:${TASK_ID}`]);
    expect(h.cancels).toEqual([]);
    expect(h.reservations).toEqual([]);
    expect(h.taskReservationReleases).toEqual([]);
    expect(h.spawningExecutionIds.has(EXECUTION_ID)).toBe(false);
  });

  test('a lost bind CAS supersedes after the spawn, cancelling the spawned session and releasing both reservations', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      bindExecutionToSession: () => 'superseded',
    });
    expect(outcome.status).toBe('superseded');
    if (outcome.status === 'superseded') {
      expect(outcome.stage).toBe('bind-execution-session');
      expect(outcome.unwind).toEqual([
        { stage: 'reserve-and-spawn-session', status: 'compensated' },
        { stage: 'reserve-task-spawn', status: 'compensated' },
      ]);
    }
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    expect(h.releases).toEqual([EXECUTION_ID]);
    expect(h.taskReservationReleases).toEqual([TASK_ID]);
    expect(h.attaches).toEqual([]);
    expect(h.injected).toEqual([]);
    expect(h.taskReservationReleases).not.toContain(undefined);
  });

  test('a lost rebind CAS supersedes the reuse_live branch with nothing to compensate', async () => {
    const h = makeFlowFixture();
    const outcome = await h.run({
      inspectIndexedSession: (agentSessionId) => ({
        sessionId: agentSessionId ?? 'live-1',
        alive: true,
      }),
      rebindLiveExecution: (row, sessionId) => {
        h.deps.rebindLiveExecution(row, sessionId);
        return 'superseded' as const;
      },
    });
    expect(outcome).toEqual({
      status: 'superseded',
      stage: 'rebind-live-session',
      unwind: [],
    });
    expect(h.calls).toEqual(['rebind:live-1']);
    expect(h.cancels).toEqual([]);
    expect(h.reservations).toEqual([]);
  });
});

describe('spawn flow microtask profile', () => {
  test('the reuse-live branch executes its effect and halt inside the invoke call', async () => {
    const h = makeFlowFixture();
    const promise = h.run({
      inspectIndexedSession: (agentSessionId) => ({
        sessionId: agentSessionId ?? 'live-1',
        alive: true,
      }),
    });
    expect(h.calls).toEqual(['rebind:live-1']);
    await expect(promise).resolves.toEqual({
      status: 'completed',
      result: { kind: 'reused_session', sessionId: 'live-1' },
    });
  });

  test('admission and the reservation commit before the first awaited effect boundary', async () => {
    const h = makeFlowFixture();
    let releaseWorkspace: ((path: string) => void) | null = null;
    const gate = new Promise<string>((resolve) => {
      releaseWorkspace = resolve;
    });
    const promise = h.run({
      resolveWorkspacePath: async () => {
        h.calls.push('resolve-workspace');
        await gate;
        return '/tmp/ws';
      },
    });
    expect(h.calls).toEqual([
      `reserve-task:${TASK_ID}`,
      'reserve',
      'resolve-session-id',
      'resolve-workspace',
    ]);
    expect(h.spawningExecutionIds.has(EXECUTION_ID)).toBe(true);
    expect(h.calls).not.toContain('create');
    releaseWorkspace!('/tmp/ws');
    await expect(promise).resolves.toEqual({ status: 'completed', result: SPAWNED_SESSION_ID });
  });

  test('an inter-stage continuation defers past a queued microtask observer', async () => {
    const h = makeFlowFixture();
    const order: string[] = [];
    const promise = runSpawnExecutionFlow(
      {
        ...h.deps,
        resolveWorkspacePath: async () => {
          order.push('workspace');
          return '/tmp/ws';
        },
        bindExecutionToSession: () => {
          order.push('bind');
          return 'won' as const;
        },
      },
      h.input
    );
    queueMicrotask(() => order.push('observer'));
    await promise;
    expect(order).toEqual(['workspace', 'observer', 'bind']);
  });
});
