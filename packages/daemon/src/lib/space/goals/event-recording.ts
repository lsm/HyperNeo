import type {
  SpaceGoal,
  SpaceGoalEvent,
  SpaceGoalEventDiff,
  SpaceGoalEventListParams,
  SpaceGoalEventSnapshot,
  SpaceGoalEventType,
} from '@hyperneo/shared';
import { requireGoal } from './persistence.ts';
import type { SpaceGoalMutationContext, SpaceGoalServiceDeps } from './service.ts';

export type GoalCadence = { checkInCronExpression: string | null; checkInTimezone: string | null };

export function readGoalCadence(deps: SpaceGoalServiceDeps, goal: SpaceGoal): GoalCadence {
  if (!goal.taskScheduleId) return { checkInCronExpression: null, checkInTimezone: null };
  const schedule = deps.scheduleService.getSchedule(goal.taskScheduleId);
  if (!schedule) return { checkInCronExpression: null, checkInTimezone: null };
  return {
    checkInCronExpression: schedule.cronExpression,
    checkInTimezone: schedule.timezone,
  };
}

export function recordGoalEvent(
  deps: SpaceGoalServiceDeps,
  goal: SpaceGoal,
  eventType: SpaceGoalEventType,
  previous: SpaceGoal | null,
  current: SpaceGoal,
  context?: SpaceGoalMutationContext,
  previousCadence?: GoalCadence | null
): void {
  if (!deps.goalEventRepo) return;
  const currentCadence = readGoalCadence(deps, current);
  const previousState = previous
    ? snapshotGoal(previous, previousCadence ?? readGoalCadence(deps, previous))
    : null;
  const newState = snapshotGoal(current, currentCadence);
  const diff = previousState ? diffSnapshots(previousState, newState) : null;
  deps.goalEventRepo.create({
    spaceId: goal.spaceId,
    goalId: goal.id,
    eventType,
    source: context?.source ?? 'system',
    sourceTaskId: context?.sourceTaskId ?? null,
    sourceSessionId: context?.sourceSessionId ?? null,
    previousState: previous
      ? presentSnapshot(previous, previousState as SpaceGoalEventSnapshot)
      : null,
    newState: presentSnapshot(current, newState),
    diff: presentDiff(previous, current, diff),
    note: context?.note ?? null,
  });
}

export function listGoalEvents(
  deps: SpaceGoalServiceDeps,
  goalId: string,
  params: SpaceGoalEventListParams = {}
): SpaceGoalEvent[] {
  requireGoal(deps, goalId);
  return deps.goalEventRepo?.listByGoal(goalId, params) ?? [];
}

function snapshotGoal(goal: SpaceGoal, cadence?: GoalCadence): SpaceGoalEventSnapshot {
  return {
    title: goal.title,
    description: goal.description,
    status: goal.status,
    type: goal.type,
    priority: goal.priority,
    labels: goal.labels,
    metrics: goal.metrics,
    summary: goal.summary,
    progress: goal.progress,
    nextSteps: goal.nextSteps,
    preferredWorkflowId: goal.preferredWorkflowId,
    taskScheduleId: goal.taskScheduleId,
    autoTriggerNext: goal.autoTriggerNext,
    pendingNextRun: goal.pendingNextRun,
    activeTaskId: goal.activeTaskId,
    lastTaskId: goal.lastTaskId,
    lastCheckInAt: goal.lastCheckInAt,
    nextCheckInAt: goal.nextCheckInAt,
    completedAt: goal.completedAt,
    workspacePath: goal.workspacePath,
    checkInCronExpression: cadence?.checkInCronExpression,
    checkInTimezone: cadence?.checkInTimezone,
  };
}

function presentSnapshot(
  goal: SpaceGoal,
  snapshot: SpaceGoalEventSnapshot
): SpaceGoalEventSnapshot {
  if (goal.type !== 'recurring') return snapshot;
  const { progress: _progress, ...presented } = snapshot;
  return presented;
}

function presentDiff(
  previous: SpaceGoal | null,
  current: SpaceGoal,
  diff: SpaceGoalEventDiff | null
): SpaceGoalEventDiff | null {
  if (!diff || current.type !== 'recurring' || previous?.type !== 'recurring') return diff;
  const { progress: _progress, ...presented } = diff;
  return presented;
}

function diffSnapshots(
  previous: SpaceGoalEventSnapshot,
  current: SpaceGoalEventSnapshot
): SpaceGoalEventDiff {
  const diff: SpaceGoalEventDiff = {};
  for (const key of Object.keys(current) as Array<keyof SpaceGoalEventSnapshot>) {
    const previousValue = previous[key];
    const currentValue = current[key];
    if (JSON.stringify(previousValue) !== JSON.stringify(currentValue)) {
      diff[key] = { previous: previousValue, current: currentValue };
    }
  }
  return diff;
}
