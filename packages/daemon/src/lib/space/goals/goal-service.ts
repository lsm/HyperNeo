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
  SpaceGoalMetrics,
  SpaceGoalOutcomeNotification,
  SpaceTask,
  SpaceTaskStatus,
  InternalUpdateSpaceTaskParams,
  UpdateSpaceGoalParams,
} from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { SpaceGoalEventRepository } from '../../../storage/repositories/space-goal-event-repository.ts';
import type { SpaceGoalOutcomeNotificationRepository } from '../../../storage/repositories/space-goal-outcome-notification-repository.ts';
import type { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { ScheduleService } from '../schedule/schedule-service.ts';
import { Logger } from '../../logger.ts';
import type { GoalAutomationService } from './goal-automation-service.ts';
import { pauseScheduleStrict } from './goal-automation-schedule-sync.ts';
import { decideReportableTerminal } from './reportable-terminal-gates.ts';
import { decideClaimAdmission, type ClaimAdmissionDenyReason } from './claim-admission-gates.ts';

const log = new Logger('space-goal-service');

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

export interface ClaimOutcomeNotificationParams {
  notificationId: string;
  claimedGoalId: string;
  claimedTaskId: string;
  actorAgentId: string | null;
  humanAdmissionAllowed: boolean;
  mutatesGoalState: boolean;
  dispositionStatus: 'acknowledged' | 'rejected' | 'superseded';
  isResubmission: boolean;
  observedGoalRevision?: number | null;
  apply?: (goal: SpaceGoal) => SpaceGoal;
}

export type ClaimOutcomeNotificationResult =
  | { status: 'claimed'; notification: SpaceGoalOutcomeNotification; goal: SpaceGoal }
  | { status: 'already_applied'; notification: SpaceGoalOutcomeNotification; goal: SpaceGoal }
  | {
      status: 'denied';
      reason: ClaimAdmissionDenyReason;
      currentGoalRevision: number;
      goal: SpaceGoal;
    }
  | { status: 'not_found' };

export interface ApplyOutcomeGoalUpdateParams {
  goalId: string;
  summary?: string;
  nextSteps?: string[];
  progress?: number;
  metrics?: Record<string, string | number | boolean | null>;
  observations?: Array<{ key: string; value: number }>;
  sourceTaskId?: string;
  sourceSessionId?: string | null;
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
  longHorizonAgentRepo?: Pick<
    SpaceLongHorizonAgentRepository,
    'assignGoal' | 'getPrimaryGoalOwner' | 'getCoordinator' | 'getById'
  >;
  outcomeNotificationRepo?: SpaceGoalOutcomeNotificationRepository;
  onOutcomeNotification?: (notification: SpaceGoalOutcomeNotification) => void;
  evolutionScopeService?: Pick<
    import('../evolution-scope-service.ts').EvolutionScopeService,
    'captureCompletedTaskEvidence'
  >;
  reactiveDb?: Pick<
    import('../../../storage/reactive-database.ts').ReactiveDatabase,
    'beginTransaction' | 'commitTransaction' | 'abortTransaction'
  >;
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
      if (params.primaryOwnerAgentId && this.deps.longHorizonAgentRepo) {
        this.deps.longHorizonAgentRepo.assignGoal(params.primaryOwnerAgentId, goal.id);
      }
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
    const previousCadence = this.readGoalCadence(existing);

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

  retryQueuedRunsForSpace(spaceId: string): number {
    const goals = this.deps.goalRepo.list({ spaceId, status: 'active' });
    let created = 0;
    for (const goal of goals) {
      if (!goal.autoTriggerNext || !goal.pendingNextRun || goal.activeTaskId) continue;
      try {
        this.createImmediateTask(goal.id, { source: 'system' });
        created += 1;
      } catch (err) {
        log.warn(
          `Retry queued run threw for goal "${goal.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return created;
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

  handleTaskTerminal(
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
    const existing = this.deps.taskRepo.getTask(taskId);
    if (!existing?.goalId) return null;
    const goal = this.deps.goalRepo.getById(existing.goalId);
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
    const result = this.runAtomic(() => {
      const task =
        transition?.updates && Object.keys(transition.updates).length > 0
          ? (this.deps.taskRepo.updateTask(taskId, transition.updates) as SpaceTask)
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
        this.deps.outcomeNotificationRepo
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
      this.deps.goalRepo.clearActiveTaskIfMatches(goal.id, taskId);
      const fresh = this.requireGoal(goal.id);
      this.recordGoalEvent(fresh, 'task_terminal', goal, fresh, {
        source: 'system',
        sourceTaskId: taskId,
        note: `Task reached terminal status: ${task.status}`,
      });
      if (task.status === 'done') {
        try {
          this.deps.evolutionScopeService?.captureCompletedTaskEvidence({ taskId });
        } catch (err) {
          log.warn(
            `Forge evidence capture threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
        try {
          this.deps.goalAutomationService?.onTaskCompleted(taskId);
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
            this.createImmediateTaskInternal(
              fresh.id,
              { source: 'system' },
              { emitTaskCreated: false }
            );
          const created = this.deps.db
            ? this.deps.db.transaction(createInSavepoint)()
            : createInSavepoint();
          postBookkeeping = created.goal;
          nextTask = created.task;
        } catch (err) {
          log.warn(
            `Next goal task creation threw for "${taskId}" after terminal: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      const notification = this.recordOutcomeNotification(
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
      if (result.nextTask) this.emitTaskCreated(result.nextTask);
      if (result.notification) {
        try {
          this.deps.onOutcomeNotification?.(result.notification);
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

  supersedeOutcomeNotificationsForTask(taskId: string): void {
    this.deps.outcomeNotificationRepo?.supersedeForTask(taskId);
  }

  private recordOutcomeNotification(
    task: SpaceTask,
    goal: SpaceGoal,
    terminalGeneration: number,
    transition: { fromStatus?: SpaceTaskStatus | null }
  ): SpaceGoalOutcomeNotification | null {
    if (!this.deps.outcomeNotificationRepo) return null;
    const hasStartGeneration = task.startedAt !== null;
    const priorPending = this.deps.outcomeNotificationRepo
      .listPendingByGoal(goal.id)
      .filter((n) => n.taskId === task.id);
    const decision = decideReportableTerminal({
      fromStatus: transition.fromStatus ?? null,
      toStatus: task.status,
      hasStartGeneration,
      hasPriorTerminalGeneration: priorPending.length > 0,
    });
    if (decision.action === 'none') return null;
    if (decision.action === 'supersede_notify') {
      this.deps.outcomeNotificationRepo.supersedeForTaskOlderThan(task.id, terminalGeneration);
    }
    return this.deps.outcomeNotificationRepo.create({
      spaceId: goal.spaceId,
      goalId: goal.id,
      taskId: task.id,
      terminalGeneration,
      goalRevision: goal.revision,
      payload: {
        summary: (
          [task.reportedSummary, task.result].find(
            (s) => typeof s === 'string' && s.trim().length > 0
          ) ?? ''
        ).slice(0, 400),
        taskStatus: task.status,
        taskTitle: task.title.slice(0, 200),
        goalTitle: goal.title.slice(0, 200),
      },
    });
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

  /** @public */
  claimOutcomeNotification(params: ClaimOutcomeNotificationParams): ClaimOutcomeNotificationResult {
    return this.runAtomic(() => {
      const notification =
        this.deps.outcomeNotificationRepo?.getById(params.notificationId) ?? null;
      if (!notification) return { status: 'not_found' };
      const goal = this.deps.goalRepo.getById(notification.goalId);
      if (!goal) return { status: 'not_found' };
      const authorizedAgentIds = this.resolveClaimAuthorizedAgentIds(goal);
      const isAuthorized =
        params.actorAgentId === null
          ? params.humanAdmissionAllowed
          : authorizedAgentIds.includes(params.actorAgentId);
      if (notification.status === params.dispositionStatus) {
        if (!isAuthorized) {
          return {
            status: 'denied',
            reason: 'unauthorized',
            currentGoalRevision: goal.revision,
            goal,
          };
        }
        const identityBound =
          params.claimedGoalId === notification.goalId &&
          params.claimedTaskId === notification.taskId;
        if (!identityBound) {
          return {
            status: 'denied',
            reason: 'identity_mismatch',
            currentGoalRevision: goal.revision,
            goal,
          };
        }
        return { status: 'already_applied', notification, goal };
      }
      const decision = decideClaimAdmission({
        actorAgentId: params.actorAgentId,
        authorizedAgentIds,
        humanAdmissionAllowed: params.humanAdmissionAllowed,
        notificationStatus: notification.status,
        notificationGoalId: notification.goalId,
        notificationTaskId: notification.taskId,
        notificationGoalRevision: notification.goalRevision,
        claimedGoalId: params.claimedGoalId,
        claimedTaskId: params.claimedTaskId,
        mutatesGoalState: params.mutatesGoalState,
        isResubmission: params.isResubmission,
        observedGoalRevision: params.observedGoalRevision ?? null,
        currentGoalRevision: goal.revision,
      });
      if (decision.action === 'deny') {
        return {
          status: 'denied',
          reason: decision.reason,
          currentGoalRevision: goal.revision,
          goal,
        };
      }
      const appliedGoal = params.mutatesGoalState && params.apply ? params.apply(goal) : goal;
      const terminalized =
        this.deps.outcomeNotificationRepo?.updateStatus(
          notification.id,
          params.dispositionStatus
        ) ?? notification;
      return { status: 'claimed', notification: terminalized, goal: appliedGoal };
    });
  }

  /** @public */
  listClaimableOutcomeNotifications(params: {
    spaceId: string;
    callerAgentId: string | null;
    humanAdmissionAllowed: boolean;
    limit?: number;
  }): SpaceGoalOutcomeNotification[] {
    const notificationRepo = this.deps.outcomeNotificationRepo;
    if (!notificationRepo) return [];
    const goals = this.deps.goalRepo.list({ spaceId: params.spaceId, includeArchived: true });
    const claimable: SpaceGoalOutcomeNotification[] = [];
    for (const goal of goals) {
      const authorizedAgentIds = this.resolveClaimAuthorizedAgentIds(goal);
      const isAuthorized =
        params.callerAgentId === null
          ? params.humanAdmissionAllowed
          : authorizedAgentIds.includes(params.callerAgentId);
      if (!isAuthorized) continue;
      claimable.push(...notificationRepo.listPendingByGoal(goal.id));
    }
    return claimable.slice(0, params.limit ?? 100);
  }

  /** @public */
  applyOutcomeGoalUpdate(params: ApplyOutcomeGoalUpdateParams): SpaceGoal {
    const goal = this.requireGoal(params.goalId);
    const metrics = this.combineOutcomeMetrics(goal.metrics, params.metrics, params.observations);
    const updates: UpdateSpaceGoalParams = {};
    if (params.summary !== undefined) updates.summary = params.summary;
    if (params.nextSteps !== undefined) updates.nextSteps = params.nextSteps;
    if (params.progress !== undefined && goal.type === 'recurring') {
      throw new Error('Recurring goals do not accept progress updates through outcome review');
    }
    if (params.progress !== undefined) {
      updates.progress = params.progress;
    }
    if (metrics !== null) updates.metrics = metrics;
    this.syncLinkedScheduleIfNeeded(
      goal,
      { summary: params.summary, nextSteps: params.nextSteps },
      goal.status,
      updates
    );
    const updated = this.deps.goalRepo.update(goal.id, updates);
    if (!updated) return goal;
    this.recordGoalEvent(updated, 'updated', goal, updated, {
      source: 'space_agent_tool',
      sourceTaskId: params.sourceTaskId ?? null,
      sourceSessionId: params.sourceSessionId ?? null,
      note: 'Goal outcome reviewed',
    });
    return updated;
  }

  private combineOutcomeMetrics(
    current: SpaceGoalMetrics,
    replacement?: Record<string, string | number | boolean | null>,
    observations?: Array<{ key: string; value: number }>
  ): SpaceGoalMetrics | null {
    if (!replacement && !observations) return null;
    const merged: SpaceGoalMetrics = { ...current };
    if (replacement) {
      for (const [key, value] of Object.entries(replacement)) merged[key] = value;
    }
    if (observations) {
      for (const observation of observations) {
        const existing = merged[observation.key];
        if (existing === undefined || existing === null) {
          merged[observation.key] = observation.value;
        } else if (typeof existing === 'number') {
          merged[observation.key] = existing + observation.value;
        } else {
          throw new Error(
            `Cannot apply a numeric observation to non-numeric metric "${observation.key}"`
          );
        }
      }
    }
    return merged;
  }

  private resolveClaimAuthorizedAgentIds(goal: SpaceGoal): string[] {
    const repo = this.deps.longHorizonAgentRepo;
    if (!repo) return [];
    const resolution = repo.getPrimaryGoalOwner(goal.id, goal.spaceId);
    if (resolution.action === 'resolved') return [resolution.owner.agentId];
    const coordinator =
      resolution.action === 'coordinator_fallback'
        ? repo.getById(resolution.coordinatorAgentId)
        : repo.getCoordinator(goal.spaceId);
    return coordinator?.status === 'active' ? [coordinator.id] : [];
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
    const reactive = this.deps.reactiveDb;
    reactive?.beginTransaction();
    try {
      const result = this.deps.db.transaction(fn)();
      reactive?.commitTransaction();
      return result;
    } catch (err) {
      reactive?.abortTransaction();
      throw err;
    }
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

    if (wantsRemove) {
      if (goal.taskScheduleId) {
        const linked = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
        if (linked) {
          const deleted = this.deps.scheduleService.deleteSchedule(goal.taskScheduleId);
          if (!deleted) {
            throw new Error(
              'Could not remove check-in schedule: it fired or was rescheduled concurrently. Retry the update.'
            );
          }
        }
        this.deps.goalRepo.setTaskScheduleId(goal.id, null);
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
      if (targetStatus !== 'active') {
        this.deps.scheduleService.pauseSchedule(schedule.id);
        updateParams.nextCheckInAt = null;
      } else {
        updateParams.nextCheckInAt = schedule.nextRunAt;
      }
      return;
    }

    const schedule = this.deps.scheduleService.getSchedule(goal.taskScheduleId);
    if (!schedule) {
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
    if (timingChanged) {
      const goalActive = targetStatus === 'active';
      const scheduleActive = updated.status === 'active';
      if (goalActive && scheduleActive) {
        updateParams.nextCheckInAt = updated.nextRunAt;
      } else {
        if (!goalActive && scheduleActive) {
          pauseScheduleStrict(this.deps.scheduleService, updated.id);
        }
        updateParams.nextCheckInAt = null;
      }
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
      .catch(() => {});
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
    isRateOrUsageLimited(status)
  );
}

function isTerminalTaskStatus(status: SpaceTask['status']): boolean {
  return (
    status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
  );
}
