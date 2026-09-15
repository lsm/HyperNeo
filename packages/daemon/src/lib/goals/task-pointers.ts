import type {
  InternalUpdateSpaceTaskParams,
  SpaceGoal,
  SpaceGoalOutcomeNotification,
  SpaceTask,
  SpaceTaskStatus,
} from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import { recordGoalEvent } from './event-recording.ts';
import { recordOutcomeNotification } from './outcome-notifications.ts';
import { requireActiveSpaceForTaskCreation, requireGoal, runAtomic } from './persistence.ts';
import type { SpaceGoalMutationContext, SpaceGoalServiceDeps } from './service.ts';
import { isActiveTaskStatus, isTerminalTaskStatus } from './task-status.ts';
import { buildTaskDescription, goalTaskLabels } from './task-template.ts';

const log = new Logger('space-goal-service');

export function emitTaskCreated(deps: SpaceGoalServiceDeps, task: SpaceTask): void {
  if (!deps.eventHub) return;
  deps.eventHub
    .publish('space.task.created', {
      sessionId: 'global',
      spaceId: task.spaceId,
      taskId: task.id,
      task,
    })
    .catch(() => {});
}

export function createImmediateTask(
  deps: SpaceGoalServiceDeps,
  goalId: string,
  context?: SpaceGoalMutationContext
): {
  goal: SpaceGoal;
  task: SpaceTask | null;
  queued: boolean;
} {
  return createImmediateTaskInternal(deps, goalId, context);
}

export function retryQueuedRunsForSpace(deps: SpaceGoalServiceDeps, spaceId: string): number {
  const goals = deps.goalRepo.list({ spaceId, status: 'active' });
  let created = 0;
  for (const goal of goals) {
    if (!goal.autoTriggerNext || !goal.pendingNextRun || goal.activeTaskId) continue;
    try {
      createImmediateTask(deps, goal.id, { source: 'system' });
      created += 1;
    } catch (err) {
      log.warn(
        `Retry queued run threw for goal "${goal.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return created;
}

export function createImmediateTaskInternal(
  deps: SpaceGoalServiceDeps,
  goalId: string,
  context?: SpaceGoalMutationContext,
  options: { emitTaskCreated?: boolean } = {}
): {
  goal: SpaceGoal;
  task: SpaceTask | null;
  queued: boolean;
} {
  const goal = requireGoal(deps, goalId);
  if (goal.status !== 'active') {
    throw new Error(`Cannot trigger goal in '${goal.status}' status`);
  }
  requireActiveSpaceForTaskCreation(deps, goal);
  if (goal.activeTaskId) {
    const active = deps.taskRepo.getTask(goal.activeTaskId);
    if (active && isActiveTaskStatus(active.status)) {
      if (!goal.autoTriggerNext) {
        throw new Error('Goal already has an active task and autoTriggerNext is disabled');
      }
      const queuedGoal = deps.goalRepo.queueNextRun(goal.id) as SpaceGoal;
      recordGoalEvent(deps, queuedGoal, 'task_queued', goal, queuedGoal, context);
      return {
        goal: queuedGoal,
        task: null,
        queued: true,
      };
    }
    deps.goalRepo.clearActiveTaskIfMatches(goal.id, goal.activeTaskId);
  }

  const task = deps.taskRepo.createTask({
    spaceId: goal.spaceId,
    title: `Goal task: ${goal.title}`,
    description: buildTaskDescription(goal),
    priority: goal.priority,
    labels: goalTaskLabels(goal),
    preferredWorkflowId: goal.preferredWorkflowId,
    goalId: goal.id,
    workspacePath: goal.workspacePath ?? null,
  });
  if (!deps.goalRepo.claimActiveTask(goal.id, task.id)) {
    deps.taskRepo.deleteTask(task.id);
    if (!goal.autoTriggerNext) {
      throw new Error('Goal already has an active task and autoTriggerNext is disabled');
    }
    const queuedGoal = deps.goalRepo.queueNextRun(goal.id) as SpaceGoal;
    recordGoalEvent(deps, queuedGoal, 'task_queued', goal, queuedGoal, context);
    return {
      goal: queuedGoal,
      task: null,
      queued: true,
    };
  }
  const updatedGoal = requireGoal(deps, goal.id);
  recordGoalEvent(deps, updatedGoal, 'task_triggered', goal, updatedGoal, {
    ...context,
    sourceTaskId: context?.sourceTaskId ?? task.id,
  });
  if (options.emitTaskCreated !== false) emitTaskCreated(deps, task);
  return { goal: updatedGoal, task, queued: false };
}

export function handleTaskTerminal(
  deps: SpaceGoalServiceDeps,
  taskId: string,
  transition?: {
    fromStatus?: SpaceTaskStatus | null;
    updates?: InternalUpdateSpaceTaskParams;
    deferPostCommitEffects?: boolean;
  }
): {
  goal: SpaceGoal;
  nextTask: SpaceTask | null;
  terminalGeneration: number;
  notification: SpaceGoalOutcomeNotification | null;
} | null {
  const existing = deps.taskRepo.getTask(taskId);
  if (!existing?.goalId) return null;
  const goal = deps.goalRepo.getById(existing.goalId);
  if (!goal || goal.spaceId !== existing.spaceId) return null;
  const nextStatus = transition?.updates?.status ?? existing.status;
  if (!isTerminalTaskStatus(nextStatus)) {
    return {
      goal,
      nextTask: null as SpaceTask | null,
      terminalGeneration: existing.terminalGeneration,
      notification: null as SpaceGoalOutcomeNotification | null,
    };
  }
  const result = runAtomic(deps, () => {
    const task =
      transition?.updates && Object.keys(transition.updates).length > 0
        ? (deps.taskRepo.updateTask(taskId, transition.updates) as SpaceTask)
        : existing;
    if (!isTerminalTaskStatus(task.status)) {
      return {
        goal,
        nextTask: null as SpaceTask | null,
        terminalGeneration: task.terminalGeneration,
        notification: null as SpaceGoalOutcomeNotification | null,
      };
    }
    const terminalGeneration = task.terminalGeneration;
    if (
      deps.outcomeNotificationRepo
        ?.listByTask(taskId)
        .some((n) => n.terminalGeneration === terminalGeneration)
    ) {
      return {
        goal,
        nextTask: null as SpaceTask | null,
        terminalGeneration,
        notification: null as SpaceGoalOutcomeNotification | null,
      };
    }
    deps.goalRepo.clearActiveTaskIfMatches(goal.id, taskId);
    const fresh = requireGoal(deps, goal.id);
    recordGoalEvent(deps, fresh, 'task_terminal', goal, fresh, {
      source: 'system',
      sourceTaskId: taskId,
      note: `Task reached terminal status: ${task.status}`,
    });
    if (task.status === 'done') {
      try {
        deps.evolutionScopeService?.captureCompletedTaskEvidence({ taskId });
      } catch (err) {
        log.warn(
          `Forge evidence capture threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        deps.goalAutomationService?.onTaskCompleted(taskId);
      } catch (err) {
        log.warn(
          `Goal automation onTaskCompleted threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    let nextTask: SpaceTask | null = null;
    let postBookkeeping: SpaceGoal = fresh;
    if (fresh.autoTriggerNext && fresh.pendingNextRun && fresh.status === 'active') {
      try {
        const createInSavepoint = () =>
          createImmediateTaskInternal(
            deps,
            fresh.id,
            { source: 'system' },
            {
              emitTaskCreated: false,
            }
          );
        const created = deps.db ? deps.db.transaction(createInSavepoint)() : createInSavepoint();
        postBookkeeping = created.goal;
        nextTask = created.task;
      } catch (err) {
        log.warn(
          `Next goal task creation threw for "${taskId}" after terminal: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const notification = recordOutcomeNotification(
      deps,
      task,
      postBookkeeping,
      terminalGeneration,
      {
        fromStatus: transition?.fromStatus ?? null,
      }
    );
    return { goal: postBookkeeping, nextTask, terminalGeneration, notification };
  });
  const deliverPostCommit = (): void => {
    if (result.nextTask) emitTaskCreated(deps, result.nextTask);
    if (result.notification) {
      try {
        deps.onOutcomeNotification?.(result.notification);
      } catch (err) {
        log.warn(
          `Outcome notification delivery threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
  if (transition?.deferPostCommitEffects) {
    setImmediate(deliverPostCommit);
  } else {
    deliverPostCommit();
  }
  return result;
}

export function canClaimScheduledTask(
  deps: SpaceGoalServiceDeps,
  task: Pick<SpaceTask, 'spaceId' | 'goalId'>
): {
  goal: SpaceGoal | null;
  claimable: boolean;
} {
  if (!task.goalId) return { goal: null, claimable: false };
  const goal = deps.goalRepo.getById(task.goalId);
  if (!goal || goal.spaceId !== task.spaceId || goal.status !== 'active') {
    return { goal: null, claimable: false };
  }
  if (!goal.activeTaskId) return { goal, claimable: true };
  const active = deps.taskRepo.getTask(goal.activeTaskId);
  return { goal, claimable: !active || !isActiveTaskStatus(active.status) };
}

export function claimScheduledTask(
  deps: SpaceGoalServiceDeps,
  taskId: string,
  nextCheckInAt: number | null
): { goal: SpaceGoal | null; claimed: boolean } {
  const task = deps.taskRepo.getTask(taskId);
  if (!task?.goalId) return { goal: null, claimed: false };
  const goal = deps.goalRepo.getById(task.goalId);
  if (!goal || goal.spaceId !== task.spaceId) return { goal: null, claimed: false };
  if (nextCheckInAt !== goal.nextCheckInAt) {
    deps.goalRepo.update(goal.id, { nextCheckInAt });
  }
  if (goal.activeTaskId) {
    const active = deps.taskRepo.getTask(goal.activeTaskId);
    if (!active || !isActiveTaskStatus(active.status)) {
      deps.goalRepo.clearActiveTaskIfMatches(goal.id, goal.activeTaskId);
    }
  }
  const claimed = deps.goalRepo.claimActiveTask(goal.id, taskId);
  const updated = deps.goalRepo.getById(goal.id);
  return { goal: updated, claimed };
}
