import { describe, expect, it, mock } from 'bun:test';
import type {
  MessageHub,
  RequestHandler,
  SpaceGoalOwnerResolution,
  SpaceLongHorizonAgent,
} from '@hyperneo/shared';
import {
  createDaemonInternalEventBus,
  type DaemonInternalEventMap,
  type InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { subscribeGoalOwnerChangeOutcomeRedelivery } from '../../../../src/lib/goals/owner-change-outcome-redelivery.ts';
import type { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { setupSpaceGoalHandlers } from '../../../../src/lib/rpc-handlers/space-goal-handlers.ts';
import { createCreateGoalOperation } from '../../../../src/lib/goals/create-goal-operation.ts';
import { createGetGoalOperation } from '../../../../src/lib/goals/get-goal-operation.ts';
import { createGetGoalOwnerOperation } from '../../../../src/lib/goals/get-goal-owner-operation.ts';
import { createTriggerGoalTaskOperation } from '../../../../src/lib/goals/goal-state-operations.ts';
import { createListGoalEventsOperation } from '../../../../src/lib/goals/list-goal-events-operation.ts';
import { createUpdateGoalOperation } from '../../../../src/lib/goals/update-goal-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import {
  createAssignAgentToGoalOperation,
  createUnassignAgentFromGoalOperation,
} from '../../../../src/lib/agents/assign-agent-operation.ts';

const SPACE_ID = 'space-1';
const GOAL_ID = 'goal-1';

const GOAL = {
  id: GOAL_ID,
  spaceId: SPACE_ID,
  title: 'G',
  description: '',
  status: 'active' as const,
  type: 'one_shot' as const,
  priority: 'normal' as const,
  labels: [],
  metrics: {},
  summary: '',
  progress: 0,
  nextSteps: [],
  preferredWorkflowId: null,
  taskScheduleId: null,
  autoTriggerNext: false,
  pendingNextRun: false,
  activeTaskId: null,
  lastTaskId: null,
  lastCheckInAt: null,
  nextCheckInAt: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
  workspacePath: null,
  revision: 1,
};

const TRIGGERED_TASK = {
  id: 'task-1',
  title: 'Goal check-in',
  description: '',
  status: 'open' as const,
  priority: 'normal' as const,
  labels: [],
  dependsOn: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  updatedAt: 1,
};

function makeContext(sessionId = 'global') {
  return { messageId: 'm1', sessionId, method: 'spaceGoal.getOwner', timestamp: 't1' };
}

function createMockHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function makeRepoMock(initial: SpaceGoalOwnerResolution) {
  let current = initial;
  return {
    current: () => current,
    getPrimaryGoalOwner: mock((_goalId: string, _spaceId: string) => current),
    assignGoal: mock((agentId: string, _goalId: string) => {
      current = {
        action: 'resolved',
        owner: { agentId, relationship: 'owner', createdAt: 1 },
        conflicts: [],
      };
    }),
    deleteGoalAssignmentByRelationship: mock((_agentId: string, _goalId: string) => {
      current = { action: 'no_recipient' };
    }),
  };
}

function makeOperations(
  goalService: SpaceGoalService,
  goalScopeRepo: ReturnType<typeof makeRepoMock>,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>,
  getAgent: (agentId: string) => SpaceLongHorizonAgent | null = (agentId) =>
    ({ id: agentId, spaceId: SPACE_ID, status: 'active' }) as SpaceLongHorizonAgent
) {
  const writeDeps = {
    goalService,
    getSession: () => null,
    longHorizonAgentRepo: { getById: () => null } as never,
  };
  const assignmentDeps = {
    getSession: () => null,
    longHorizonAgentRepo: { getById: () => null } as never,
    getAgent,
    getGoalSpace: (goalId: string) => goalService.getGoal(goalId)?.spaceId ?? null,
    getForgeScopeSpace: () => null,
    assignGoal: (agentId: string, goalId: string) => goalScopeRepo.assignGoal(agentId, goalId),
    unassignGoal: (agentId: string, goalId: string) =>
      goalScopeRepo.deleteGoalAssignmentByRelationship(agentId, goalId, 'owner'),
    assignForgeScope: () => {},
    unassignForgeScope: () => {},
    publishGoalOwnerChanged: (spaceId: string, goalId: string, sessionId: string) => {
      internalEventBus
        ?.publish('spaceGoal.ownerChanged', { sessionId, spaceId, goalId })
        .catch(() => {});
    },
    audit: () => {},
  };
  return createOperationRegistry([
    createAssignAgentToGoalOperation(assignmentDeps),
    createUnassignAgentFromGoalOperation(assignmentDeps),
    createGetGoalOwnerOperation({
      goalService,
      goalScopeRepo: goalScopeRepo as never,
      getSession: () => null,
      longHorizonAgentRepo: { getById: () => null } as never,
    }),
    createGetGoalOperation({ goalService, getSession: () => null }),
    createListGoalEventsOperation({ goalService, getSession: () => null }),
    createCreateGoalOperation(writeDeps),
    createUpdateGoalOperation(writeDeps),
    createTriggerGoalTaskOperation(writeDeps),
  ]);
}

function makeHarness(
  repo: ReturnType<typeof makeRepoMock>,
  getAgent?: (agentId: string) => SpaceLongHorizonAgent | null
) {
  const { hub, handlers } = createMockHub();
  const goalService = {
    getGoal: mock(() => ({ id: GOAL_ID, spaceId: SPACE_ID })),
  } as unknown as SpaceGoalService;
  const spaceManager = {
    getSpace: mock(async () => ({ id: SPACE_ID, status: 'active' })),
  } as unknown as SpaceManager;
  setupSpaceGoalHandlers(hub, {
    goalService,
    spaceManager,
    goalScopeRepo: repo,
    operations: makeOperations(goalService, repo, undefined, getAgent),
  });
  return { handlers };
}

function makeEventBus() {
  return {
    publish: mock(async () => ({ delivered: 0, failures: [] })),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

describe('spaceGoal owner handlers', () => {
  it('returns the resolved owner with conflicts', async () => {
    const repo = makeRepoMock({
      action: 'resolved',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
      conflicts: [{ agentId: 'agent-2', relationship: 'owner', createdAt: 2 }],
    });
    const { handlers } = makeHarness(repo);
    const result = await handlers.get('spaceGoal.getOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(result).toEqual({
      owner: {
        action: 'resolved',
        owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
        conflicts: [{ agentId: 'agent-2', relationship: 'owner', createdAt: 2 }],
      },
    });
  });

  it('returns the degraded resolution with the owner state reason', async () => {
    const repo = makeRepoMock({
      action: 'degraded',
      reason: 'paused',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
      conflicts: [],
    });
    const { handlers } = makeHarness(repo);
    const result = await handlers.get('spaceGoal.getOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(result).toEqual({
      owner: {
        action: 'degraded',
        reason: 'paused',
        owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
        conflicts: [],
      },
    });
  });

  it('returns an unowned resolution when there is no recipient', async () => {
    const noneRepo = makeRepoMock({ action: 'no_recipient' });
    const noneHarness = makeHarness(noneRepo);
    const none = await noneHarness.handlers.get('spaceGoal.getOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(none).toEqual({ owner: { action: 'no_recipient' } });
  });

  it('assigns an owner from a human browser session and reports the fresh resolution', async () => {
    const repo = makeRepoMock({ action: 'no_recipient' });
    const { handlers } = makeHarness(repo);
    const result = await handlers.get('spaceGoal.assignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, agentId: 'agent-1' },
      makeContext('global')
    );
    expect(repo.assignGoal).toHaveBeenCalledWith('agent-1', GOAL_ID);
    expect(result).toEqual({
      owner: {
        action: 'resolved',
        owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
        conflicts: [],
      },
    });
  });

  it('denies owner mutation from an agent session', async () => {
    const repo = makeRepoMock({ action: 'no_recipient' });
    const { handlers } = makeHarness(repo);
    await expect(
      handlers.get('spaceGoal.assignOwner')!(
        { spaceId: SPACE_ID, goalId: GOAL_ID, agentId: 'agent-1' },
        makeContext('space:agent:space-1:agent-1')
      )
    ).rejects.toThrow(/a Space agent session or explicit human authorization/);
    expect(repo.assignGoal).not.toHaveBeenCalled();
  });

  it('denies owner mutation from a coordinator chat session', async () => {
    const repo = makeRepoMock({ action: 'no_recipient' });
    const { handlers } = makeHarness(repo);
    await expect(
      handlers.get('spaceGoal.unassignOwner')!(
        { spaceId: SPACE_ID, goalId: GOAL_ID },
        makeContext('space:chat:space-1')
      )
    ).rejects.toThrow(/a Space agent session or explicit human authorization/);
    expect(repo.deleteGoalAssignmentByRelationship).not.toHaveBeenCalled();
  });

  it('allows owner mutation from a plain human room session and unbound callers', async () => {
    const repo = makeRepoMock({ action: 'no_recipient' });
    const { handlers } = makeHarness(repo);
    const fromRoom = await handlers.get('spaceGoal.assignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, agentId: 'agent-1' },
      makeContext('b19d3aa0-64a7-4b20-9f3a-6f9c1a2b3c4d')
    );
    expect(fromRoom.owner.action).toBe('resolved');
    const unbound = await handlers.get('spaceGoal.assignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, agentId: 'agent-2' },
      makeContext('')
    );
    expect(unbound.owner.action).toBe('resolved');
    expect(repo.assignGoal).toHaveBeenCalledTimes(2);
  });

  it('publishes an ownerChanged event when ownership mutates', async () => {
    const eventBus = makeEventBus();
    const { hub, handlers } = createMockHub();
    const goalService = {
      getGoal: mock(() => ({ id: GOAL_ID, spaceId: SPACE_ID })),
    } as unknown as SpaceGoalService;
    const goalScopeRepo = makeRepoMock({ action: 'no_recipient' });
    setupSpaceGoalHandlers(hub, {
      goalService,
      spaceManager: {
        getSpace: mock(async () => ({ id: SPACE_ID })),
      } as unknown as SpaceManager,
      goalScopeRepo,
      operations: makeOperations(goalService, goalScopeRepo, eventBus),
      internalEventBus: eventBus,
    });
    await handlers.get('spaceGoal.assignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, agentId: 'agent-1' },
      makeContext('global')
    );
    expect(eventBus.publish).toHaveBeenCalledWith('spaceGoal.ownerChanged', {
      sessionId: 'global',
      spaceId: SPACE_ID,
      goalId: GOAL_ID,
    });
    (eventBus.publish as ReturnType<typeof mock>).mockClear();
    await handlers.get('spaceGoal.unassignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext('global')
    );
    expect(eventBus.publish).toHaveBeenCalledWith('spaceGoal.ownerChanged', {
      sessionId: 'global',
      spaceId: SPACE_ID,
      goalId: GOAL_ID,
    });
  });

  it('wakes the goal pending outcome notifications when an owner is assigned', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForGoal,
    });
    const { hub, handlers } = createMockHub();
    const assignGoalService = {
      getGoal: mock(() => ({ id: GOAL_ID, spaceId: SPACE_ID })),
    } as unknown as SpaceGoalService;
    const assignScopeRepo = makeRepoMock({ action: 'no_recipient' });
    setupSpaceGoalHandlers(hub, {
      goalService: assignGoalService,
      spaceManager: {
        getSpace: mock(async () => ({ id: SPACE_ID })),
      } as unknown as SpaceManager,
      goalScopeRepo: assignScopeRepo,
      operations: makeOperations(assignGoalService, assignScopeRepo, internalEventBus),
      internalEventBus,
    });

    await handlers.get('spaceGoal.assignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, agentId: 'agent-1' },
      makeContext('global')
    );

    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith(GOAL_ID);
  });

  it('unassigns the current owner and clears ownership', async () => {
    const repo = makeRepoMock({
      action: 'resolved',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
      conflicts: [],
    });
    const { handlers } = makeHarness(repo);
    const result = await handlers.get('spaceGoal.unassignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext('global')
    );
    expect(repo.deleteGoalAssignmentByRelationship).toHaveBeenCalledWith(
      'agent-1',
      GOAL_ID,
      'owner'
    );
    expect(result).toEqual({ owner: { action: 'no_recipient' } });
  });

  it('clears an owner row whose agent record no longer exists', async () => {
    const repo = makeRepoMock({
      action: 'degraded',
      reason: 'missing',
      owner: { agentId: 'agent-gone', relationship: 'owner', createdAt: 1 },
      conflicts: [],
    });
    const { handlers } = makeHarness(repo, () => null);
    const result = await handlers.get('spaceGoal.unassignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext('global')
    );
    expect(repo.deleteGoalAssignmentByRelationship).toHaveBeenCalledWith(
      'agent-gone',
      GOAL_ID,
      'owner'
    );
    expect(result).toEqual({ owner: { action: 'no_recipient' } });
  });

  it('unassigns a degraded owner whose agent record survives', async () => {
    const repo = makeRepoMock({
      action: 'degraded',
      reason: 'archived',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: 1 },
      conflicts: [],
    });
    const { handlers } = makeHarness(
      repo,
      (agentId) => ({ id: agentId, spaceId: SPACE_ID, status: 'archived' }) as SpaceLongHorizonAgent
    );
    const result = await handlers.get('spaceGoal.unassignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext('global')
    );
    expect(repo.deleteGoalAssignmentByRelationship).toHaveBeenCalledWith(
      'agent-1',
      GOAL_ID,
      'owner'
    );
    expect(result).toEqual({ owner: { action: 'no_recipient' } });
  });

  it('leaves ownership untouched when unassigning an unowned goal', async () => {
    const repo = makeRepoMock({ action: 'no_recipient' });
    const { handlers } = makeHarness(repo);
    const result = await handlers.get('spaceGoal.unassignOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext('global')
    );
    expect(repo.deleteGoalAssignmentByRelationship).not.toHaveBeenCalled();
    expect(result).toEqual({ owner: { action: 'no_recipient' } });
  });

  it('rejects owner reads for a goal outside the space', async () => {
    const { hub, handlers } = createMockHub();
    const goalService = {
      getGoal: mock(() => ({ id: GOAL_ID, spaceId: 'other-space' })),
    } as unknown as SpaceGoalService;
    const outsideScopeRepo = makeRepoMock({ action: 'no_recipient' });
    setupSpaceGoalHandlers(hub, {
      goalService,
      spaceManager: { getSpace: mock(async () => ({ id: SPACE_ID })) } as unknown as SpaceManager,
      goalScopeRepo: outsideScopeRepo,
      operations: makeOperations(goalService, outsideScopeRepo),
    });
    await expect(
      handlers.get('spaceGoal.getOwner')!({ spaceId: SPACE_ID, goalId: GOAL_ID }, makeContext())
    ).rejects.toThrow(/Goal not found/);
  });
});

describe('spaceGoal workspacePath resolution', () => {
  function makeGoalHarness(goalService: Record<string, unknown>) {
    const { hub, handlers } = createMockHub();
    const workspaceScopeRepo = makeRepoMock({ action: 'no_recipient' });
    setupSpaceGoalHandlers(hub, {
      goalService: goalService as unknown as SpaceGoalService,
      spaceManager: {
        getSpace: mock(async () => ({ id: SPACE_ID, status: 'active' })),
      } as unknown as SpaceManager,
      goalScopeRepo: workspaceScopeRepo,
      operations: makeOperations(goalService as unknown as SpaceGoalService, workspaceScopeRepo),
    });
    return { handlers };
  }

  it('spaceGoal.create resolves workspacePath before creating', async () => {
    const created = { ...GOAL, id: 'goal-2', workspacePath: '/resolved/secondary' };
    const resolveGoalWorkspacePath = mock(async () => '/resolved/secondary');
    const createGoal = mock(() => created);
    const { handlers } = makeGoalHarness({
      getGoal: mock(() => null),
      resolveGoalWorkspacePath,
      createGoal,
    });
    const result = await handlers.get('spaceGoal.create')!(
      { spaceId: SPACE_ID, title: 'T', workspacePath: '/raw/secondary' },
      makeContext()
    );
    expect(resolveGoalWorkspacePath).toHaveBeenCalledWith(SPACE_ID, '/raw/secondary');
    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'T', workspacePath: '/resolved/secondary' }),
      { source: 'rpc', sourceSessionId: null }
    );
    expect(result).toEqual({ goal: created });
  });

  it('spaceGoal.create rejects when the workspace is not registered', async () => {
    const { handlers } = makeGoalHarness({
      getGoal: mock(() => null),
      resolveGoalWorkspacePath: mock(async () => {
        throw new Error('Workspace path is not registered to space: /nope');
      }),
      createGoal: mock(() => {
        throw new Error('createGoal must not run');
      }),
    });
    await expect(
      handlers.get('spaceGoal.create')!(
        { spaceId: SPACE_ID, title: 'T', workspacePath: '/nope' },
        makeContext()
      )
    ).rejects.toThrow('Workspace path is not registered to space: /nope');
  });

  it('spaceGoal.update resolves workspacePath into the update params', async () => {
    const updated = { ...GOAL, workspacePath: '/resolved/secondary' };
    const resolveGoalWorkspacePath = mock(async () => '/resolved/secondary');
    const updateGoal = mock(() => updated);
    const { handlers } = makeGoalHarness({
      getGoal: mock(() => GOAL),
      resolveGoalWorkspacePath,
      updateGoal,
    });
    const result = await handlers.get('spaceGoal.update')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, workspacePath: '/raw/secondary' },
      makeContext()
    );
    expect(resolveGoalWorkspacePath).toHaveBeenCalledWith(SPACE_ID, '/raw/secondary');
    expect(updateGoal).toHaveBeenCalledWith(
      GOAL_ID,
      expect.objectContaining({ workspacePath: '/resolved/secondary' }),
      { source: 'rpc', sourceSessionId: null }
    );
    expect(result).toEqual({ goal: updated });
  });
});

describe('spaceGoal handler gates', () => {
  const GOAL_EVENT = {
    id: 'event-1',
    spaceId: SPACE_ID,
    goalId: GOAL_ID,
    eventType: 'created' as const,
    source: 'rpc' as const,
    sourceTaskId: null,
    sourceSessionId: null,
    previousState: null,
    newState: null,
    diff: null,
    note: null,
    createdAt: 1,
  };

  function makeGateHarness(
    overrides: {
      goalService?: Record<string, unknown>;
      getSpace?: (spaceId: string) => Promise<unknown>;
    } = {}
  ) {
    const { hub, handlers } = createMockHub();
    const goalService = {
      getGoal: mock(() => GOAL),
      resolveGoalWorkspacePath: mock(async (_spaceId: string, path?: string) => path),
      createGoal: mock(() => GOAL),
      updateGoal: mock(() => GOAL),
      createImmediateTask: mock(() => ({ goal: GOAL, task: TRIGGERED_TASK, queued: false })),
      listGoals: mock(() => [GOAL]),
      listGoalEvents: mock(() => [GOAL_EVENT]),
      ...overrides.goalService,
    };
    const getSpace = mock(overrides.getSpace ?? (async () => ({ id: SPACE_ID, status: 'active' })));
    const gateScopeRepo = makeRepoMock({ action: 'no_recipient' });
    setupSpaceGoalHandlers(hub, {
      goalService: goalService as unknown as SpaceGoalService,
      spaceManager: { getSpace } as unknown as SpaceManager,
      goalScopeRepo: gateScopeRepo,
      operations: makeOperations(goalService as unknown as SpaceGoalService, gateScopeRepo),
    });
    return { handlers, goalService, getSpace };
  }

  const goalScoped = [
    'spaceGoal.get',
    'spaceGoal.update',
    'spaceGoal.pause',
    'spaceGoal.resume',
    'spaceGoal.createImmediateTask',
    'spaceGoal.listEvents',
    'spaceGoal.getOwner',
  ];
  const spaceScoped = ['spaceGoal.create', 'spaceGoal.list', ...goalScoped];

  it.each(spaceScoped)('%s rejects a missing spaceId before touching the space', async (method) => {
    const { handlers, getSpace } = makeGateHarness();
    await expect(
      handlers.get(method)!({ spaceId: '', goalId: GOAL_ID }, makeContext())
    ).rejects.toThrow('spaceId is required');
    expect(getSpace).not.toHaveBeenCalled();
  });

  it.each(spaceScoped)('%s rejects an unknown space', async (method) => {
    const { handlers, goalService } = makeGateHarness({ getSpace: async () => null });
    await expect(
      handlers.get(method)!({ spaceId: SPACE_ID, goalId: GOAL_ID }, makeContext())
    ).rejects.toThrow(`Space not found: ${SPACE_ID}`);
    expect(goalService.getGoal).not.toHaveBeenCalled();
  });

  it.each(goalScoped)('%s rejects a missing goalId', async (method) => {
    const { handlers } = makeGateHarness();
    await expect(
      handlers.get(method)!({ spaceId: SPACE_ID, goalId: '' }, makeContext())
    ).rejects.toThrow('goalId is required');
  });

  it.each(goalScoped)('%s rejects an unknown goal', async (method) => {
    const { handlers } = makeGateHarness({ goalService: { getGoal: mock(() => null) } });
    await expect(
      handlers.get(method)!({ spaceId: SPACE_ID, goalId: GOAL_ID }, makeContext())
    ).rejects.toThrow(`Goal not found: ${GOAL_ID}`);
  });

  it.each(goalScoped)('%s rejects a goal owned by another space', async (method) => {
    const { handlers } = makeGateHarness({
      goalService: { getGoal: mock(() => ({ id: GOAL_ID, spaceId: 'other-space' })) },
    });
    await expect(
      handlers.get(method)!({ spaceId: SPACE_ID, goalId: GOAL_ID }, makeContext())
    ).rejects.toThrow(`Goal not found: ${GOAL_ID}`);
  });

  it('spaceGoal.create passes the resolved workspacePath and rpc source through', async () => {
    const { handlers, goalService } = makeGateHarness();
    const result = await handlers.get('spaceGoal.create')!(
      { spaceId: SPACE_ID, title: 'G', type: 'measurable' },
      makeContext()
    );
    expect(goalService.resolveGoalWorkspacePath).toHaveBeenCalledWith(SPACE_ID, undefined);
    expect(goalService.createGoal).toHaveBeenCalledWith(
      {
        spaceId: SPACE_ID,
        title: 'G',
        type: 'measurable',
        workspacePath: undefined,
        primaryOwnerAgentId: null,
      },
      { source: 'rpc', sourceSessionId: null }
    );
    expect(result).toEqual({ goal: GOAL });
  });

  it('spaceGoal.list forwards the whole filter payload and wraps the rows', async () => {
    const { handlers, goalService } = makeGateHarness();
    const params = {
      spaceId: SPACE_ID,
      status: 'active',
      includeArchived: true,
      label: 'infra',
      search: 'db',
    };
    const result = await handlers.get('spaceGoal.list')!(params, makeContext());
    expect(goalService.listGoals).toHaveBeenCalledWith(params);
    expect(result).toEqual({ goals: [GOAL] });
  });

  it('spaceGoal.get returns the goal the space gate resolved', async () => {
    const { handlers } = makeGateHarness();
    const result = await handlers.get('spaceGoal.get')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(result).toEqual({ goal: GOAL });
  });

  it('spaceGoal.update forwards only the supplied public fields and rejects unknown keys', async () => {
    const { handlers, goalService } = makeGateHarness();
    await expect(
      handlers.get('spaceGoal.update')!(
        { spaceId: SPACE_ID, goalId: GOAL_ID, title: 'New', archived: true },
        makeContext()
      )
    ).rejects.toThrow(/Unrecognized key/);
    expect(goalService.updateGoal).not.toHaveBeenCalled();
    await handlers.get('spaceGoal.update')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID, title: 'New', status: 'paused' },
      makeContext()
    );
    const [goalId, updates] = (goalService.updateGoal as ReturnType<typeof mock>).mock.calls[0];
    expect(goalId).toBe(GOAL_ID);
    expect(updates.title).toBe('New');
    expect(Object.keys(updates).sort()).toEqual(['status', 'title', 'workspacePath']);
  });

  it('spaceGoal.pause and spaceGoal.resume set the status through the update door', async () => {
    const { handlers, goalService } = makeGateHarness();
    const paused = await handlers.get('spaceGoal.pause')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(goalService.updateGoal).toHaveBeenCalledWith(
      GOAL_ID,
      expect.objectContaining({ status: 'paused' }),
      { source: 'rpc', sourceSessionId: null }
    );
    expect(paused).toEqual({ goal: GOAL });
    await handlers.get('spaceGoal.resume')!({ spaceId: SPACE_ID, goalId: GOAL_ID }, makeContext());
    expect(goalService.updateGoal).toHaveBeenCalledWith(
      GOAL_ID,
      expect.objectContaining({ status: 'active' }),
      { source: 'rpc', sourceSessionId: null }
    );
  });

  it('spaceGoal.createImmediateTask returns the service result unwrapped', async () => {
    const { handlers, goalService } = makeGateHarness();
    const result = await handlers.get('spaceGoal.createImmediateTask')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(goalService.createImmediateTask).toHaveBeenCalledWith(GOAL_ID, {
      source: 'rpc',
      sourceSessionId: null,
    });
    expect(result).toEqual({ goal: GOAL, task: TRIGGERED_TASK, queued: false });
  });

  it('spaceGoal.listEvents forwards the pagination payload and wraps the rows', async () => {
    const { handlers, goalService } = makeGateHarness();
    const params = {
      spaceId: SPACE_ID,
      goalId: GOAL_ID,
      limit: 10,
      before: 123,
      beforeId: 'event-9',
    };
    const result = await handlers.get('spaceGoal.listEvents')!(params, makeContext());
    expect(goalService.listGoalEvents).toHaveBeenCalledWith(GOAL_ID, {
      limit: 10,
      before: 123,
      beforeId: 'event-9',
    });
    expect(result).toEqual({ events: [GOAL_EVENT] });
  });

  it('spaceGoal.getOwner does not require an authorized owner-mutation caller', async () => {
    const { handlers } = makeGateHarness();
    const result = await handlers.get('spaceGoal.getOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext('space:agent:space-1:agent-1')
    );
    expect(result).toEqual({ owner: { action: 'no_recipient' } });
  });
});
