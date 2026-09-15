import type { SpaceGoal, UpdateSpaceGoalParams } from '@hyperneo/shared';
import type { ScheduleService } from '../space/schedule/schedule-service.ts';
import { pauseScheduleStrict } from './automation-schedule-sync.ts';
import { recordGoalEvent } from './event-recording.ts';
import type {
  PublicSpaceGoalUpdateParams,
  SpaceGoalMutationContext,
  SpaceGoalServiceDeps,
} from './service.ts';
import { buildTaskDescription, goalTaskLabels } from './task-template.ts';

export function pauseLinkedScheduleOrClear(deps: SpaceGoalServiceDeps, goal: SpaceGoal): void {
  if (!goal.taskScheduleId) return;
  const schedule = deps.scheduleService.getSchedule(goal.taskScheduleId);
  if (!schedule) {
    deps.goalRepo.setTaskScheduleId(goal.id, null);
    return;
  }
  if (schedule.status === 'active') {
    const paused = deps.scheduleService.pauseSchedule(schedule.id);
    if (paused.status !== 'paused') {
      throw new Error(`Could not pause linked schedule (current: ${paused.status})`);
    }
  }
}

export function resumeLinkedScheduleOrClear(
  deps: SpaceGoalServiceDeps,
  goal: SpaceGoal
): { nextRunAt: number | null } | null {
  if (!goal.taskScheduleId) return null;
  const schedule = deps.scheduleService.getSchedule(goal.taskScheduleId);
  if (!schedule) {
    deps.goalRepo.setTaskScheduleId(goal.id, null);
    return null;
  }
  if (schedule.status === 'paused') {
    const resumed = deps.scheduleService.resumeSchedule(schedule.id);
    if (resumed.status !== 'active') {
      throw new Error(`Could not resume linked schedule (current: ${resumed.status})`);
    }
    return resumed;
  }
  if (schedule.status === 'active') return schedule;
  throw new Error(`Linked schedule is not resumable (current: ${schedule.status})`);
}

export function synchronizeScheduleForStatus(
  deps: SpaceGoalServiceDeps,
  goal: SpaceGoal,
  status: SpaceGoal['status']
): void {
  if (!goal.taskScheduleId) return;
  if (status === 'paused' || status === 'completed' || status === 'archived') {
    pauseLinkedScheduleOrClear(deps, goal);
    return;
  }
  if (status === 'active' && (goal.status === 'paused' || goal.status === 'completed')) {
    const schedule = resumeLinkedScheduleOrClear(deps, goal);
    if (schedule) deps.goalRepo.update(goal.id, { nextCheckInAt: schedule.nextRunAt });
  }
}

export function syncLinkedScheduleIfNeeded(
  deps: SpaceGoalServiceDeps,
  goal: SpaceGoal,
  params: PublicSpaceGoalUpdateParams,
  targetStatus: SpaceGoal['status'],
  updateParams: UpdateSpaceGoalParams
): void {
  const hasTemplateChange =
    params.title !== undefined ||
    params.description !== undefined ||
    params.priority !== undefined ||
    params.labels !== undefined ||
    params.summary !== undefined ||
    params.nextSteps !== undefined ||
    params.preferredWorkflowId !== undefined;
  const hasCronField = params.checkInCronExpression !== undefined;
  const hasTimezoneField = params.checkInTimezone !== undefined;
  if (!hasTemplateChange && !hasCronField && !hasTimezoneField) return;

  const wantsRemove = hasCronField && !params.checkInCronExpression;
  const wantsSet = hasCronField && !!params.checkInCronExpression;

  if (wantsRemove) {
    if (goal.taskScheduleId) {
      const linked = deps.scheduleService.getSchedule(goal.taskScheduleId);
      if (linked) {
        const deleted = deps.scheduleService.deleteSchedule(goal.taskScheduleId);
        if (!deleted) {
          throw new Error(
            'Could not remove check-in schedule: it fired or was rescheduled concurrently. Retry the update.'
          );
        }
      }
      deps.goalRepo.setTaskScheduleId(goal.id, null);
    }
    updateParams.nextCheckInAt = null;
    return;
  }

  const definedParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined)
  ) as PublicSpaceGoalUpdateParams;
  const nextGoal: SpaceGoal = { ...goal, ...definedParams };

  if (!goal.taskScheduleId) {
    if (!wantsSet) return;
    const schedule = deps.scheduleService.createGoalSchedule({
      spaceId: goal.spaceId,
      title: `Goal check-in: ${nextGoal.title}`,
      description: buildTaskDescription(nextGoal),
      priority: nextGoal.priority,
      preferredWorkflowId: nextGoal.preferredWorkflowId,
      labels: goalTaskLabels(nextGoal),
      triggerType: 'cron',
      cronExpression: params.checkInCronExpression as string,
      timezone: params.checkInTimezone ?? 'UTC',
      createdByAgent: 'space-goal-service',
      goalId: goal.id,
    });
    deps.goalRepo.setTaskScheduleId(goal.id, schedule.id);
    if (targetStatus !== 'active') {
      deps.scheduleService.pauseSchedule(schedule.id);
      updateParams.nextCheckInAt = null;
    } else {
      updateParams.nextCheckInAt = schedule.nextRunAt;
    }
    return;
  }

  const schedule = deps.scheduleService.getSchedule(goal.taskScheduleId);
  if (!schedule) {
    deps.goalRepo.setTaskScheduleId(goal.id, null);
    if (!wantsSet) {
      updateParams.nextCheckInAt = null;
      return;
    }
    const created = deps.scheduleService.createGoalSchedule({
      spaceId: goal.spaceId,
      title: `Goal check-in: ${nextGoal.title}`,
      description: buildTaskDescription(nextGoal),
      priority: nextGoal.priority,
      preferredWorkflowId: nextGoal.preferredWorkflowId,
      labels: goalTaskLabels(nextGoal),
      triggerType: 'cron',
      cronExpression: params.checkInCronExpression as string,
      timezone: params.checkInTimezone ?? 'UTC',
      createdByAgent: 'space-goal-service',
      goalId: goal.id,
    });
    deps.goalRepo.setTaskScheduleId(goal.id, created.id);
    if (targetStatus !== 'active') {
      deps.scheduleService.pauseSchedule(created.id);
      updateParams.nextCheckInAt = null;
    } else {
      updateParams.nextCheckInAt = created.nextRunAt;
    }
    return;
  }

  const scheduleUpdate: Parameters<ScheduleService['updateSchedule']>[1] = {};
  if (hasTemplateChange) {
    scheduleUpdate.description = buildTaskDescription(nextGoal);
    if (params.title !== undefined) {
      scheduleUpdate.title = `Goal check-in: ${params.title}`;
    }
    if (params.priority !== undefined) scheduleUpdate.priority = params.priority;
    if ('preferredWorkflowId' in definedParams) {
      scheduleUpdate.preferredWorkflowId = definedParams.preferredWorkflowId;
    }
    if (params.labels !== undefined) scheduleUpdate.labels = goalTaskLabels(nextGoal);
  }
  if (wantsSet) scheduleUpdate.cronExpression = params.checkInCronExpression as string;
  if (hasTimezoneField) scheduleUpdate.timezone = params.checkInTimezone as string;

  const timingChanged = wantsSet || hasTimezoneField;
  const updated = deps.scheduleService.updateSchedule(schedule.id, scheduleUpdate);
  if (timingChanged) {
    const goalActive = targetStatus === 'active';
    const scheduleActive = updated.status === 'active';
    if (goalActive && scheduleActive) {
      updateParams.nextCheckInAt = updated.nextRunAt;
    } else {
      if (!goalActive && scheduleActive) {
        pauseScheduleStrict(deps.scheduleService, updated.id);
      }
      updateParams.nextCheckInAt = null;
    }
  }
}

export function updateScheduledCheckIn(
  deps: SpaceGoalServiceDeps,
  goalId: string,
  nextCheckInAt: number | null,
  context?: SpaceGoalMutationContext
): SpaceGoal | null {
  const previous = deps.goalRepo.getById(goalId);
  const updated = deps.goalRepo.update(goalId, { nextCheckInAt });
  if (previous && updated) {
    recordGoalEvent(deps, updated, 'schedule_updated', previous, updated, {
      source: 'scheduler',
      ...context,
    });
  }
  return updated;
}
