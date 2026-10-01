import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  decideLiveWorkspaceSync,
  migrateLiveWorkspaceSession,
  resolveLiveWorkspaceSyncTarget,
  runLiveWorkspaceSyncFlow,
  type LiveWorkspaceSyncRequest,
} from '../../../../src/lib/space/runtime/live-workspace-sync-flow';
import {
  admitWorkflowProvisioning,
  rehydrateExecutionStage,
  resolveProvisioningOwner,
  restorePostApprovalWorkerStage,
  runProvisionWorkflowSessionFlow,
  selectProvisioningArm,
  type ProvisioningFacts,
  type ProvisioningOwner,
  type ProvisioningRequest,
} from '../../../../src/lib/space/runtime/provision-workflow-session-flow';
import {
  healWorkspaceSession,
  resolveSelfHealWorkspaceTarget,
  runSelfHealWorkspaceFlow,
  type SelfHealWorkspaceRequest,
} from '../../../../src/lib/space/runtime/self-heal-workspace-flow';

const TASK_ID = 'task-1';
const SPACE_ID = 'space-1';
const RUN_ID = 'run-1';
const SESSION_ID = 'session-1';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    status: 'in_progress',
    workspacePath: null,
    ...overrides,
  } as unknown as SpaceTask;
}

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: SPACE_ID,
    workspacePath: '/tmp/space',
    status: 'active',
    stopped: false,
    paused: false,
    ...overrides,
  } as unknown as Space;
}

function makeRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
  return {
    id: RUN_ID,
    workflowId: 'workflow-1',
    status: 'in_progress',
    ...overrides,
  } as unknown as SpaceWorkflowRun;
}

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'execution-1',
    workflowRunId: RUN_ID,
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentSessionId: SESSION_ID,
    status: 'in_progress',
    ...overrides,
  } as unknown as NodeExecution;
}

interface FakeSession {
  session: AgentSession;
  data: { id: string; status: string; workspacePath: string | null };
  writes: Array<string | null>;
}

function makeFakeSession(workspacePath: string | null = '/tmp/one'): FakeSession {
  const data = { id: SESSION_ID, status: 'active', workspacePath };
  const writes: Array<string | null> = [];
  const session = {
    getSessionData: () => data,
    updateMetadata: (patch: { workspacePath?: string | null }) => {
      writes.push(patch.workspacePath ?? null);
      data.workspacePath = patch.workspacePath ?? null;
    },
  } as unknown as AgentSession;
  return { session, data, writes };
}

function syncRequest(overrides: Partial<LiveWorkspaceSyncRequest> = {}): LiveWorkspaceSyncRequest {
  return {
    task: makeTask(),
    space: makeSpace(),
    execution: makeExecution(),
    sessionId: SESSION_ID,
    ...overrides,
  };
}

const noSubSession = () => undefined;
const noTerminal = () => null;

describe('decideLiveWorkspaceSync', () => {
  const targetFor = (request: LiveWorkspaceSyncRequest) => ({
    task: request.task,
    workspacePath: '/tmp/space',
  });

  test('skips when the task or run is terminal', () => {
    const request = syncRequest();
    const decision = decideLiveWorkspaceSync(
      () => 'done',
      () => makeFakeSession().session,
      targetFor(request),
      request
    );
    expect(decision).toEqual({ reason: { kind: 'skip', message: 'task/run is terminal (done)' } });
  });

  test('skips when the session is no longer live', () => {
    const request = syncRequest();
    const decision = decideLiveWorkspaceSync(noTerminal, noSubSession, targetFor(request), request);
    expect(decision).toEqual({ reason: { kind: 'skip', message: 'session is no longer live' } });
  });

  test('rejects when the task moved to another space', () => {
    const request = syncRequest({ task: makeTask({ spaceId: 'space-2' }) });
    const decision = decideLiveWorkspaceSync(
      noTerminal,
      () => makeFakeSession().session,
      targetFor(request),
      request
    );
    expect(decision).toEqual({
      reason: { kind: 'reject', message: expect.stringContaining('moved to space space-2') },
    });
  });

  test('rejects when the task detached from the workflow run', () => {
    const request = syncRequest({ task: makeTask({ workflowRunId: null }) });
    const decision = decideLiveWorkspaceSync(
      noTerminal,
      () => makeFakeSession().session,
      targetFor(request),
      request
    );
    expect(decision).toEqual({
      reason: { kind: 'reject', message: expect.stringContaining('detached') },
    });
  });

  test('skips when the workspace already matches', () => {
    const request = syncRequest();
    const decision = decideLiveWorkspaceSync(
      noTerminal,
      () => makeFakeSession('/tmp/space').session,
      targetFor(request),
      request
    );
    expect(decision).toEqual({ reason: { kind: 'skip', message: 'workspace already matches' } });
  });

  test('admits the migration when every gate passes', () => {
    const request = syncRequest();
    const decision = decideLiveWorkspaceSync(
      noTerminal,
      () => makeFakeSession('/tmp/one').session,
      targetFor(request),
      request
    );
    expect(decision).toEqual({
      value: {
        kind: 'migrate',
        taskId: TASK_ID,
        subSessionId: SESSION_ID,
        agentName: 'coder',
        spaceId: SPACE_ID,
        workflowRunId: RUN_ID,
        workspacePath: '/tmp/space',
        workflowNodeId: 'node-1',
        previousWorkspacePath: '/tmp/one',
      },
    });
  });

  test('a terminal run outranks a rejected workspace move', () => {
    const request = syncRequest({ task: makeTask({ spaceId: 'space-2' }) });
    const decision = decideLiveWorkspaceSync(
      () => 'cancelled',
      () => makeFakeSession().session,
      targetFor(request),
      request
    );
    expect(decision).toEqual({
      reason: { kind: 'skip', message: 'task/run is terminal (cancelled)' },
    });
  });
});

describe('resolveLiveWorkspaceSyncTarget', () => {
  test('prefers the cached worktree path over the space workspace', () => {
    const target = resolveLiveWorkspaceSyncTarget(noSubSessionGet, () => '/tmp/worktree', {
      task: makeTask(),
      space: makeSpace(),
      execution: makeExecution(),
      sessionId: SESSION_ID,
    });
    expect(target.workspacePath).toBe('/tmp/worktree');
  });

  test('reloads the task before resolving the workspace', () => {
    const target = resolveLiveWorkspaceSyncTarget(
      () => makeTask({ workspacePath: '/tmp/explicit' }),
      () => undefined,
      {
        task: makeTask(),
        space: makeSpace(),
        execution: makeExecution(),
        sessionId: SESSION_ID,
      }
    );
    expect(target.workspacePath).toBe('/tmp/explicit');
  });
});

const noSubSessionGet = () => undefined;
const noTaskReload = () => null;
const noWorkspaceCache = () => undefined;

describe('migrateLiveWorkspaceSession', () => {
  test('writes the workspace and reinjects MCP servers', async () => {
    const fake = makeFakeSession('/tmp/one');
    const injected: string[] = [];
    await migrateLiveWorkspaceSession(
      () => fake.session,
      async (_session, ctx) => {
        injected.push(ctx.workspacePath);
      },
      {
        kind: 'migrate',
        taskId: TASK_ID,
        subSessionId: SESSION_ID,
        agentName: 'coder',
        spaceId: SPACE_ID,
        workflowRunId: RUN_ID,
        workspacePath: '/tmp/space',
        workflowNodeId: 'node-1',
        previousWorkspacePath: '/tmp/one',
      }
    );
    expect(fake.data.workspacePath).toBe('/tmp/space');
    expect(injected).toEqual(['/tmp/space']);
  });

  test('restores a null workspace when the reinject fails', async () => {
    const fake = makeFakeSession(null);
    await expect(
      migrateLiveWorkspaceSession(
        () => fake.session,
        async () => {
          throw new Error('restart boom');
        },
        {
          kind: 'migrate',
          taskId: TASK_ID,
          subSessionId: SESSION_ID,
          agentName: 'coder',
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
          workspacePath: '/tmp/space',
          workflowNodeId: 'node-1',
          previousWorkspacePath: null,
        }
      )
    ).rejects.toThrow('restart boom');
    expect(fake.data.workspacePath).toBeNull();
  });

  test('restores the previous workspace when the reinject fails', async () => {
    const fake = makeFakeSession('/tmp/one');
    await expect(
      migrateLiveWorkspaceSession(
        () => fake.session,
        async () => {
          throw new Error('restart boom');
        },
        {
          kind: 'migrate',
          taskId: TASK_ID,
          subSessionId: SESSION_ID,
          agentName: 'coder',
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
          workspacePath: '/tmp/space',
          workflowNodeId: 'node-1',
          previousWorkspacePath: '/tmp/one',
        }
      )
    ).rejects.toThrow('restart boom');
    expect(fake.data.workspacePath).toBe('/tmp/one');
  });
});

describe('runLiveWorkspaceSyncFlow', () => {
  test('runs no effect when the decision rejects the migration', async () => {
    const reinjects: string[] = [];
    const outcome = await runLiveWorkspaceSyncFlow(
      {
        getTask: () => makeTask(),
        getCachedTaskWorktreePath: () => undefined,
        readTerminalInjectionStatus: () => null,
        getSubSession: () => makeFakeSession('/tmp/space').session,
        reinjectNodeAgentMcpServer: async () => {
          reinjects.push('reinject');
        },
      },
      syncRequest()
    );
    expect(outcome).toEqual({ kind: 'skip', message: 'workspace already matches' });
    expect(reinjects).toEqual([]);
  });

  test('migrates the live session when the decision admits it', async () => {
    const fake = makeFakeSession('/tmp/one');
    const outcome = await runLiveWorkspaceSyncFlow(
      {
        getTask: () => makeTask(),
        getCachedTaskWorktreePath: () => undefined,
        readTerminalInjectionStatus: () => null,
        getSubSession: () => fake.session,
        reinjectNodeAgentMcpServer: async () => undefined,
      },
      syncRequest()
    );
    expect(outcome).toMatchObject({ kind: 'migrate', workspacePath: '/tmp/space' });
    expect(fake.data.workspacePath).toBe('/tmp/space');
  });
});

function makeOwner(overrides: Partial<ProvisioningOwner> = {}): ProvisioningOwner {
  return {
    request: {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      session: makeFakeSession().session,
      options: {},
    },
    task: makeTask(),
    workflowRun: makeRun(),
    space: makeSpace(),
    ...overrides,
  };
}

describe('admitWorkflowProvisioning', () => {
  const resumable = () => makeExecution();

  test('rejects an archived session before any other check', () => {
    const owner = makeOwner({
      request: {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        session: makeFakeSession().session,
        options: {},
      },
    });
    (owner.request.session.getSessionData() as { status: string }).status = 'archived';
    expect(admitWorkflowProvisioning(resumable, () => false, owner)).toEqual({
      reason: 'archived_session',
    });
  });

  test('rejects an owner whose task lost its workflow run', () => {
    expect(
      admitWorkflowProvisioning(
        resumable,
        () => false,
        makeOwner({ task: makeTask({ workflowRunId: null }) })
      )
    ).toEqual({ reason: 'ineligible' });
  });

  test('rejects a cancelled workflow run', () => {
    expect(
      admitWorkflowProvisioning(
        resumable,
        () => false,
        makeOwner({ workflowRun: makeRun({ status: 'cancelled' }) })
      )
    ).toEqual({ reason: 'ineligible' });
  });

  for (const space of [
    makeSpace({ stopped: true }),
    makeSpace({ paused: true }),
    makeSpace({ status: 'archived' }),
  ]) {
    test(`rejects a ${space.stopped ? 'stopped' : space.paused ? 'paused' : 'archived'} space`, () => {
      expect(admitWorkflowProvisioning(resumable, () => false, makeOwner({ space }))).toEqual({
        reason: 'ineligible',
      });
    });
  }

  test('rejects a missing space', () => {
    expect(admitWorkflowProvisioning(resumable, () => false, makeOwner({ space: null }))).toEqual({
      reason: 'ineligible',
    });
  });

  test('rejects a post-approval session whose task is not approved', () => {
    const owner = makeOwner({ task: makeTask({ status: 'review' }) });
    owner.request.sessionId = `${SESSION_ID}:post-approval:1`;
    expect(admitWorkflowProvisioning(resumable, () => false, owner)).toEqual({
      reason: 'post_approval_not_active',
    });
  });

  test('admits an approved post-approval session', () => {
    const owner = makeOwner({ task: makeTask({ status: 'approved' }) });
    owner.request.sessionId = `${SESSION_ID}:post-approval:1`;
    expect(admitWorkflowProvisioning(resumable, () => false, owner)).toEqual({
      value: {
        request: owner.request,
        task: owner.task,
        workflowRun: owner.workflowRun,
        space: owner.space,
        arm: 'post_approval',
      },
    });
  });

  for (const status of ['done', 'cancelled', 'archived', 'stopped'] as const) {
    test(`rejects the terminal task status ${status}`, () => {
      const owner = makeOwner({ task: makeTask({ status }) });
      expect(admitWorkflowProvisioning(resumable, () => false, owner)).toEqual({
        reason: 'ineligible',
      });
    });
  }

  test('rejects a completed workflow run', () => {
    expect(
      admitWorkflowProvisioning(
        resumable,
        () => false,
        makeOwner({ workflowRun: makeRun({ status: 'done' }) })
      )
    ).toEqual({ reason: 'ineligible' });
  });

  test('rejects a session with no resolvable execution', () => {
    expect(
      admitWorkflowProvisioning(
        () => null,
        () => false,
        makeOwner()
      )
    ).toEqual({
      reason: 'missing_execution',
    });
  });

  test('rejects an execution that is neither resumable nor hook-backed', () => {
    expect(
      admitWorkflowProvisioning(
        () => makeExecution({ status: 'completed' }),
        () => false,
        makeOwner()
      )
    ).toEqual({ reason: 'non_resumable_execution' });
  });

  for (const status of ['in_progress', 'blocked'] as const) {
    test(`admits the resumable execution status ${status}`, () => {
      const owner = makeOwner();
      expect(
        admitWorkflowProvisioning(
          () => makeExecution({ status }),
          () => false,
          owner
        )
      ).toEqual({
        value: {
          request: owner.request,
          task: owner.task,
          workflowRun: owner.workflowRun,
          space: owner.space,
          arm: 'rehydrate',
        },
      });
    });
  }

  test('admits a non-resumable execution that still has a queued retryable hook action', () => {
    const owner = makeOwner();
    expect(
      admitWorkflowProvisioning(
        () => makeExecution({ status: 'completed' }),
        () => true,
        owner
      )
    ).toEqual({
      value: {
        request: owner.request,
        task: owner.task,
        workflowRun: owner.workflowRun,
        space: owner.space,
        arm: 'rehydrate',
      },
    });
  });
});

describe('selectProvisioningArm', () => {
  const facts = (arm: 'post_approval' | 'rehydrate'): ProvisioningFacts => ({
    request: {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      session: makeFakeSession().session,
      options: {},
    },
    task: makeTask(),
    workflowRun: makeRun(),
    space: makeSpace(),
    arm,
  });

  test('binds only the post-approval arm', () => {
    const selected = selectProvisioningArm(facts('post_approval'));
    expect(selected.postApprovalArm).toBe(restorePostApprovalWorkerStage);
    expect(selected.rehydrateArm).toBeUndefined();
  });

  test('binds only the rehydrate arm', () => {
    const selected = selectProvisioningArm(facts('rehydrate'));
    expect(selected.rehydrateArm).toBe(rehydrateExecutionStage);
    expect(selected.postApprovalArm).toBeUndefined();
  });
});

describe('provisioning arm stages', () => {
  test('restores a post-approval worker without starting a query during a persisted cooldown', async () => {
    const calls: Array<{ taskId: string; sessionId: string; startQuery: boolean | undefined }> = [];
    await restorePostApprovalWorkerStage(
      async (taskId, sessionId, _session, options) => {
        calls.push({ taskId, sessionId, startQuery: options.startQuery });
        return null;
      },
      () => ({ retryAt: 1 }),
      {
        request: {
          taskId: TASK_ID,
          sessionId: SESSION_ID,
          session: makeFakeSession().session,
          options: { startQuery: true },
        },
        task: makeTask(),
        workflowRun: makeRun(),
        space: makeSpace(),
        arm: 'post_approval',
      }
    );
    expect(calls).toEqual([{ taskId: TASK_ID, sessionId: SESSION_ID, startQuery: false }]);
  });

  test('rehydrates an execution without starting a query when the options are clean', async () => {
    const calls: Array<{ sessionId: string; startQuery: boolean | undefined }> = [];
    await rehydrateExecutionStage(
      async (sessionId, _session, options) => {
        calls.push({ sessionId, startQuery: options.startQuery });
        return null;
      },
      () => null,
      {
        request: {
          taskId: TASK_ID,
          sessionId: SESSION_ID,
          session: makeFakeSession().session,
          options: { startQuery: true },
        },
        task: makeTask(),
        workflowRun: makeRun(),
        space: makeSpace(),
        arm: 'rehydrate',
      }
    );
    expect(calls).toEqual([{ sessionId: SESSION_ID, startQuery: true }]);
  });
});

describe('runProvisionWorkflowSessionFlow', () => {
  test('runs no provisioning effect for a rejected session', async () => {
    const effects: string[] = [];
    const outcome = await runProvisionWorkflowSessionFlow(
      {
        getTask: () => makeTask(),
        getWorkflowRun: () => makeRun(),
        getSpace: async () => makeSpace({ stopped: true }),
        resolveNodeExecution: () => makeExecution(),
        hasQueuedRetryableHookAction: () => false,
        readPersistedRateLimitCooldown: () => null,
        restorePostApprovalWorkerSession: async () => {
          effects.push('post-approval');
          return null;
        },
        rehydrateSubSession: async () => {
          effects.push('rehydrate');
          return null;
        },
      },
      { taskId: TASK_ID, sessionId: SESSION_ID, session: makeFakeSession().session, options: {} }
    );
    expect(outcome).toBe('ineligible');
    expect(effects).toEqual([]);
  });

  test('runs only the rehydrate arm for an eligible ordinary worker', async () => {
    const effects: string[] = [];
    const outcome = await runProvisionWorkflowSessionFlow(
      {
        getTask: () => makeTask(),
        getWorkflowRun: () => makeRun(),
        getSpace: async () => makeSpace(),
        resolveNodeExecution: () => makeExecution(),
        hasQueuedRetryableHookAction: () => false,
        readPersistedRateLimitCooldown: () => null,
        restorePostApprovalWorkerSession: async () => {
          effects.push('post-approval');
          return null;
        },
        rehydrateSubSession: async () => {
          effects.push('rehydrate');
          return null;
        },
      },
      { taskId: TASK_ID, sessionId: SESSION_ID, session: makeFakeSession().session, options: {} }
    );
    expect(outcome).toMatchObject({ arm: 'rehydrate' });
    expect(effects).toEqual(['rehydrate']);
  });
});

function selfHealRequest(
  overrides: Partial<SelfHealWorkspaceRequest> = {}
): SelfHealWorkspaceRequest {
  return {
    ownerTask: makeTask(),
    agentSession: makeFakeSession('/tmp/one').session,
    execution: makeExecution(),
    sessionId: SESSION_ID,
    spaceWorkspacePath: '/tmp/space',
    ...overrides,
  };
}

describe('resolveSelfHealWorkspaceTarget', () => {
  test('refuses to heal when the reloaded owner moved to another workflow run', () => {
    expect(() =>
      resolveSelfHealWorkspaceTarget(
        () => makeTask({ workflowRunId: 'run-2' }),
        noWorkspaceCache,
        selfHealRequest()
      )
    ).toThrow('no longer belongs to workflow run run-1');
  });

  test('prefers the cached worktree over the explicit and session workspaces', () => {
    const plan = resolveSelfHealWorkspaceTarget(
      noTaskReload,
      () => '/tmp/worktree',
      selfHealRequest()
    );
    expect(plan.workspacePath).toBe('/tmp/worktree');
    expect(plan.mcpContext.workspacePath).toBe('/tmp/worktree');
  });

  test('falls back to the live session workspace', () => {
    const plan = resolveSelfHealWorkspaceTarget(noTaskReload, noWorkspaceCache, selfHealRequest());
    expect(plan.workspacePath).toBe('/tmp/one');
  });
});

describe('healWorkspaceSession', () => {
  test('writes the workspace, reinjects MCP servers and verifies the attachment', async () => {
    const fake = makeFakeSession('/tmp/one');
    const request = selfHealRequest({ agentSession: fake.session });
    const plan = resolveSelfHealWorkspaceTarget(noTaskReload, () => undefined, request);
    const order: string[] = [];
    await healWorkspaceSession(
      async () => {
        order.push('reinject');
      },
      async (_session, ctx) => {
        order.push(`ensure:${ctx.phase}`);
      },
      request,
      plan
    );
    expect(fake.data.workspacePath).toBe('/tmp/one');
    expect(order).toEqual(['ensure:rehydrate']);
  });

  test('heals a mismatched workspace and rolls it back when the reinject fails', async () => {
    const fake = makeFakeSession('/tmp/other');
    const request = selfHealRequest({ agentSession: fake.session });
    const plan = resolveSelfHealWorkspaceTarget(noTaskReload, () => '/tmp/worktree', request);
    await expect(
      healWorkspaceSession(
        async () => {
          throw new Error('restart boom');
        },
        async () => undefined,
        request,
        plan
      )
    ).rejects.toThrow('restart boom');
    expect(fake.data.workspacePath).toBe('/tmp/other');
  });

  test('restores a null workspace when the reinject fails', async () => {
    const fake = makeFakeSession(null);
    const request = selfHealRequest({ agentSession: fake.session });
    const plan = resolveSelfHealWorkspaceTarget(noTaskReload, () => '/tmp/worktree', request);
    await expect(
      healWorkspaceSession(
        async () => {
          throw new Error('restart boom');
        },
        async () => undefined,
        request,
        plan
      )
    ).rejects.toThrow('restart boom');
    expect(fake.data.workspacePath).toBeNull();
  });

  test('verifies the attachment even when the workspace already matches', async () => {
    const fake = makeFakeSession('/tmp/worktree');
    const request = selfHealRequest({ agentSession: fake.session });
    const plan = resolveSelfHealWorkspaceTarget(noTaskReload, () => '/tmp/worktree', request);
    const order: string[] = [];
    await healWorkspaceSession(
      async () => {
        order.push('reinject');
      },
      async () => {
        order.push('ensure');
      },
      request,
      plan
    );
    expect(order).toEqual(['ensure']);
    expect(fake.writes).toEqual([]);
  });
});

describe('runSelfHealWorkspaceFlow', () => {
  test('heals and verifies an attached session through the pipeline', async () => {
    const fake = makeFakeSession('/tmp/other');
    const order: string[] = [];
    const plan = await runSelfHealWorkspaceFlow(
      {
        getTask: () => makeTask(),
        getCachedTaskWorktreePath: () => '/tmp/worktree',
        reinjectNodeAgentMcpServer: async () => {
          order.push('reinject');
        },
        ensureRequiredMcpServersAttached: async () => {
          order.push('ensure');
        },
      },
      selfHealRequest({ agentSession: fake.session })
    );
    expect(plan.workspacePath).toBe('/tmp/worktree');
    expect(fake.data.workspacePath).toBe('/tmp/worktree');
    expect(order).toEqual(['reinject', 'ensure']);
  });
});

describe('resolveProvisioningOwner', () => {
  test('resolves the task, run and space for the session', async () => {
    const request: ProvisioningRequest = {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      session: makeFakeSession().session,
      options: {},
    };
    const owner = await resolveProvisioningOwner(
      () => makeTask(),
      () => makeRun(),
      async () => makeSpace(),
      request
    );
    expect(owner.task?.id).toBe(TASK_ID);
    expect(owner.workflowRun?.id).toBe(RUN_ID);
    expect(owner.space?.id).toBe(SPACE_ID);
  });

  test('skips the run and space lookups when the task is gone', async () => {
    let spaces = 0;
    const owner = await resolveProvisioningOwner(
      () => undefined,
      () => makeRun(),
      async () => {
        spaces += 1;
        return makeSpace();
      },
      { taskId: TASK_ID, sessionId: SESSION_ID, session: makeFakeSession().session, options: {} }
    );
    expect(owner.task).toBeNull();
    expect(owner.workflowRun).toBeNull();
    expect(spaces).toBe(0);
  });
});
