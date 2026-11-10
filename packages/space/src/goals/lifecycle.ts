import type { CreateSpaceGoalParams, SpaceGoal, UpdateSpaceGoalParams } from '@hyperneo/shared';
import { synchronizeScheduleForStatus, syncLinkedScheduleIfNeeded } from './check-in-schedule.ts';
import { readGoalCadence, recordGoalEvent } from './event-recording.ts';
import { requireGoal, runAtomic } from './persistence.ts';
import type {
  PublicSpaceGoalUpdateParams,
  SpaceGoalMutationContext,
  SpaceGoalServiceDeps,
} from './service.ts';
import { createImmediateTaskInternal, emitTaskCreated } from './task-pointers.ts';
import { buildTaskDescription, goalTaskLabels } from './task-template.ts';

export async function resolveGoalWorkspacePath(
  deps: SpaceGoalServiceDeps,
  spaceId: string,
  rawPath: string | null | undefined
): Promise<string | null | undefined> {
  if (rawPath === undefined) return undefined;
  if (rawPath === null || rawPath.length === 0) return null;
  if (!deps.resolveWorkspacePath) {
    throw new Error('Workspace path validation is not available');
  }
  const resolved = await deps.resolveWorkspacePath(spaceId, rawPath);
  const space = deps.spaceRepo.getSpace(spaceId);
  if (space && resolved === space.workspacePath) return null;
  return resolved;
}

export function createGoal(
  deps: SpaceGoalServiceDeps,
  params: CreateSpaceGoalParams,
  context?: SpaceGoalMutationContext
): SpaceGoal {
  validateCreate(params);
  const space = deps.spaceRepo.getSpace(params.spaceId);
  if (!space) throw new Error(`Space not found: ${params.spaceId}`);
  if (space.status !== 'active') {
    throw new Error(`Cannot create goal in a non-active space (current: ${space.status})`);
  }

  const result = runAtomic(deps, () => {
    const goal = deps.goalRepo.create(params);
    if (params.primaryOwnerAgentId && deps.goalScopeRepo) {
      deps.goalScopeRepo.assignGoal(params.primaryOwnerAgentId, goal.id);
    }
    if (params.checkInCronExpression) {
      const schedule = deps.scheduleService.createGoalSchedule({
        spaceId: params.spaceId,
        title: `Goal check-in: ${params.title}`,
        description: buildTaskDescription(goal),
        priority: goal.priority,
        preferredWorkflowId: goal.preferredWorkflowId,
        labels: goalTaskLabels(goal),
        triggerType: 'cron',
        cronExpression: params.checkInCronExpression,
        timezone: params.checkInTimezone ?? 'UTC',
        createdByAgent: 'space-goal-service',
        goalId: goal.id,
      });
      deps.goalRepo.setTaskScheduleId(goal.id, schedule.id);
      deps.goalRepo.update(goal.id, { nextCheckInAt: schedule.nextRunAt });
    }

    const createdGoal = deps.goalRepo.getById(goal.id) as SpaceGoal;
    const storedCreatedGoal = deps.goalRepo.getById(goal.id) as SpaceGoal;
    recordGoalEvent(deps, createdGoal, 'created', null, storedCreatedGoal, context);
    if (!params.triggerImmediately) return { goal: createdGoal, task: null };
    const created = createImmediateTaskInternal(deps, goal.id, undefined, {
      emitTaskCreated: false,
    });
    return { goal: created.goal, task: created.task };
  });
  if (result.task) emitTaskCreated(deps, result.task);
  return result.goal;
}

export function updateGoal(
  deps: SpaceGoalServiceDeps,
  goalId: string,
  params: PublicSpaceGoalUpdateParams,
  context?: SpaceGoalMutationContext
): SpaceGoal {
  const existing = requireGoal(deps, goalId);
  if (
    existing.status === 'archived' &&
    params.status !== undefined &&
    params.status !== 'archived'
  ) {
    throw new Error('Archived goals cannot be reactivated');
  }
  if (params.title !== undefined && !params.title.trim()) throw new Error('title is required');
  if (
    params.checkInCronExpression !== undefined &&
    params.checkInCronExpression !== null &&
    typeof params.checkInCronExpression !== 'string'
  ) {
    throw new Error('checkInCronExpression must be a string or null');
  }
  if (params.checkInTimezone !== undefined && typeof params.checkInTimezone !== 'string') {
    throw new Error('checkInTimezone must be a string');
  }

  const updateParams: UpdateSpaceGoalParams = { ...params };
  if (
    updateParams.type === 'recurring' ||
    (existing.type === 'recurring' && updateParams.type === undefined)
  ) {
    delete updateParams.progress;
  }
  const targetStatus = params.status ?? existing.status;
  const previousCadence = readGoalCadence(deps, existing);

  const updated = runAtomic(deps, () => {
    if (params.status !== undefined && params.status !== existing.status) {
      synchronizeScheduleForStatus(deps, existing, params.status);
      if (params.status !== 'active') {
        updateParams.nextCheckInAt = null;
      } else {
        const refreshed = deps.goalRepo.getById(goalId) ?? existing;
        updateParams.nextCheckInAt = refreshed.nextCheckInAt;
      }
    }

    syncLinkedScheduleIfNeeded(deps, existing, params, targetStatus, updateParams);

    const result = deps.goalRepo.update(goalId, updateParams);
    if (!result) throw new Error(`Goal not found: ${goalId}`);
    recordGoalEvent(
      deps,
      result,
      params.status !== undefined && params.status !== existing.status
        ? 'status_changed'
        : 'updated',
      existing,
      result,
      context,
      previousCadence
    );
    return result;
  });

  if (params.status === 'active' && existing.status !== 'active') {
    deps.onGoalResumed?.(goalId, existing.spaceId);
  }
  return updated;
}

function validateCreate(params: CreateSpaceGoalParams): void {
  if (!params.spaceId) throw new Error('spaceId is required');
  if (!params.title?.trim()) throw new Error('title is required');
}
