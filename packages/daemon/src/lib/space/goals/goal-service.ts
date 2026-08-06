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
import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
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
  | 'checkInCronExpression'
  | 'checkInTimezone'
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
    const targetStatus = params.status ?? existing.status;
    // Capture the cadence BEFORE any mutation so the audit diff can show
    // cron/timezone changes (the schedule row is mutated in place, so reading
    // it after would yield the new value for both sides of the diff).
    const previousCadence = this.readGoalCadence(existing);

    // Run every mutation — status-driven schedule sync, cadence/template sync,
    // the goal row update, and the event record — inside a single transaction.
    // A failure partway through (e.g. an invalid cron rejected by the cadence
    // sync AFTER the status sync already paused/dequeued the schedule) then
    // rolls back every mutation, so a failed request cannot leave the schedule
    // paused while the goal stays active (silently disabling future check-ins).
    const updated = this.runAtomic(() => {
      if (params.status !== undefined && params.status !== existing.status) {
        this.synchronizeScheduleForStatus(existing, params.status);
        if (params.status !== 'active') {
          updateParams.nextCheckInAt = null;
        } else {
          const refreshed = this.deps.goalRepo.getById(goalId) ?? existing;
          updateParams.nextCheckInAt = refreshed.nextCheckInAt;
        }
      }

      this.syncLinkedScheduleIfNeeded(existing, params, targetStatus, updateParams);

      const result = this.deps.goalRepo.update(goalId, updateParams);
      if (!result) throw new Error(`Goal not found: ${goalId}`);
      this.recordGoalEvent(
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

  /**
   * Keep the goal's linked check-in schedule in sync with goal edits.
   *
   * Handles three concerns in a single pass so the schedule row, its pending
   * fire job, and the goal's `nextCheckInAt`/`taskScheduleId` never drift:
   *
   *  1. Template propagation — title/description/priority/labels/summary/
   *     nextSteps/preferredWorkflowId edits flow into the schedule template
   *     (the spawned check-in tasks inherit these fields).
   *  2. Cadence edits — `checkInCronExpression`/`checkInTimezone` update the
   *     linked schedule's trigger in place. ScheduleService cancels the stale
   *     pending job and enqueues a fresh one atomically when the goal is
   *     active; a paused goal's config is validated now and takes effect at
   *     resume.
   *  3. Add/remove — a cron value on a goal with no schedule creates one; a
   *     null/empty cron removes the linked schedule.
   *
   * Schedule edits are identity-preserving and side-effect-free with respect
   * to runs: they never create or detach tasks and never consume or clear
   * `pendingNextRun` (only the schedule's own pending fire job moves). When a
   * timing change occurs and the goal is active, `nextCheckInAt` is recomputed
   * consistently from the rescheduled job.
   *
   * A no-op when the update touches neither template nor schedule fields, so
   * unrelated edits (e.g. `autoTriggerNext`) leave a dangling schedule ref
   * untouched (mirroring pre-existing behavior).
   */
  private syncLinkedScheduleIfNeeded(
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

    // ── Remove the linked schedule ──────────────────────────────────────────
    if (wantsRemove) {
      if (goal.taskScheduleId) {
        const linked = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
        if (linked) {
          // deleteSchedule returns false only when its pending-job CAS lost to
          // a concurrent fire/reschedule — the schedule is still alive with a
          // freshly queued job. Clearing the link anyway would orphan that
          // active schedule, which could keep creating/claiming tasks for the
          // goal. Fail so the caller can retry.
          const deleted = this.deps.scheduleService.deleteSchedule(goal.taskScheduleId);
          if (!deleted) {
            throw new Error(
              'Could not remove check-in schedule: it fired or was rescheduled concurrently. Retry the update.'
            );
          }
        }
        // If the linked schedule was already gone (e.g. deleted from the
        // Scheduled tab, which doesn't clear goal.taskScheduleId), the
        // requested end state is already satisfied — clear the stale link.
        this.deps.goalRepo.setTaskScheduleId(goal.id, null);
      }
      updateParams.nextCheckInAt = null;
      return;
    }

    const definedParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined)
    ) as PublicSpaceGoalUpdateParams;
    const nextGoal: SpaceGoal = { ...goal, ...definedParams };

    // ── Add a schedule to a goal that has none ──────────────────────────────
    if (!goal.taskScheduleId) {
      if (!wantsSet) return; // nothing to create without a cron expression
      const schedule = this.deps.scheduleService.createGoalSchedule({
        spaceId: goal.spaceId,
        title: `Goal check-in: ${nextGoal.title}`,
        description: this.buildTaskDescription(nextGoal),
        priority: nextGoal.priority,
        preferredWorkflowId: nextGoal.preferredWorkflowId,
        labels: this.goalTaskLabels(nextGoal),
        triggerType: 'cron',
        cronExpression: params.checkInCronExpression as string,
        timezone: params.checkInTimezone ?? 'UTC',
        createdByAgent: 'space-goal-service',
        goalId: goal.id,
      });
      this.deps.goalRepo.setTaskScheduleId(goal.id, schedule.id);
      // A freshly-created schedule is `active`; if the goal itself is not
      // active, pause the schedule so it cannot fire until the goal is. This
      // preserves the invariant that a non-active goal has no firing schedule.
      if (targetStatus !== 'active') {
        this.deps.scheduleService.pauseSchedule(schedule.id);
        updateParams.nextCheckInAt = null;
      } else {
        updateParams.nextCheckInAt = schedule.nextRunAt;
      }
      return;
    }

    // ── Update an existing linked schedule (template and/or cadence) ────────
    const schedule = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
    if (!schedule) {
      // The linked schedule vanished (drift — e.g. it was deleted from the
      // Scheduled tab, which does not clear goal.taskScheduleId). If the
      // caller supplied a new cron, create the replacement now so the
      // create-if-none contract holds; otherwise just clear the stale ref.
      this.deps.goalRepo.setTaskScheduleId(goal.id, null);
      if (!wantsSet) {
        updateParams.nextCheckInAt = null;
        return;
      }
      const created = this.deps.scheduleService.createGoalSchedule({
        spaceId: goal.spaceId,
        title: `Goal check-in: ${nextGoal.title}`,
        description: this.buildTaskDescription(nextGoal),
        priority: nextGoal.priority,
        preferredWorkflowId: nextGoal.preferredWorkflowId,
        labels: this.goalTaskLabels(nextGoal),
        triggerType: 'cron',
        cronExpression: params.checkInCronExpression as string,
        timezone: params.checkInTimezone ?? 'UTC',
        createdByAgent: 'space-goal-service',
        goalId: goal.id,
      });
      this.deps.goalRepo.setTaskScheduleId(goal.id, created.id);
      if (targetStatus !== 'active') {
        this.deps.scheduleService.pauseSchedule(created.id);
        updateParams.nextCheckInAt = null;
      } else {
        updateParams.nextCheckInAt = created.nextRunAt;
      }
      return;
    }

    const scheduleUpdate: Parameters<ScheduleService['updateSchedule']>[1] = {};
    if (hasTemplateChange) {
      scheduleUpdate.description = this.buildTaskDescription(nextGoal);
      if (params.title !== undefined) {
        scheduleUpdate.title = `Goal check-in: ${params.title}`;
      }
      if (params.priority !== undefined) scheduleUpdate.priority = params.priority;
      if ('preferredWorkflowId' in definedParams) {
        scheduleUpdate.preferredWorkflowId = definedParams.preferredWorkflowId;
      }
      if (params.labels !== undefined) scheduleUpdate.labels = this.goalTaskLabels(nextGoal);
    }
    if (wantsSet) scheduleUpdate.cronExpression = params.checkInCronExpression as string;
    if (hasTimezoneField) scheduleUpdate.timezone = params.checkInTimezone as string;

    const timingChanged = wantsSet || hasTimezoneField;
    const updated = this.deps.scheduleService.updateSchedule(schedule.id, scheduleUpdate);
    // For an active goal, mirror the rescheduled next run; for a non-active
    // goal the schedule's nextRunAt is intentionally stale (recomputed at
    // resume), so leave nextCheckInAt at null.
    if (timingChanged && targetStatus === 'active') {
      updateParams.nextCheckInAt = updated.nextRunAt;
    }
  }

  private recordGoalEvent(
    goal: SpaceGoal,
    eventType: SpaceGoalEventType,
    previous: SpaceGoal | null,
    current: SpaceGoal,
    context?: SpaceGoalMutationContext,
    previousCadence?: GoalCadence | null
  ): void {
    if (!this.deps.goalEventRepo) return;
    const currentCadence = this.readGoalCadence(current);
    const previousState = previous
      ? snapshotGoal(previous, previousCadence ?? this.readGoalCadence(previous))
      : null;
    const newState = snapshotGoal(current, currentCadence);
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

  /**
   * Read the linked check-in schedule's cron + timezone for audit snapshots.
   * Returns nulls when the goal has no linked schedule (or the link has
   * drifted), so add/remove-schedule transitions are represented in the diff.
   */
  private readGoalCadence(goal: SpaceGoal): GoalCadence {
    if (!goal.taskScheduleId) return { checkInCronExpression: null, checkInTimezone: null };
    const schedule = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
    if (!schedule) return { checkInCronExpression: null, checkInTimezone: null };
    return {
      checkInCronExpression: schedule.cronExpression,
      checkInTimezone: schedule.timezone,
    };
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

type GoalCadence = { checkInCronExpression: string | null; checkInTimezone: string | null };

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
