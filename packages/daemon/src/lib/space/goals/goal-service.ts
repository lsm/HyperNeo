import type {
  CreateSpaceGoalParams,
  SpaceGoal,
  SpaceGoalEvent,
  SpaceGoalEventDiff,
  SpaceGoalEventListParams,
  SpaceGoalEventSnapshot,
  SpaceGoalEventSource,
  SpaceGoalEventType,
  SpaceGoalListParams,
  SpaceTask,
  UpdateSpaceGoalParams,
} from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { SpaceRepository } from '../../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceGoalEventRepository } from '../../../storage/repositories/space-goal-event-repository';
import type { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository';
import type { ScheduleService } from '../schedule/schedule-service';
import type { GoalAutomationService } from './goal-automation-service';

export type PublicSpaceGoalUpdateParams = Pick<
  UpdateSpaceGoalParams,
  | 'title'
  | 'description'
  | 'status'
  | 'type'
  | 'priority'
  | 'labels'
  | 'metrics'
  | 'summary'
  | 'progress'
  | 'nextSteps'
  | 'preferredWorkflowId'
  | 'autoTriggerNext'
>;

export interface SpaceGoalMutationContext {
  source?: SpaceGoalEventSource;
  sourceTaskId?: string | null;
  sourceSessionId?: string | null;
  note?: string | null;
}

export interface SpaceGoalServiceDeps {
  goalRepo: SpaceGoalRepository;
  goalEventRepo?: SpaceGoalEventRepository;
  taskRepo: SpaceTaskRepository;
  spaceRepo: SpaceRepository;
  scheduleService: ScheduleService;
  db?: BunDatabase;
  eventHub?: {
    publish: (event: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  goalAutomationService?: Pick<GoalAutomationService, 'onTaskCompleted'>;
  onGoalResumed?: (goalId: string, spaceId: string) => void;
}

export class SpaceGoalService {
  constructor(private readonly deps: SpaceGoalServiceDeps) {}

  setGoalAutomationService(service: Pick<GoalAutomationService, 'onTaskCompleted'>): void {
    this.deps.goalAutomationService = service;
  }

  createGoal(params: CreateSpaceGoalParams, context?: SpaceGoalMutationContext): SpaceGoal {
    this.validateCreate(params);
    const space = this.deps.spaceRepo.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    if (space.status !== 'active') {
      throw new Error(`Cannot create goal in a non-active space (current: ${space.status})`);
    }

    const result = this.runAtomic(() => {
      const goal = this.deps.goalRepo.create(params);
      if (params.checkInCronExpression) {
        const schedule = this.deps.scheduleService.createGoalSchedule({
          spaceId: params.spaceId,
          title: `Goal check-in: ${params.title}`,
          description: this.buildTaskDescription(goal),
          priority: goal.priority,
          preferredWorkflowId: goal.preferredWorkflowId,
          labels: this.goalTaskLabels(goal),
          triggerType: 'cron',
          cronExpression: params.checkInCronExpression,
          timezone: params.checkInTimezone ?? 'UTC',
          createdByAgent: 'space-goal-service',
          goalId: goal.id,
        });
        this.deps.goalRepo.setTaskScheduleId(goal.id, schedule.id);
        this.deps.goalRepo.update(goal.id, { nextCheckInAt: schedule.nextRunAt });
      }

      const createdGoal = this.getGoal(goal.id) as SpaceGoal;
      const storedCreatedGoal = this.deps.goalRepo.getById(goal.id) as SpaceGoal;
      this.recordGoalEvent(createdGoal, 'created', null, storedCreatedGoal, context);
      if (!params.triggerImmediately) return { goal: createdGoal, task: null };
      const created = this.createImmediateTaskInternal(goal.id, undefined, {
        emitTaskCreated: false,
      });
      return { goal: created.goal, task: created.task };
    });
    if (result.task) this.emitTaskCreated(result.task);
    return result.goal;
  }

  listGoals(params: SpaceGoalListParams): SpaceGoal[] {
    if (!params.spaceId) throw new Error('spaceId is required');
    return this.deps.goalRepo.list(params);
  }

  getGoal(goalId: string): SpaceGoal | null {
    return this.deps.goalRepo.getById(goalId);
  }

  updateGoal(
    goalId: string,
    params: PublicSpaceGoalUpdateParams,
    context?: SpaceGoalMutationContext
  ): SpaceGoal {
    const existing = this.requireGoal(goalId);
    if (
      existing.status === 'archived' &&
      params.status !== undefined &&
      params.status !== 'archived'
    ) {
      throw new Error('Archived goals cannot be reactivated');
    }
    if (params.title !== undefined && !params.title.trim()) throw new Error('title is required');

    const updateParams: UpdateSpaceGoalParams = { ...params };
    if (
      updateParams.type === 'recurring' ||
      (existing.type === 'recurring' && updateParams.type === undefined)
    ) {
      delete updateParams.progress;
    }
    if (params.status !== undefined && params.status !== existing.status) {
      this.synchronizeScheduleForStatus(existing, params.status);
      if (params.status !== 'active') {
        updateParams.nextCheckInAt = null;
      } else {
        const refreshed = this.deps.goalRepo.getById(goalId) ?? existing;
        updateParams.nextCheckInAt = refreshed.nextCheckInAt;
      }
    }

    this.syncScheduleTemplateIfNeeded(existing, updateParams);

    const updated = this.deps.goalRepo.update(goalId, updateParams);
    if (!updated) throw new Error(`Goal not found: ${goalId}`);
    this.recordGoalEvent(
      updated,
      params.status !== undefined && params.status !== existing.status
        ? 'status_changed'
        : 'updated',
      existing,
      updated,
      context
    );
    if (params.status === 'active' && existing.status !== 'active') {
      this.deps.onGoalResumed?.(goalId, existing.spaceId);
    }
    return updated;
  }

  pauseGoal(goalId: string, context?: SpaceGoalMutationContext): SpaceGoal {
    const goal = this.requireGoal(goalId);
    if (goal.status !== 'active') throw new Error(`Goal is not active (current: ${goal.status})`);
    if (goal.taskScheduleId) this.pauseLinkedScheduleOrClear(goal);
    const updated = this.deps.goalRepo.update(goalId, { status: 'paused', nextCheckInAt: null });
    if (!updated) throw new Error(`Goal not found: ${goalId}`);
    this.recordGoalEvent(updated, 'status_changed', goal, updated, context);
    return updated;
  }

  resumeGoal(goalId: string, context?: SpaceGoalMutationContext): SpaceGoal {
    const goal = this.requireGoal(goalId);
    if (goal.status !== 'paused') throw new Error(`Goal is not paused (current: ${goal.status})`);
    let nextCheckInAt = goal.nextCheckInAt;
    if (goal.taskScheduleId) {
      const schedule = this.resumeLinkedScheduleOrClear(goal);
      nextCheckInAt = schedule?.nextRunAt ?? null;
    }
    const updated = this.deps.goalRepo.update(goalId, { status: 'active', nextCheckInAt });
    if (!updated) throw new Error(`Goal not found: ${goalId}`);
    this.recordGoalEvent(updated, 'status_changed', goal, updated, context);
    this.deps.onGoalResumed?.(goalId, goal.spaceId);
    return updated;
  }

  createImmediateTask(
    goalId: string,
    context?: SpaceGoalMutationContext
  ): {
    goal: SpaceGoal;
    task: SpaceTask | null;
    queued: boolean;
  } {
    return this.createImmediateTaskInternal(goalId, context);
  }

  private createImmediateTaskInternal(
    goalId: string,
    context?: SpaceGoalMutationContext,
    options: { emitTaskCreated?: boolean } = {}
  ): {
    goal: SpaceGoal;
    task: SpaceTask | null;
    queued: boolean;
  } {
    const goal = this.requireGoal(goalId);
    if (goal.status !== 'active') {
      throw new Error(`Cannot trigger goal in '${goal.status}' status`);
    }
    this.requireActiveSpaceForTaskCreation(goal);
    if (goal.activeTaskId) {
      const active = this.deps.taskRepo.getTask(goal.activeTaskId);
      if (active && isActiveTaskStatus(active.status)) {
        if (!goal.autoTriggerNext) {
          throw new Error('Goal already has an active task and autoTriggerNext is disabled');
        }
        const queuedGoal = this.deps.goalRepo.queueNextRun(goal.id) as SpaceGoal;
        this.recordGoalEvent(queuedGoal, 'task_queued', goal, queuedGoal, context);
        return {
          goal: queuedGoal,
          task: null,
          queued: true,
        };
      }
      this.deps.goalRepo.clearActiveTaskIfMatches(goal.id, goal.activeTaskId);
    }

    const task = this.deps.taskRepo.createTask({
      spaceId: goal.spaceId,
      title: `Goal task: ${goal.title}`,
      description: this.buildTaskDescription(goal),
      priority: goal.priority,
      labels: this.goalTaskLabels(goal),
      preferredWorkflowId: goal.preferredWorkflowId,
      goalId: goal.id,
    });
    if (!this.deps.goalRepo.claimActiveTask(goal.id, task.id)) {
      this.deps.taskRepo.deleteTask(task.id);
      if (!goal.autoTriggerNext) {
        throw new Error('Goal already has an active task and autoTriggerNext is disabled');
      }
      const queuedGoal = this.deps.goalRepo.queueNextRun(goal.id) as SpaceGoal;
      this.recordGoalEvent(queuedGoal, 'task_queued', goal, queuedGoal, context);
      return {
        goal: queuedGoal,
        task: null,
        queued: true,
      };
    }
    const updatedGoal = this.requireGoal(goal.id);
    this.recordGoalEvent(updatedGoal, 'task_triggered', goal, updatedGoal, {
      ...context,
      sourceTaskId: context?.sourceTaskId ?? task.id,
    });
    if (options.emitTaskCreated !== false) this.emitTaskCreated(task);
    return { goal: updatedGoal, task, queued: false };
  }

  handleTaskTerminal(taskId: string): { goal: SpaceGoal; nextTask: SpaceTask | null } | null {
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task?.goalId) return null;
    if (!isTerminalTaskStatus(task.status)) return null;
    const goal = this.deps.goalRepo.getById(task.goalId);
    if (!goal || goal.spaceId !== task.spaceId) return null;
    this.deps.goalRepo.clearActiveTaskIfMatches(goal.id, taskId);
    const fresh = this.requireGoal(goal.id);
    this.recordGoalEvent(fresh, 'task_terminal', goal, fresh, {
      source: 'system',
      sourceTaskId: taskId,
      note: `Task reached terminal status: ${task.status}`,
    });
    if (task.status === 'done') this.deps.goalAutomationService?.onTaskCompleted(taskId);
    if (!fresh.autoTriggerNext || !fresh.pendingNextRun || fresh.status !== 'active') {
      return { goal: fresh, nextTask: null };
    }
    const created = this.createImmediateTask(fresh.id, { source: 'system' });
    return { goal: created.goal, nextTask: created.task };
  }

  canClaimScheduledTask(task: Pick<SpaceTask, 'spaceId' | 'goalId'>): {
    goal: SpaceGoal | null;
    claimable: boolean;
  } {
    if (!task.goalId) return { goal: null, claimable: false };
    const goal = this.deps.goalRepo.getById(task.goalId);
    if (!goal || goal.spaceId !== task.spaceId || goal.status !== 'active') {
      return { goal: null, claimable: false };
    }
    if (!goal.activeTaskId) return { goal, claimable: true };
    const active = this.deps.taskRepo.getTask(goal.activeTaskId);
    return { goal, claimable: !active || !isActiveTaskStatus(active.status) };
  }

  claimScheduledTask(
    taskId: string,
    nextCheckInAt: number | null
  ): { goal: SpaceGoal | null; claimed: boolean } {
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task?.goalId) return { goal: null, claimed: false };
    const goal = this.deps.goalRepo.getById(task.goalId);
    if (!goal || goal.spaceId !== task.spaceId) return { goal: null, claimed: false };
    if (nextCheckInAt !== goal.nextCheckInAt) {
      this.deps.goalRepo.update(goal.id, { nextCheckInAt });
    }
    if (goal.activeTaskId) {
      const active = this.deps.taskRepo.getTask(goal.activeTaskId);
      if (!active || !isActiveTaskStatus(active.status)) {
        this.deps.goalRepo.clearActiveTaskIfMatches(goal.id, goal.activeTaskId);
      }
    }
    const claimed = this.deps.goalRepo.claimActiveTask(goal.id, taskId);
    const updated = this.deps.goalRepo.getById(goal.id);
    return { goal: updated, claimed };
  }

  updateScheduledCheckIn(
    goalId: string,
    nextCheckInAt: number | null,
    context?: SpaceGoalMutationContext
  ): SpaceGoal | null {
    const previous = this.deps.goalRepo.getById(goalId);
    const updated = this.deps.goalRepo.update(goalId, { nextCheckInAt });
    if (previous && updated) {
      this.recordGoalEvent(updated, 'schedule_updated', previous, updated, {
        source: 'scheduler',
        ...context,
      });
    }
    return updated;
  }

  listGoalEvents(goalId: string, params: SpaceGoalEventListParams = {}): SpaceGoalEvent[] {
    this.requireGoal(goalId);
    return this.deps.goalEventRepo?.listByGoal(goalId, params) ?? [];
  }

  private requireGoal(goalId: string): SpaceGoal {
    const goal = this.deps.goalRepo.getById(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    return goal;
  }

  private requireActiveSpaceForTaskCreation(goal: SpaceGoal): void {
    const space = this.deps.spaceRepo.getSpace(goal.spaceId);
    if (!space) throw new Error(`Space not found: ${goal.spaceId}`);
    if (space.status !== 'active' || space.paused || space.stopped) {
      throw new Error('Cannot create goal task in a non-active space');
    }
  }

  private runAtomic<T>(fn: () => T): T {
    if (!this.deps.db) return fn();
    return this.deps.db.transaction(fn)();
  }

  private pauseLinkedScheduleOrClear(goal: SpaceGoal): void {
    if (!goal.taskScheduleId) return;
    const schedule = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
    if (!schedule) {
      this.deps.goalRepo.setTaskScheduleId(goal.id, null);
      return;
    }
    if (schedule.status === 'active') {
      const paused = this.deps.scheduleService.pauseSchedule(schedule.id);
      if (paused.status !== 'paused') {
        throw new Error(`Could not pause linked schedule (current: ${paused.status})`);
      }
    }
  }

  private resumeLinkedScheduleOrClear(goal: SpaceGoal): { nextRunAt: number | null } | null {
    if (!goal.taskScheduleId) return null;
    const schedule = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
    if (!schedule) {
      this.deps.goalRepo.setTaskScheduleId(goal.id, null);
      return null;
    }
    if (schedule.status === 'paused') {
      const resumed = this.deps.scheduleService.resumeSchedule(schedule.id);
      if (resumed.status !== 'active') {
        throw new Error(`Could not resume linked schedule (current: ${resumed.status})`);
      }
      return resumed;
    }
    if (schedule.status === 'active') return schedule;
    throw new Error(`Linked schedule is not resumable (current: ${schedule.status})`);
  }

  private synchronizeScheduleForStatus(goal: SpaceGoal, status: SpaceGoal['status']): void {
    if (!goal.taskScheduleId) return;
    if (status === 'paused' || status === 'completed' || status === 'archived') {
      this.pauseLinkedScheduleOrClear(goal);
      return;
    }
    if (status === 'active' && (goal.status === 'paused' || goal.status === 'completed')) {
      const schedule = this.resumeLinkedScheduleOrClear(goal);
      if (schedule) this.deps.goalRepo.update(goal.id, { nextCheckInAt: schedule.nextRunAt });
    }
  }

  private syncScheduleTemplateIfNeeded(goal: SpaceGoal, params: PublicSpaceGoalUpdateParams): void {
    if (!goal.taskScheduleId) return;
    const hasTemplateChange =
      params.title !== undefined ||
      params.description !== undefined ||
      params.priority !== undefined ||
      params.labels !== undefined ||
      params.summary !== undefined ||
      params.nextSteps !== undefined ||
      params.preferredWorkflowId !== undefined;
    if (!hasTemplateChange) return;

    const schedule = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
    if (!schedule) {
      this.deps.goalRepo.setTaskScheduleId(goal.id, null);
      return;
    }

    const definedParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined)
    ) as PublicSpaceGoalUpdateParams;
    const nextGoal: SpaceGoal = { ...goal, ...definedParams };
    const scheduleUpdate: Parameters<ScheduleService['updateSchedule']>[1] = {
      description: this.buildTaskDescription(nextGoal),
    };
    if (params.title !== undefined) scheduleUpdate.title = `Goal check-in: ${params.title}`;
    if (params.priority !== undefined) scheduleUpdate.priority = params.priority;
    if ('preferredWorkflowId' in definedParams) {
      scheduleUpdate.preferredWorkflowId = definedParams.preferredWorkflowId;
    }
    if (params.labels !== undefined) scheduleUpdate.labels = this.goalTaskLabels(nextGoal);
    this.deps.scheduleService.updateSchedule(schedule.id, scheduleUpdate);
  }

  private recordGoalEvent(
    goal: SpaceGoal,
    eventType: SpaceGoalEventType,
    previous: SpaceGoal | null,
    current: SpaceGoal,
    context?: SpaceGoalMutationContext
  ): void {
    if (!this.deps.goalEventRepo) return;
    const previousState = previous ? snapshotGoal(previous) : null;
    const newState = snapshotGoal(current);
    const diff = previousState ? diffSnapshots(previousState, newState) : null;
    this.deps.goalEventRepo.create({
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

  private emitTaskCreated(task: SpaceTask): void {
    if (!this.deps.eventHub) return;
    this.deps.eventHub
      .publish('space.task.created', {
        sessionId: 'global',
        spaceId: task.spaceId,
        taskId: task.id,
        task,
      })
      .catch(() => {
        // Best-effort event; goal task creation must not fail because listeners fail.
      });
  }

  private validateCreate(params: CreateSpaceGoalParams): void {
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.title?.trim()) throw new Error('title is required');
  }

  private goalTaskLabels(goal: SpaceGoal): string[] {
    return Array.from(new Set(['goal', `goal:${goal.id}`, ...goal.labels]));
  }

  private buildTaskDescription(goal: SpaceGoal): string {
    const sections = [
      `Goal: ${goal.title}`,
      goal.description,
      goal.summary ? `Current summary:\n${goal.summary}` : '',
      goal.nextSteps.length > 0
        ? `Next steps:\n${goal.nextSteps.map((s) => `- ${s}`).join('\n')}`
        : '',
    ].filter(Boolean);
    return sections.join('\n\n');
  }
}

function snapshotGoal(goal: SpaceGoal): SpaceGoalEventSnapshot {
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

function isActiveTaskStatus(status: SpaceTask['status']): boolean {
  return (
    status === 'open' ||
    status === 'in_progress' ||
    status === 'review' ||
    status === 'approved' ||
    // A task paused on a rate/usage cap is still the goal's active run — it
    // auto-resumes when the cap lifts. Treating it as inactive would let the
    // goal clear activeTaskId and spawn/claim a second concurrent task.
    isRateOrUsageLimited(status)
  );
}

function isTerminalTaskStatus(status: SpaceTask['status']): boolean {
  return (
    status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
  );
}
