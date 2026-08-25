import type {
  CallContext,
  MessageHub,
  SpaceGoalOwnerResolution,
  SpaceGoalStatus,
} from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { decideGoalOwnershipMutationAdmission } from '../space/goals/goal-ownership-gates.ts';
import type { PublicSpaceGoalUpdateParams, SpaceGoalService } from '../space/goals/goal-service.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';

export interface SpaceGoalHandlerDeps {
  goalService: SpaceGoalService;
  spaceManager: SpaceManager;
  longHorizonAgentRepo: Pick<
    SpaceLongHorizonAgentRepository,
    'getPrimaryGoalOwner' | 'assignGoal' | 'deleteGoalAssignmentByRelationship'
  >;
}

export function setupSpaceGoalHandlers(messageHub: MessageHub, deps: SpaceGoalHandlerDeps): void {
  const { goalService, spaceManager, longHorizonAgentRepo } = deps;

  function resolveOwner(goalId: string, spaceId: string): SpaceGoalOwnerResolution {
    return longHorizonAgentRepo.getPrimaryGoalOwner(goalId, spaceId) as SpaceGoalOwnerResolution;
  }

  function assertOwnerMutationAuthorized(context: CallContext): void {
    const hasSession = context.sessionId !== 'global';
    const decision = decideGoalOwnershipMutationAdmission({ callerRole: undefined, hasSession });
    if (decision.action === 'deny') throw new Error(decision.message);
  }

  async function requireSpace(spaceId: string) {
    if (!spaceId) throw new Error('spaceId is required');
    const space = await spaceManager.getSpace(spaceId);
    if (!space) throw new Error(`Space not found: ${spaceId}`);
    return space;
  }

  function requireGoalInSpace(goalId: string, spaceId: string) {
    if (!goalId) throw new Error('goalId is required');
    const goal = goalService.getGoal(goalId);
    if (!goal || goal.spaceId !== spaceId) throw new Error(`Goal not found: ${goalId}`);
    return goal;
  }

  messageHub.onRequest('spaceGoal.create', async (data) => {
    const params = data as Parameters<SpaceGoalService['createGoal']>[0];
    await requireSpace(params.spaceId);
    return { goal: goalService.createGoal(params, { source: 'rpc' }) };
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
    return { goal: requireGoalInSpace(params.goalId, params.spaceId) };
  });

  messageHub.onRequest('spaceGoal.update', async (data) => {
    const params = data as { spaceId: string; goalId: string } & Parameters<
      SpaceGoalService['updateGoal']
    >[1];
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    const updates: PublicSpaceGoalUpdateParams = {
      title: params.title,
      description: params.description,
      status: params.status,
      type: params.type,
      priority: params.priority,
      labels: params.labels,
      metrics: params.metrics,
      summary: params.summary,
      progress: params.progress,
      nextSteps: params.nextSteps,
      preferredWorkflowId: params.preferredWorkflowId,
      autoTriggerNext: params.autoTriggerNext,
      checkInCronExpression: params.checkInCronExpression,
      checkInTimezone: params.checkInTimezone,
    };
    return { goal: goalService.updateGoal(params.goalId, updates, { source: 'rpc' }) };
  });

  messageHub.onRequest('spaceGoal.pause', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    return { goal: goalService.pauseGoal(params.goalId, { source: 'rpc' }) };
  });

  messageHub.onRequest('spaceGoal.resume', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    return { goal: goalService.resumeGoal(params.goalId, { source: 'rpc' }) };
  });

  messageHub.onRequest('spaceGoal.createImmediateTask', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    return goalService.createImmediateTask(params.goalId, { source: 'rpc' });
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
    requireGoalInSpace(params.goalId, params.spaceId);
    return { events: goalService.listGoalEvents(params.goalId, params) };
  });

  messageHub.onRequest('spaceGoal.getOwner', async (data) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    return { owner: resolveOwner(params.goalId, params.spaceId) };
  });

  messageHub.onRequest('spaceGoal.assignOwner', async (data, context) => {
    const params = data as { spaceId: string; goalId: string; agentId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    assertOwnerMutationAuthorized(context);
    longHorizonAgentRepo.assignGoal(params.agentId, params.goalId);
    return { owner: resolveOwner(params.goalId, params.spaceId) };
  });

  messageHub.onRequest('spaceGoal.unassignOwner', async (data, context) => {
    const params = data as { spaceId: string; goalId: string };
    await requireSpace(params.spaceId);
    requireGoalInSpace(params.goalId, params.spaceId);
    assertOwnerMutationAuthorized(context);
    const resolution = resolveOwner(params.goalId, params.spaceId);
    if (resolution.action === 'resolved' || resolution.action === 'degraded') {
      longHorizonAgentRepo.deleteGoalAssignmentByRelationship(
        resolution.owner.agentId,
        params.goalId,
        'owner'
      );
    }
    return { owner: resolveOwner(params.goalId, params.spaceId) };
  });
}
