import { describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import {
  createDefaultSessionResolutionDeps,
  type DefaultSessionResolutionServices,
} from '../../../../src/lib/session-resolution/default-deps';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';

interface FakeSession {
  getSessionData: () => { status: string; config?: { mcpServers?: Record<string, unknown> } };
}

const sessionOf = (
  status: string,
  config?: { mcpServers?: Record<string, unknown> }
): FakeSession => ({ getSessionData: () => ({ status, config }) });

const WORKFLOW_ID = 'space:space-1:task:task-1:exec:e1';
const NODE_AGENT_CONFIG = { mcpServers: { 'node-agent': { type: 'sdk' } } };

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    workflowRunId: 'run-1',
    status: 'in_progress',
    postApprovalSessionId: null,
    postApprovalBlockedReason: null,
    ...overrides,
  } as SpaceTask;
}

interface Harness {
  deps: SessionResolutionDeps;
  calls: {
    getSubSession: string[];
    getCachedSession: string[];
    getSessionAsync: string[];
    rehydrateSubSessionById: string[];
    getCoordinator: string[];
    ensureAgentSession: Array<[string, string]>;
    isAgentTargetLifecycleEligible: Array<[string, string]>;
    listByWorkflowRun: string[];
    getTask: string[];
    activate: Array<[string, string, { workflowNodeId?: string }]>;
    retry: Array<[string, string]>;
    workerIdentity: string[];
  };
}

function makeHarness(
  overrides: {
    indexed?: (sessionId: string) => FakeSession | undefined;
    cached?: (sessionId: string) => FakeSession | undefined;
    asyncSession?: (sessionId: string) => FakeSession | null;
    rehydrated?: FakeSession | null;
    coordinator?: { id: string } | null;
    ensured?: FakeSession | null;
    eligible?: boolean;
    task?: (taskId: string) => SpaceTask | null;
    executions?: Array<{
      agentName: string;
      agentSessionId: string | null;
      status: string;
      workflowNodeId?: string;
    }>;
    activated?: boolean;
    retryResult?: unknown;
    retryError?: Error;
    workerSession?: { sessionId: string; agentName: string; nodeId?: string | null } | null;
  } = {}
): Harness {
  const calls: Harness['calls'] = {
    getSubSession: [],
    getCachedSession: [],
    getSessionAsync: [],
    rehydrateSubSessionById: [],
    getCoordinator: [],
    ensureAgentSession: [],
    isAgentTargetLifecycleEligible: [],
    listByWorkflowRun: [],
    getTask: [],
    activate: [],
    retry: [],
    workerIdentity: [],
  };
  const services = {
    sessionManager: {
      getCachedSession: (sessionId: string) => {
        calls.getCachedSession.push(sessionId);
        return overrides.cached?.(sessionId);
      },
      getSessionAsync: async (sessionId: string) => {
        calls.getSessionAsync.push(sessionId);
        return overrides.asyncSession?.(sessionId) ?? null;
      },
    },
    taskAgentManager: {
      getSubSession: (sessionId: string) => {
        calls.getSubSession.push(sessionId);
        return overrides.indexed?.(sessionId);
      },
      rehydrateSubSessionById: async (sessionId: string) => {
        calls.rehydrateSubSessionById.push(sessionId);
        return overrides.rehydrated ?? null;
      },
      ensureWorkflowNodeActivationForAgent: async (
        taskId: string,
        agentName: string,
        options: { workflowNodeId?: string }
      ) => {
        calls.activate.push([taskId, agentName, options]);
        return overrides.activated ?? false;
      },
      getPostApprovalWorkerSession: (taskId: string) => {
        calls.workerIdentity.push(taskId);
        return overrides.workerSession ?? null;
      },
    },
    spaceRuntimeService: {
      ensureAgentSession: async (spaceId: string, agentId: string) => {
        calls.ensureAgentSession.push([spaceId, agentId]);
        return overrides.ensured ?? null;
      },
      isAgentTargetLifecycleEligible: async (spaceId: string, agentId: string) => {
        calls.isAgentTargetLifecycleEligible.push([spaceId, agentId]);
        return overrides.eligible ?? false;
      },
      retryPostApprovalDispatch: async (spaceId: string, taskId: string) => {
        calls.retry.push([spaceId, taskId]);
        if (overrides.retryError) throw overrides.retryError;
        return overrides.retryResult ?? { mode: 'skipped', reason: 'unused' };
      },
    },
    nodeExecutionRepo: {
      listByWorkflowRun: (workflowRunId: string) => {
        calls.listByWorkflowRun.push(workflowRunId);
        return (overrides.executions ?? []).map((execution, index) => ({
          ...execution,
          workflowRunId,
          id: `exec-${index}`,
        }));
      },
    },
    taskRepo: {
      getTask: (taskId: string) => {
        calls.getTask.push(taskId);
        return overrides.task ? overrides.task(taskId) : makeTask({ id: taskId });
      },
    },
    longHorizonAgentRepo: {
      getCoordinator: (spaceId: string) => {
        calls.getCoordinator.push(spaceId);
        return overrides.coordinator ?? null;
      },
    },
  } as unknown as DefaultSessionResolutionServices;
  return { deps: createDefaultSessionResolutionDeps(services), calls };
}

describe('createDefaultSessionResolutionDeps', () => {
  describe('getSession', () => {
    test('indexed sub-session backed by the cache resolves without the async lookup', async () => {
      const live = sessionOf('active');
      const { deps, calls } = makeHarness({
        indexed: () => live,
        cached: () => live,
      });
      expect(await deps.getSession('sess-1')).toBe(live);
      expect(calls.getSessionAsync).toEqual([]);
    });

    test('ended and archived indexed sub-sessions resolve null', async () => {
      for (const status of ['ended', 'archived']) {
        const stale = sessionOf(status);
        const { deps } = makeHarness({ indexed: () => stale, cached: () => stale });
        expect(await deps.getSession('sess-1')).toBeNull();
      }
    });

    test('indexed workflow sub-session gates on the runtime node-agent server', async () => {
      const bare = sessionOf('active', { mcpServers: {} });
      const bareHarness = makeHarness({ indexed: () => bare, cached: () => bare });
      expect(await bareHarness.deps.getSession(WORKFLOW_ID)).toBeNull();
      const attached = sessionOf('active', NODE_AGENT_CONFIG);
      const attachedHarness = makeHarness({ indexed: () => attached, cached: () => attached });
      expect(await attachedHarness.deps.getSession(WORKFLOW_ID)).toBe(attached);
    });

    test('non-indexed session falls through to exactly one async lookup', async () => {
      const bare = sessionOf('active', { mcpServers: {} });
      const { deps, calls } = makeHarness({ asyncSession: () => bare });
      expect(await deps.getSession('sess-1')).toBe(bare);
      expect(calls.getSessionAsync).toEqual(['sess-1']);
    });

    test('ended, archived, and missing async sessions resolve null', async () => {
      for (const session of [sessionOf('ended'), sessionOf('archived'), null]) {
        const { deps } = makeHarness({ asyncSession: () => session });
        expect(await deps.getSession('sess-1')).toBeNull();
      }
    });

    test('non-indexed workflow sub-session without a runtime node-agent server resolves null', async () => {
      const bare = sessionOf('active', { mcpServers: {} });
      const { deps } = makeHarness({ asyncSession: () => bare });
      expect(await deps.getSession(WORKFLOW_ID)).toBeNull();
    });
  });

  describe('rehydrateSubSession', () => {
    test('delegates to rehydrateSubSessionById once; a null restore resolves null', async () => {
      const restored = sessionOf('active');
      const { deps, calls } = makeHarness({ rehydrated: restored });
      expect(await deps.rehydrateSubSession(WORKFLOW_ID)).toBe(restored);
      expect(calls.rehydrateSubSessionById).toEqual([WORKFLOW_ID]);
      const empty = makeHarness({ rehydrated: null });
      expect(await empty.deps.rehydrateSubSession(WORKFLOW_ID)).toBeNull();
    });
  });

  describe('getCoordinator', () => {
    test('returns the coordinator row keyed by space, or null', async () => {
      const { deps, calls } = makeHarness({ coordinator: { id: 'coord-9' } });
      expect(await deps.getCoordinator('space-1')).toEqual({ id: 'coord-9' });
      expect(calls.getCoordinator).toEqual(['space-1']);
      const missing = makeHarness({ coordinator: null });
      expect(await missing.deps.getCoordinator('space-1')).toBeNull();
    });
  });

  describe('agent-target methods', () => {
    test('ensureLongTermAgent delegates to ensureAgentSession with exact args', async () => {
      const ensured = sessionOf('active');
      const { deps, calls } = makeHarness({ ensured });
      expect(await deps.ensureLongTermAgent('space-1', 'agent-7')).toBe(ensured);
      expect(calls.ensureAgentSession).toEqual([['space-1', 'agent-7']]);
    });

    test('isAgentTargetLifecycleEligible delegates with exact args', async () => {
      const { deps, calls } = makeHarness({ eligible: true });
      expect(await deps.isAgentTargetLifecycleEligible('space-1', 'agent-7')).toBe(true);
      expect(calls.isAgentTargetLifecycleEligible).toEqual([['space-1', 'agent-7']]);
    });
  });

  describe('listWorkerExecutions', () => {
    test('matches the agent name exactly, maps the row shape, and preserves order', async () => {
      const { deps, calls } = makeHarness({
        executions: [
          { agentName: 'coder', agentSessionId: 's-a', status: 'in_progress' },
          { agentName: 'Coder', agentSessionId: 's-b', status: 'in_progress' },
          { agentName: 'coder', agentSessionId: 's-c', status: 'blocked' },
        ],
      });
      expect(
        deps.listWorkerExecutions({ kind: 'worker', taskId: 'task-1', agentName: 'coder' })
      ).toEqual([
        { sessionId: 's-a', status: 'in_progress' },
        { sessionId: 's-c', status: 'blocked' },
      ]);
      expect(calls.listByWorkflowRun).toEqual(['run-1']);
      expect(calls.getTask).toEqual(['task-1']);
    });

    test('filters to the requested workflow node when provided', () => {
      const { deps } = makeHarness({
        executions: [
          {
            agentName: 'coder',
            agentSessionId: 's-a',
            status: 'in_progress',
            workflowNodeId: 'n1',
          },
          {
            agentName: 'coder',
            agentSessionId: 's-b',
            status: 'in_progress',
            workflowNodeId: 'n2',
          },
        ],
      });
      const listed = deps.listWorkerExecutions({
        kind: 'worker',
        taskId: 'task-1',
        agentName: 'coder',
        workflowNodeId: 'n2',
      });
      expect(listed).toEqual([{ sessionId: 's-b', status: 'in_progress' }]);
    });

    test('missing task and task without a workflow run resolve an empty list', () => {
      const missing = makeHarness({ task: () => null });
      expect(
        missing.deps.listWorkerExecutions({ kind: 'worker', taskId: 't', agentName: 'coder' })
      ).toEqual([]);
      expect(missing.calls.listByWorkflowRun).toEqual([]);
      const detached = makeHarness({ task: (id) => makeTask({ id, workflowRunId: null }) });
      expect(
        detached.deps.listWorkerExecutions({ kind: 'worker', taskId: 't', agentName: 'coder' })
      ).toEqual([]);
    });
  });

  describe('readWorkerTaskPhase', () => {
    test('missing and cancelled tasks read as terminal', () => {
      const missing = makeHarness({ task: () => null });
      expect(missing.deps.readWorkerTaskPhase('task-1')).toBe('terminal');
      const cancelled = makeHarness({ task: (id) => makeTask({ id, status: 'cancelled' }) });
      expect(cancelled.deps.readWorkerTaskPhase('task-1')).toBe('terminal');
    });

    test('non-terminal statuses map without consulting the durable worker identity', () => {
      const active = makeHarness({ task: (id) => makeTask({ id, status: 'in_progress' }) });
      expect(active.deps.readWorkerTaskPhase('task-1')).toBe('run_active');
      expect(active.calls.workerIdentity).toEqual([]);
    });

    test('approved maps through recorded routing, blocked reason, or routing', () => {
      const routed = makeHarness({
        task: (id) => makeTask({ id, status: 'approved', postApprovalSessionId: 'w-1' }),
      });
      expect(routed.deps.readWorkerTaskPhase('task-1')).toBe('post_approval');
      const blocked = makeHarness({
        task: (id) => makeTask({ id, status: 'approved', postApprovalBlockedReason: 'deferred' }),
      });
      expect(blocked.deps.readWorkerTaskPhase('task-1')).toBe('post_approval');
      const bare = makeHarness({ task: (id) => makeTask({ id, status: 'approved' }) });
      expect(bare.deps.readWorkerTaskPhase('task-1')).toBe('routing');
    });

    test('done consults the durable worker identity exactly once when unrouted', () => {
      const withWorker = makeHarness({
        task: (id) => makeTask({ id, status: 'done' }),
        workerSession: { sessionId: 'w-1', agentName: 'coder', nodeId: null },
      });
      expect(withWorker.deps.readWorkerTaskPhase('task-1')).toBe('post_approval_done');
      expect(withWorker.calls.workerIdentity).toEqual(['task-1']);
      const routed = makeHarness({
        task: (id) => makeTask({ id, status: 'done', postApprovalSessionId: 'w-1' }),
      });
      expect(routed.deps.readWorkerTaskPhase('task-1')).toBe('post_approval_done');
      expect(routed.calls.workerIdentity).toEqual([]);
      const bare = makeHarness({ task: (id) => makeTask({ id, status: 'done' }) });
      expect(bare.deps.readWorkerTaskPhase('task-1')).toBe('done');
    });
  });

  describe('getTaskSpaceId', () => {
    test('returns the task space id or null', async () => {
      const { deps } = makeHarness();
      expect(await deps.getTaskSpaceId('task-1')).toBe('space-1');
      const missing = makeHarness({ task: () => null });
      expect(await missing.deps.getTaskSpaceId('task-1')).toBeNull();
    });
  });

  describe('activateTaskAgent', () => {
    test('delegates with node-constrained options', async () => {
      const { deps, calls } = makeHarness({ activated: true });
      expect(
        await deps.activateTaskAgent({
          kind: 'worker',
          taskId: 'task-1',
          agentName: 'coder',
          workflowNodeId: 'n1',
        })
      ).toBe(true);
      expect(calls.activate).toEqual([['task-1', 'coder', { workflowNodeId: 'n1' }]]);
    });

    test('omitted workflow node maps to an undefined node option', async () => {
      const { deps, calls } = makeHarness({ activated: false });
      expect(
        await deps.activateTaskAgent({ kind: 'worker', taskId: 'task-1', agentName: 'coder' })
      ).toBe(false);
      expect(calls.activate).toEqual([['task-1', 'coder', { workflowNodeId: undefined }]]);
    });
  });

  describe('spawnPostApprovalWorker', () => {
    test('delegates to the canonical retry and returns the routed id for a matching target', async () => {
      const { deps, calls } = makeHarness({
        retryResult: {
          mode: 'spawn',
          postApprovalSessionId: 'w-1',
          postApprovalStartedAt: 1,
          missingKeys: [],
        },
        workerSession: { sessionId: 'w-1', agentName: 'coder', nodeId: 'n1' },
      });
      expect(await deps.spawnPostApprovalWorker('task-1', 'coder', 'n1')).toBe('w-1');
      expect(calls.retry).toEqual([['space-1', 'task-1']]);
    });

    test('an already-routed retry still returns its recorded session id', async () => {
      const { deps } = makeHarness({
        retryResult: { mode: 'already-routed', postApprovalSessionId: 'w-1' },
        workerSession: { sessionId: 'w-1', agentName: 'coder', nodeId: null },
      });
      expect(await deps.spawnPostApprovalWorker('task-1', 'coder')).toBe('w-1');
    });

    test('a retry result that does not match the requested target resolves null', async () => {
      const retryResult = {
        mode: 'spawn',
        postApprovalSessionId: 'w-1',
        postApprovalStartedAt: 1,
        missingKeys: [],
      };
      const mismatches: Array<
        [
          string,
          string | undefined,
          { sessionId: string; agentName: string; nodeId?: string | null } | null,
        ]
      > = [
        ['coder', undefined, { sessionId: 'w-1', agentName: 'reviewer', nodeId: null }],
        ['coder', 'n1', { sessionId: 'w-1', agentName: 'coder', nodeId: 'n2' }],
        ['coder', undefined, { sessionId: 'w-other', agentName: 'coder', nodeId: null }],
        ['coder', undefined, null],
      ];
      for (const [agentName, nodeId, workerSession] of mismatches) {
        const { deps } = makeHarness({ retryResult, workerSession });
        expect(await deps.spawnPostApprovalWorker('task-1', agentName, nodeId)).toBeNull();
      }
    });

    test('skipped, no-route, missing-task, and throwing retries resolve null', async () => {
      const skipped = makeHarness({ retryResult: { mode: 'skipped', reason: 'blocked' } });
      expect(await skipped.deps.spawnPostApprovalWorker('task-1', 'coder')).toBeNull();
      const noRoute = makeHarness({ retryResult: { mode: 'no-route', taskStatus: 'done' } });
      expect(await noRoute.deps.spawnPostApprovalWorker('task-1', 'coder')).toBeNull();
      const missingTask = makeHarness({ task: () => null });
      expect(await missingTask.deps.spawnPostApprovalWorker('task-1', 'coder')).toBeNull();
      expect(missingTask.calls.retry).toEqual([]);
      const throwing = makeHarness({ retryError: new Error('spawn failed') });
      expect(await throwing.deps.spawnPostApprovalWorker('task-1', 'coder')).toBeNull();
    });
  });

  describe('getPostApprovalWorkerSession', () => {
    test('delegates once preserving shape', () => {
      const worker = { sessionId: 'w-1', agentName: 'coder', nodeId: 'n1' };
      const { deps, calls } = makeHarness({ workerSession: worker });
      expect(deps.getPostApprovalWorkerSession('task-1')).toBe(worker);
      expect(calls.workerIdentity).toEqual(['task-1']);
    });
  });
});
