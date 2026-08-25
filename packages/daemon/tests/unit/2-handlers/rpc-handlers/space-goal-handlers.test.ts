import { describe, expect, it, mock } from 'bun:test';
import type { MessageHub, RequestHandler, SpaceGoalOwnerResolution } from '@hyperneo/shared';
import type { SpaceGoalService } from '../../../../src/lib/space/goals/goal-service.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { setupSpaceGoalHandlers } from '../../../../src/lib/rpc-handlers/space-goal-handlers.ts';

const SPACE_ID = 'space-1';
const GOAL_ID = 'goal-1';

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

function makeHarness(repo: ReturnType<typeof makeRepoMock>) {
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
    longHorizonAgentRepo: repo,
  });
  return { handlers };
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

  it('returns an unowned resolution for coordinator fallback and no recipient', async () => {
    const fallbackRepo = makeRepoMock({
      action: 'coordinator_fallback',
      coordinatorAgentId: 'coordinator-1',
    });
    const { handlers } = makeHarness(fallbackRepo);
    const fallback = await handlers.get('spaceGoal.getOwner')!(
      { spaceId: SPACE_ID, goalId: GOAL_ID },
      makeContext()
    );
    expect(fallback).toEqual({
      owner: { action: 'coordinator_fallback', coordinatorAgentId: 'coordinator-1' },
    });
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
    ).rejects.toThrow(/coordinator or explicit human authorization/);
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
    ).rejects.toThrow(/coordinator or explicit human authorization/);
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
    setupSpaceGoalHandlers(hub, {
      goalService,
      spaceManager: { getSpace: mock(async () => ({ id: SPACE_ID })) } as unknown as SpaceManager,
      longHorizonAgentRepo: makeRepoMock({ action: 'no_recipient' }),
    });
    await expect(
      handlers.get('spaceGoal.getOwner')!({ spaceId: SPACE_ID, goalId: GOAL_ID }, makeContext())
    ).rejects.toThrow(/Goal not found/);
  });
});
