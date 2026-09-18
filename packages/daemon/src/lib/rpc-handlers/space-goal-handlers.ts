import type {
  CallContext,
  MessageHub,
  SpaceGoal,
  SpaceGoalEvent,
  SpaceGoalOwnerResolution,
  SpaceGoalStatus,
  SpaceTask,
} from '@hyperneo/shared';
import type { SpaceAgentGoalScopeRepository } from '../../storage/repositories/space-agent-goal-scope-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { decideGoalOwnershipMutationAdmission } from '../goals/ownership-gates.ts';
import type { SpaceGoalService } from '../goals/service.ts';
import { invokeOperationFromHandler } from '../operations/handler-invoker.ts';
import type { OperationRegistrySource } from '../operations/registry.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';

export interface SpaceGoalHandlerDeps {
  goalService: SpaceGoalService;
  spaceManager: SpaceManager;
  goalScopeRepo: Pick<
    SpaceAgentGoalScopeRepository,
    'getPrimaryGoalOwner' | 'deleteGoalAssignmentByRelationship'
  >;
  operations: OperationRegistrySource;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
}

export function setupSpaceGoalHandlers(messageHub: MessageHub, deps: SpaceGoalHandlerDeps): void {
  const { goalService, spaceManager, goalScopeRepo, operations, internalEventBus } = deps;

  function publishOwnerChanged(sessionId: string, spaceId: string, goalId: string): void {
    internalEventBus
      ?.publish('spaceGoal.ownerChanged', { sessionId, spaceId, goalId })
      .catch(() => {});
  }

  function resolveOwner(goalId: string, spaceId: string): SpaceGoalOwnerResolution {
    return goalScopeRepo.getPrimaryGoalOwner(goalId, spaceId) as SpaceGoalOwnerResolution;
  }

  function assertOwnerMutationAuthorized(context: CallContext): void {
    const hasSession = (context.sessionId ?? '').startsWith('space:');
    const decision = decideGoalOwnershipMutationAdmission({ hasSpaceAuthority: false, hasSession });
    if (decision.action === 'deny') throw new Error(decision.message);
  }

  async function requireSpace(spaceId: string) {
    if (!spaceId) throw new Error('spaceId is required');
    const space = await spaceManager.getSpace(spaceId);
    if (!space) throw new Error(`Space not found: ${spaceId}`);
    return space;
  }

  function requireGoalId(goalId: string): void {
    if (!goalId) throw new Error('goalId is required');
  }

  async function mutateGoalOwner(
    operationName: 'agent.assignGoal' | 'agent.unassignGoal',
    input: { spaceId: string; goalId: string; agentId: string }
  ): Promise<void> {
    await invokeOperationFromHandler<{ accepted: true }>(operations, operationName, input);
  }

  function requireGoalInSpace(goalId: string, spaceId: string) {
    requireGoalId(goalId);
    const goal = goalService.getGoal(goalId);
    if (!goal || goal.spaceId !== spaceId) throw new Error(`Goal not found: ${goalId}`);
    return goal;
  }

  messageHub.onRequest('spaceGoal.create', async (data) => {
    const params = data as { spaceId: string };
    await requireSpace(params.spaceId);
    const result = await invokeOperationFromHandler<{ accepted: true; goal: SpaceGoal }>(
      operations,
      'goal.create',
      params
    );
    return { goal: result.goal };
  });

  messageHub.onRequest('spaceGoal.list', async (data) => {
    const params = data as {
      spaceId: string;
      status?: SpaceGoalStatus;
      includeArchived?: boolean;
      label?: string;
      search?: string;
    };
    await requireSpace(params.spaceId);
    return { goals: goalService.listGoals(params) };
  });

  messageHub.onRequest('spaceGoal.get', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{ accepted: true; goal: SpaceGoal }>(
      operations,
      'goal.get',
      params
    );
    return { goal: result.goal };
  });

  messageHub.onRequest('spaceGoal.update', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{ accepted: true; goal: SpaceGoal }>(
      operations,
      'goal.update',
      params
    );
    return { goal: result.goal };
  });

  messageHub.onRequest('spaceGoal.pause', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{ accepted: true; goal: SpaceGoal }>(
      operations,
      'goal.pause',
      params
    );
    return { goal: result.goal };
  });

  messageHub.onRequest('spaceGoal.resume', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{ accepted: true; goal: SpaceGoal }>(
      operations,
      'goal.resume',
      params
    );
    return { goal: result.goal };
  });

  messageHub.onRequest('spaceGoal.createImmediateTask', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{
      accepted: true;
      goal: SpaceGoal;
      task: SpaceTask | null;
      queued: boolean;
    }>(operations, 'goal.triggerTask', params);
    return { goal: result.goal, task: result.task, queued: result.queued };
  });

  messageHub.onRequest('spaceGoal.listEvents', async (data) => {
    const params = data as {
      spaceId: string;
      goalId: string;
      limit?: number;
      before?: number;
      beforeId?: string;
    };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{
      accepted: true;
      total: number;
      events: SpaceGoalEvent[];
    }>(operations, 'goal.events.list', params);
    return { events: result.events };
  });

  messageHub.onRequest('spaceGoal.getOwner', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalId(params.goalId);
    const result = await invokeOperationFromHandler<{
      accepted: true;
      owner: SpaceGoalOwnerResolution;
    }>(operations, 'goal.owner.get', params);
    return { owner: result.owner };
  });

  messageHub.onRequest('spaceGoal.assignOwner', async (data, context) => {
    const params = data as { spaceId: string; goalId: string; agentId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    assertOwnerMutationAuthorized(context);
    await mutateGoalOwner('agent.assignGoal', {
      spaceId: params.spaceId,
      goalId: params.goalId,
      agentId: params.agentId,
    });
    publishOwnerChanged(context.sessionId, params.spaceId, params.goalId);
    return { owner: resolveOwner(params.goalId, params.spaceId) };
  });

  messageHub.onRequest('spaceGoal.unassignOwner', async (data, context) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    assertOwnerMutationAuthorized(context);
    const resolution = resolveOwner(params.goalId, params.spaceId);
    if (resolution.action === 'resolved' || resolution.action === 'degraded') {
      if (resolution.action === 'degraded' && resolution.reason === 'missing') {
        goalScopeRepo.deleteGoalAssignmentByRelationship(
          resolution.owner.agentId,
          params.goalId,
          'owner'
        );
      } else {
        await mutateGoalOwner('agent.unassignGoal', {
          spaceId: params.spaceId,
          goalId: params.goalId,
          agentId: resolution.owner.agentId,
        });
      }
      publishOwnerChanged(context.sessionId, params.spaceId, params.goalId);
    }
    return { owner: resolveOwner(params.goalId, params.spaceId) };
  });
}
