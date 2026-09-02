import { describe, expect, test } from 'bun:test';
import { POST_APPROVAL_COMPLETION_INSTRUCTIONS } from '@hyperneo/prompts';
import type { Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { SessionManager } from '../../../../src/lib/session-manager';
import { createDefaultSessionResolutionDeps } from '../../../../src/lib/session-resolution/default-deps';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import type { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';

interface FakeSession {
  getSessionData: () => { id: string; status: string; config?: Record<string, unknown> };
}

function fakeSession(id: string, status: string, config?: Record<string, unknown>): FakeSession {
  return { getSessionData: () => ({ id, status, config }) };
}

interface ExecutionRow {
  agentName: string;
  agentSessionId: string | null;
  status: string;
  workflowNodeId: string;
}

interface SpawnCall {
  task: SpaceTask;
  workflow: SpaceWorkflow;
  targetAgent: string;
  kickoffMessage: string;
  nodeId?: string;
}

interface HarnessConfig {
  indexedSubSession?: FakeSession;
  cachedSession?: FakeSession | null;
  asyncSession?: FakeSession | null;
  rehydratedSession?: FakeSession | null;
  coordinatorRow?: { id: string } | null;
  ensuredSession?: FakeSession | null;
  task?: Partial<SpaceTask> | null;
  executions?: ExecutionRow[];
  postApprovalWorkerSession?: {
    sessionId: string;
    agentName: string;
    nodeId?: string | null;
  } | null;
  activationResult?: boolean;
  spawnResult?: { sessionId: string } | Error;
  run?: { id: string; workflowId: string; spaceId: string } | null;
  workflow?: Partial<SpaceWorkflow> | null;
  prUrl?: string | null;
  space?: Partial<Space> | null;
  taskReads?: Array<Partial<SpaceTask> | null | undefined>;
  publishTaskUpdated?: boolean;
}

interface Harness {
  deps: SessionResolutionDeps;
  getSessionAsyncCalls: string[];
  rehydrateCalls: string[];
  ensureAgentSessionCalls: Array<[string, string]>;
  listByWorkflowRunCalls: string[];
  workerSessionCalls: string[];
  activationCalls: Array<[string, string, { workflowNodeId?: string }]>;
  spawnCalls: SpawnCall[];
  updateTaskCalls: Array<[string, Record<string, unknown>]>;
  getTaskCalls: string[];
  getRunCalls: string[];
  prUrlCalls: string[];
  getSpaceCalls: string[];
  publishedTaskUpdates: Array<{ taskId: string; spaceId: string }>;
}

function makeHarness(config: HarnessConfig = {}): Harness {
  const harness: Harness = {
    deps: null as unknown as SessionResolutionDeps,
    getSessionAsyncCalls: [],
    rehydrateCalls: [],
    ensureAgentSessionCalls: [],
    listByWorkflowRunCalls: [],
    workerSessionCalls: [],
    activationCalls: [],
    spawnCalls: [],
    updateTaskCalls: [],
    getTaskCalls: [],
    getRunCalls: [],
    prUrlCalls: [],
    getSpaceCalls: [],
    publishedTaskUpdates: [],
  };
  const task = (
    config.task === undefined || config.task === null ? null : config.task
  ) as SpaceTask | null;
  const run = (config.run === undefined ? null : config.run) as {
    id: string;
    workflowId: string;
    spaceId: string;
  } | null;
  const workflow = (config.workflow === undefined ? null : config.workflow) as SpaceWorkflow | null;

  const sessionManager = {
    getCachedSession: () => config.cachedSession ?? null,
    getSessionAsync: (sessionId: string) => {
      harness.getSessionAsyncCalls.push(sessionId);
      return Promise.resolve(config.asyncSession ?? null);
    },
  } as unknown as SessionManager;

  const taskAgentManager = {
    getSubSession: () => config.indexedSubSession,
    rehydrateSubSessionById: (sessionId: string) => {
      harness.rehydrateCalls.push(sessionId);
      return Promise.resolve(config.rehydratedSession ?? null);
    },
    ensureWorkflowNodeActivationForAgent: (
      taskId: string,
      agentName: string,
      options: { workflowNodeId?: string }
    ) => {
      harness.activationCalls.push([taskId, agentName, options]);
      return Promise.resolve(config.activationResult ?? false);
    },
    spawnPostApprovalSubSession: (args: SpawnCall) => {
      harness.spawnCalls.push(args);
      if (config.spawnResult instanceof Error) return Promise.reject(config.spawnResult);
      return Promise.resolve(config.spawnResult ?? { sessionId: 'spawned-1' });
    },
    getPostApprovalWorkerSession: (taskId: string) => {
      harness.workerSessionCalls.push(taskId);
      return config.postApprovalWorkerSession ?? null;
    },
  } as unknown as TaskAgentManager;

  const spaceRuntimeService = {
    ensureAgentSession: (spaceId: string, agentId: string) => {
      harness.ensureAgentSessionCalls.push([spaceId, agentId]);
      return Promise.resolve(config.ensuredSession ?? null);
    },
  } as unknown as SpaceRuntimeService;

  const nodeExecutionRepo = {
    listByWorkflowRun: (workflowRunId: string) => {
      harness.listByWorkflowRunCalls.push(workflowRunId);
      return config.executions ?? [];
    },
  } as unknown as NodeExecutionRepository;

  const taskRepo = {
    getTask: (taskId: string) => {
      harness.getTaskCalls.push(taskId);
      const override = config.taskReads?.[harness.getTaskCalls.length - 1];
      if (override !== undefined) {
        return override === null ? null : (override as SpaceTask);
      }
      return task;
    },
    updateTask: (taskId: string, params: Record<string, unknown>) => {
      harness.updateTaskCalls.push([taskId, params]);
      return task;
    },
  } as unknown as SpaceTaskRepository;

  const longHorizonAgentRepo = {
    getCoordinator: () => config.coordinatorRow ?? null,
  } as unknown as SpaceLongHorizonAgentRepository;

  const workflowRunRepo = {
    getRun: (runId: string) => {
      harness.getRunCalls.push(runId);
      return run;
    },
  } as unknown as SpaceWorkflowRunRepository;

  const spaceWorkflowManager = {
    getWorkflowForRun: (candidate: unknown) => {
      expect(candidate).toBe(run);
      return workflow;
    },
  } as unknown as SpaceWorkflowManager;

  harness.deps = createDefaultSessionResolutionDeps({
    sessionManager,
    taskAgentManager,
    spaceRuntimeService,
    nodeExecutionRepo,
    taskRepo,
    longHorizonAgentRepo,
    workflowRunRepo,
    spaceWorkflowManager,
    ...(config.prUrl !== undefined
      ? {
          artifactProfile: {
            resolveInitialPrimaryLinkUrl: (runId: string) => {
              harness.prUrlCalls.push(runId);
              return config.prUrl ?? '';
            },
          },
        }
      : {}),
    ...(config.space !== undefined
      ? {
          spaceManager: {
            getSpace: (spaceId: string) => {
              harness.getSpaceCalls.push(spaceId);
              return Promise.resolve(config.space === null ? null : (config.space as Space));
            },
          } as SpaceManager,
        }
      : {}),
    ...(config.publishTaskUpdated
      ? {
          internalEventBus: {
            publish: (topic: string, payload: { taskId: string; spaceId: string }) => {
              expect(topic).toBe('space.task.updated');
              harness.publishedTaskUpdates.push(payload);
              return Promise.resolve({ delivered: 0, failures: [] });
            },
          } as unknown as InternalEventBus<DaemonInternalEventMap>,
        }
      : {}),
  });
  return harness;
}

describe('getSession', () => {
  test('indexed sub-session backed by the cache resolves without the async lookup', async () => {
    const indexed = fakeSession('sub-1', 'active');
    const { deps, getSessionAsyncCalls } = makeHarness({
      indexedSubSession: indexed,
      cachedSession: indexed,
      asyncSession: fakeSession('sub-1', 'active'),
    });

    await expect(deps.getSession('sub-1')).resolves.toBe(indexed);
    expect(getSessionAsyncCalls).toHaveLength(0);
  });

  test('ended indexed sub-session resolves null', async () => {
    const ended = fakeSession('sub-1', 'ended');
    const { deps } = makeHarness({ indexedSubSession: ended, cachedSession: ended });

    await expect(deps.getSession('sub-1')).resolves.toBeNull();
  });

  test('archived indexed sub-session resolves null', async () => {
    const archived = fakeSession('sub-1', 'archived');
    const { deps } = makeHarness({ indexedSubSession: archived, cachedSession: archived });

    await expect(deps.getSession('sub-1')).resolves.toBeNull();
  });

  test('indexed workflow sub-session without a runtime node-agent server resolves null', async () => {
    const indexed = fakeSession('space:s1:task:t1:exec:e1', 'active', {});
    const { deps } = makeHarness({ indexedSubSession: indexed, cachedSession: indexed });

    await expect(deps.getSession('space:s1:task:t1:exec:e1')).resolves.toBeNull();
  });

  test('indexed workflow sub-session with a runtime node-agent server resolves', async () => {
    const indexed = fakeSession('space:s1:task:t1:exec:e1', 'active', {
      mcpServers: { 'node-agent': { type: 'sdk' } },
    });
    const { deps } = makeHarness({ indexedSubSession: indexed, cachedSession: indexed });

    await expect(deps.getSession('space:s1:task:t1:exec:e1')).resolves.toBe(indexed);
  });

  test('non-indexed session falls through to the async lookup exactly once', async () => {
    const asyncSession = fakeSession('sess-1', 'active');
    const { deps, getSessionAsyncCalls } = makeHarness({ asyncSession });

    await expect(deps.getSession('sess-1')).resolves.toBe(asyncSession);
    expect(getSessionAsyncCalls).toEqual(['sess-1']);
  });

  test('ended async session resolves null', async () => {
    const { deps } = makeHarness({ asyncSession: fakeSession('sess-1', 'ended') });

    await expect(deps.getSession('sess-1')).resolves.toBeNull();
  });

  test('archived async session resolves null', async () => {
    const { deps } = makeHarness({ asyncSession: fakeSession('sess-1', 'archived') });

    await expect(deps.getSession('sess-1')).resolves.toBeNull();
  });

  test('non-indexed workflow sub-session without a runtime node-agent server resolves null', async () => {
    const { deps } = makeHarness({
      asyncSession: fakeSession('space:s1:task:t1:post-approval:coder', 'active', {}),
    });

    await expect(deps.getSession('space:s1:task:t1:post-approval:coder')).resolves.toBeNull();
  });
});

describe('rehydrateSubSession', () => {
  test('delegates to rehydrateSubSessionById once with the exact id', async () => {
    const restored = fakeSession('sub-1', 'active');
    const { deps, rehydrateCalls } = makeHarness({ rehydratedSession: restored });

    await expect(deps.rehydrateSubSession('sub-1')).resolves.toBe(restored);
    expect(rehydrateCalls).toEqual(['sub-1']);
  });

  test('restored session whose persisted status is ended resolves null', async () => {
    const { deps, rehydrateCalls } = makeHarness({
      rehydratedSession: fakeSession('sub-1', 'ended'),
    });

    await expect(deps.rehydrateSubSession('sub-1')).resolves.toBeNull();
    expect(rehydrateCalls).toEqual(['sub-1']);
  });

  test('restored session whose persisted status is archived resolves null', async () => {
    const { deps } = makeHarness({
      rehydratedSession: fakeSession('sub-1', 'archived'),
    });

    await expect(deps.rehydrateSubSession('sub-1')).resolves.toBeNull();
  });
});

describe('getCoordinator', () => {
  test('returns the long-horizon coordinator row keyed by id', async () => {
    const { deps } = makeHarness({ coordinatorRow: { id: 'lh-coordinator-1' } });

    await expect(deps.getCoordinator('space-1')).resolves.toEqual({ id: 'lh-coordinator-1' });
  });

  test('missing coordinator resolves null', async () => {
    const { deps } = makeHarness({ coordinatorRow: null });

    await expect(deps.getCoordinator('space-1')).resolves.toBeNull();
  });
});

describe('ensureLongTermAgent', () => {
  test('delegates to ensureAgentSession with (spaceId, agentId)', async () => {
    const ensured = fakeSession('lt-1', 'active');
    const { deps, ensureAgentSessionCalls } = makeHarness({ ensuredSession: ensured });

    await expect(deps.ensureLongTermAgent('space-1', 'agent-9')).resolves.toBe(ensured);
    expect(ensureAgentSessionCalls).toEqual([['space-1', 'agent-9']]);
  });
});

describe('listWorkerExecutions', () => {
  const rows: ExecutionRow[] = [
    { agentName: 'Coder', agentSessionId: 'sess-caps', status: 'idle', workflowNodeId: 'node-1' },
    {
      agentName: 'coder',
      agentSessionId: 'sess-early',
      status: 'completed',
      workflowNodeId: 'node-1',
    },
    {
      agentName: 'coder',
      agentSessionId: 'sess-late',
      status: 'running',
      workflowNodeId: 'node-2',
    },
    {
      agentName: 'reviewer',
      agentSessionId: 'sess-rev',
      status: 'running',
      workflowNodeId: 'node-2',
    },
  ];

  test('matches the agent name exactly without case folding and maps row shape', () => {
    const { deps, listByWorkflowRunCalls } = makeHarness({
      task: { id: 't-1', workflowRunId: 'run-1' },
      executions: rows,
    });

    expect(
      deps.listWorkerExecutions({ kind: 'worker', taskId: 't-1', agentName: 'coder' })
    ).toEqual([
      { sessionId: 'sess-early', status: 'completed' },
      { sessionId: 'sess-late', status: 'running' },
    ]);
    expect(listByWorkflowRunCalls).toEqual(['run-1']);
  });

  test('preserves repository order so the newest row is last', () => {
    const { deps } = makeHarness({
      task: { id: 't-1', workflowRunId: 'run-1' },
      executions: rows,
    });

    const listed = deps.listWorkerExecutions({ kind: 'worker', taskId: 't-1', agentName: 'coder' });

    expect(listed.map((row) => row.sessionId)).toEqual(['sess-early', 'sess-late']);
    expect(listed.at(-1)?.sessionId).toBe('sess-late');
  });

  test('filters to the requested workflow node when provided', () => {
    const { deps } = makeHarness({
      task: { id: 't-1', workflowRunId: 'run-1' },
      executions: rows,
    });

    expect(
      deps.listWorkerExecutions({
        kind: 'worker',
        taskId: 't-1',
        agentName: 'coder',
        workflowNodeId: 'node-2',
      })
    ).toEqual([{ sessionId: 'sess-late', status: 'running' }]);
  });

  test('missing task resolves an empty list without touching the repository', () => {
    const { deps, listByWorkflowRunCalls } = makeHarness({ task: null, executions: rows });

    expect(
      deps.listWorkerExecutions({ kind: 'worker', taskId: 't-1', agentName: 'coder' })
    ).toEqual([]);
    expect(listByWorkflowRunCalls).toHaveLength(0);
  });

  test('task without a workflow run resolves an empty list', () => {
    const { deps } = makeHarness({ task: { id: 't-1', workflowRunId: null } });

    expect(
      deps.listWorkerExecutions({ kind: 'worker', taskId: 't-1', agentName: 'coder' })
    ).toEqual([]);
  });
});

describe('readWorkerTaskPhase', () => {
  test('missing task reads as terminal', () => {
    const { deps } = makeHarness({ task: null });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('terminal');
  });

  test('in_progress reads as run_active without consulting the post-approval worker identity', () => {
    const { deps, workerSessionCalls } = makeHarness({
      task: { id: 't-1', status: 'in_progress' },
    });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('run_active');
    expect(workerSessionCalls).toHaveLength(0);
  });

  test('approved with a recorded post-approval session reads as post_approval', () => {
    const { deps, workerSessionCalls } = makeHarness({
      task: { id: 't-1', status: 'approved', postApprovalSessionId: 'pa-1' },
    });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('post_approval');
    expect(workerSessionCalls).toHaveLength(0);
  });

  test('approved with a blocked reason reads as post_approval', () => {
    const { deps } = makeHarness({
      task: { id: 't-1', status: 'approved', postApprovalBlockedReason: 'spawn superseded' },
    });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('post_approval');
  });

  test('approved without worker state reads as routing', () => {
    const { deps } = makeHarness({ task: { id: 't-1', status: 'approved' } });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('routing');
  });

  test('done with a recorded post-approval session reads as post_approval_done', () => {
    const { deps, workerSessionCalls } = makeHarness({
      task: { id: 't-1', status: 'done', postApprovalSessionId: 'pa-1' },
    });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('post_approval_done');
    expect(workerSessionCalls).toHaveLength(0);
  });

  test('done without a recorded session consults the durable worker identity exactly once', () => {
    const { deps, workerSessionCalls } = makeHarness({
      task: { id: 't-1', status: 'done' },
      postApprovalWorkerSession: { sessionId: 'pa-1', agentName: 'publisher' },
    });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('post_approval_done');
    expect(workerSessionCalls).toEqual(['t-1']);
  });

  test('done with no durable worker reads as done', () => {
    const { deps } = makeHarness({
      task: { id: 't-1', status: 'done' },
      postApprovalWorkerSession: null,
    });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('done');
  });

  test('cancelled reads as terminal', () => {
    const { deps } = makeHarness({ task: { id: 't-1', status: 'cancelled' } });

    expect(deps.readWorkerTaskPhase('t-1')).toBe('terminal');
  });
});

describe('getTaskSpaceId', () => {
  test('returns the task space id', async () => {
    const { deps } = makeHarness({ task: { id: 't-1', spaceId: 'space-9' } });

    await expect(deps.getTaskSpaceId('t-1')).resolves.toBe('space-9');
  });

  test('missing task resolves null', async () => {
    const { deps } = makeHarness({ task: null });

    await expect(deps.getTaskSpaceId('t-1')).resolves.toBeNull();
  });
});

describe('activateTaskAgent', () => {
  test('delegates to ensureWorkflowNodeActivationForAgent with the node-constrained options', async () => {
    const { deps, activationCalls } = makeHarness({ task: { id: 't-1' }, activationResult: true });

    await expect(
      deps.activateTaskAgent({
        kind: 'worker',
        taskId: 't-1',
        agentName: 'coder',
        workflowNodeId: 'node-2',
      })
    ).resolves.toBe(true);
    expect(activationCalls).toEqual([['t-1', 'coder', { workflowNodeId: 'node-2' }]]);
  });

  test('omitted workflow node maps to an undefined node option', async () => {
    const { deps, activationCalls } = makeHarness({ task: { id: 't-1' } });

    await deps.activateTaskAgent({ kind: 'worker', taskId: 't-1', agentName: 'coder' });
    expect(activationCalls).toEqual([['t-1', 'coder', { workflowNodeId: undefined }]]);
  });
});

describe('getPostApprovalWorkerSession', () => {
  test('delegates to the manager identity exactly once preserving shape', () => {
    const workerSession = { sessionId: 'pa-1', agentName: 'publisher', nodeId: 'node-1' };
    const { deps, workerSessionCalls } = makeHarness({ postApprovalWorkerSession: workerSession });

    expect(deps.getPostApprovalWorkerSession('t-1')).toEqual(workerSession);
    expect(workerSessionCalls).toEqual(['t-1']);
  });
});

describe('spawnPostApprovalWorker', () => {
  function spawnHarness(overrides: HarnessConfig = {}): Harness {
    return makeHarness({
      task: {
        id: 't-1',
        title: 'Ship the release',
        spaceId: 'space-1',
        status: 'approved',
        workflowRunId: 'run-1',
        approvalSource: 'human',
        workspacePath: '/ws/space-1',
      },
      run: { id: 'run-1', workflowId: 'wf-1', spaceId: 'space-1' },
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: {
              targetAgent: 'publisher',
              instructions: 'Publish {{task_id}} ({{task_title}}) from {{workspace_path}}',
            },
          },
        ],
      } as Partial<SpaceWorkflow>,
      spawnResult: { sessionId: 'spawned-9' },
      ...overrides,
    });
  }

  test('spawns via the mapped chain, unwraps the session id, and records the routing', async () => {
    const { deps, spawnCalls, updateTaskCalls, getTaskCalls, getRunCalls } = spawnHarness();

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBe('spawned-9');
    expect(getTaskCalls).toEqual(['t-1']);
    expect(getRunCalls).toEqual(['run-1']);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.targetAgent).toBe('publisher');
    expect(spawnCalls[0]?.nodeId).toBeUndefined();
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Publish t-1 (Ship the release) from /ws/space-1\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
    expect(updateTaskCalls).toEqual([
      [
        't-1',
        {
          postApprovalSessionId: 'spawned-9',
          postApprovalStartedAt: expect.any(Number),
          postApprovalBlockedReason: null,
        },
      ],
    ]);
  });

  test('records the routing without publishing when no event bus is wired', async () => {
    const { deps, publishedTaskUpdates } = spawnHarness();

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBe('spawned-9');
    expect(publishedTaskUpdates).toHaveLength(0);
  });

  test('publishes the recovered task update on the internal event bus after recording', async () => {
    const { deps, publishedTaskUpdates, updateTaskCalls } = spawnHarness({
      publishTaskUpdated: true,
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBe('spawned-9');
    expect(updateTaskCalls).toHaveLength(1);
    expect(publishedTaskUpdates).toEqual([{ taskId: 't-1', spaceId: 'space-1' }]);
  });

  test('node id constrains the spawn slot while the canonical first route provides the kickoff', async () => {
    const { deps, spawnCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Node one {{task_id}}' },
          },
          {
            id: 'node-2',
            name: 'publish',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Node two {{task_id}}' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher', 'node-2');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.nodeId).toBe('node-2');
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Node one t-1\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('a route for the agent that is not the canonical dispatch target resolves null', async () => {
    const { deps, spawnCalls, updateTaskCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'reviewer', instructions: 'Review {{task_id}}' },
          },
          {
            id: 'node-2',
            name: 'publish',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Publish {{task_id}}' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(updateTaskCalls).toHaveLength(0);
  });

  test('interpolates autonomy_level and the task-bound workspace from the space service', async () => {
    const { deps, spawnCalls, getSpaceCalls } = spawnHarness({
      space: { autonomyLevel: 3, workspacePath: '/ws/space-root' },
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: {
              targetAgent: 'publisher',
              instructions: 'Deploy at autonomy {{autonomy_level}} from {{workspace_path}}',
            },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher');
    expect(getSpaceCalls).toEqual(['space-1']);
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Deploy at autonomy 3 from /ws/space-1\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('task without its own workspace falls back to the space primary workspace', async () => {
    const { deps, spawnCalls } = spawnHarness({
      space: { autonomyLevel: 3, workspacePath: '/ws/space-root' },
      task: {
        id: 't-1',
        title: 'Ship the release',
        spaceId: 'space-1',
        status: 'approved',
        workflowRunId: 'run-1',
        workspacePath: null,
      },
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: {
              targetAgent: 'publisher',
              instructions: 'Deploy from {{workspace_path}}',
            },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher');
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Deploy from /ws/space-root\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('task cancelled between route resolution and spawn aborts without spawning', async () => {
    const { deps, spawnCalls, updateTaskCalls } = spawnHarness({
      taskReads: [undefined, { id: 't-1', status: 'cancelled', workflowRunId: 'run-1' }],
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(updateTaskCalls).toHaveLength(0);
  });

  test('task cancelled between spawn and recording resolves null without the routing write', async () => {
    const { deps, spawnCalls, updateTaskCalls } = spawnHarness({
      taskReads: [undefined, undefined, { id: 't-1', status: 'cancelled', workflowRunId: 'run-1' }],
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(1);
    expect(updateTaskCalls).toHaveLength(0);
  });

  test('task moved to another workflow run before spawn aborts without spawning', async () => {
    const { deps, spawnCalls } = spawnHarness({
      taskReads: [undefined, { id: 't-1', status: 'approved', workflowRunId: 'run-9' }],
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  test('prefers the node-level route over the workflow-level route', async () => {
    const { deps, spawnCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Node route {{task_id}}' },
          },
        ],
        postApproval: { targetAgent: 'publisher', instructions: 'Workflow route {{task_id}}' },
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher');
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Node route t-1\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('falls back to the workflow-level route when no node route matches', async () => {
    const { deps, spawnCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [],
        postApproval: { targetAgent: 'publisher', instructions: 'Workflow route {{task_id}}' },
      } as Partial<SpaceWorkflow>,
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBe('spawned-9');
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Workflow route t-1\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('leaves unknown template keys as tokens', async () => {
    const { deps, spawnCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Check {{autonomy_level}}' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher');
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Check {{autonomy_level}}\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('interpolates the run primary-link pr_url from the artifact profile', async () => {
    const { deps, spawnCalls, prUrlCalls } = spawnHarness({
      prUrl: 'https://github.com/lsm/HyperNeo/pull/3565',
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Merge {{pr_url}} now' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher');
    expect(prUrlCalls).toEqual(['run-1']);
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Merge https://github.com/lsm/HyperNeo/pull/3565 now\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('pr_url stays a token when no artifact profile is wired', async () => {
    const { deps, spawnCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: 'Merge {{pr_url}} now' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await deps.spawnPostApprovalWorker('t-1', 'publisher');
    expect(spawnCalls[0]?.kickoffMessage).toBe(
      `Merge {{pr_url}} now\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });

  test('empty interpolated instructions resolve null without spawning', async () => {
    const { deps, spawnCalls, updateTaskCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'publisher', instructions: '   ' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(updateTaskCalls).toHaveLength(0);
  });

  test('no route targeting the agent resolves null without spawning', async () => {
    const { deps, spawnCalls } = spawnHarness({
      workflow: {
        id: 'wf-1',
        nodes: [
          {
            id: 'node-1',
            name: 'build',
            agents: [],
            postApproval: { targetAgent: 'reviewer', instructions: 'Review {{task_id}}' },
          },
        ],
      } as Partial<SpaceWorkflow>,
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  test('spawn failure resolves null without recording the routing', async () => {
    const { deps, spawnCalls, updateTaskCalls } = spawnHarness({
      spawnResult: new Error('spawn exploded'),
    });

    await expect(deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(1);
    expect(updateTaskCalls).toHaveLength(0);
  });

  test('missing task, run, or workflow resolves null without spawning', async () => {
    const missingTask = spawnHarness({ task: null });
    await expect(missingTask.deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(missingTask.spawnCalls).toHaveLength(0);

    const detachedTask = spawnHarness({ task: { id: 't-1', workflowRunId: null } });
    await expect(detachedTask.deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(detachedTask.spawnCalls).toHaveLength(0);

    const missingRun = spawnHarness({ run: null });
    await expect(missingRun.deps.spawnPostApprovalWorker('t-1', 'publisher')).resolves.toBeNull();
    expect(missingRun.spawnCalls).toHaveLength(0);

    const missingWorkflow = spawnHarness({ workflow: null });
    await expect(
      missingWorkflow.deps.spawnPostApprovalWorker('t-1', 'publisher')
    ).resolves.toBeNull();
    expect(missingWorkflow.spawnCalls).toHaveLength(0);
  });
});
