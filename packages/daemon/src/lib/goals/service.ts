import type {
  CreateSpaceGoalParams,
  SpaceGoal,
  SpaceGoalEvent,
  SpaceGoalEventListParams,
  SpaceGoalEventSource,
  SpaceGoalListParams,
  SpaceGoalOutcomeNotification,
  SpaceTask,
  SpaceTaskStatus,
  InternalUpdateSpaceTaskParams,
  UpdateSpaceGoalParams,
} from '@hyperneo/shared';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceGoalEventRepository } from '../../storage/repositories/space-goal-event-repository.ts';
import type { SpaceGoalOutcomeNotificationRepository } from '../../storage/repositories/space-goal-outcome-notification-repository.ts';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import type { SpaceAgentGoalScopeRepository } from '../../storage/repositories/space-agent-goal-scope-repository.ts';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository.ts';
import type { ScheduleService } from '../schedule/schedule-service.ts';
import type { GoalAutomationService } from './automation-service.ts';
import { updateScheduledCheckIn } from './check-in-schedule.ts';
import type { ClaimAdmissionDenyReason } from './claim-admission-gates.ts';
import { listGoalEvents } from './event-recording.ts';
import {
  createGoal,
  pauseGoal,
  resolveGoalWorkspacePath,
  resumeGoal,
  updateGoal,
} from './lifecycle.ts';
import {
  applyOutcomeGoalUpdate,
  claimOutcomeNotification,
  listClaimableOutcomeNotifications,
  supersedeOutcomeNotificationsForTask,
} from './outcome-notifications.ts';
import {
  canClaimScheduledTask,
  claimScheduledTask,
  createImmediateTask,
  handleTaskTerminal,
  retryQueuedRunsForSpace,
} from './task-pointers.ts';

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
  | 'workspacePath'
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
  goalScopeRepo?: Pick<SpaceAgentGoalScopeRepository, 'assignGoal' | 'getPrimaryGoalOwner'>;
  agentRepo?: Pick<SpaceAgentRepository, 'getById'>;
  outcomeNotificationRepo?: SpaceGoalOutcomeNotificationRepository;
  onOutcomeNotification?: (notification: SpaceGoalOutcomeNotification) => void;
  evolutionScopeService?: Pick<
    import('../evolution/scope-service.ts').EvolutionScopeService,
    'captureCompletedTaskEvidence'
  >;
  reactiveDb?: Pick<
    import('../../storage/reactive-database.ts').ReactiveDatabase,
    'beginTransaction' | 'commitTransaction' | 'abortTransaction'
  >;
  resolveWorkspacePath?: (spaceId: string, rawPath: string) => Promise<string>;
}

export class SpaceGoalService {
  constructor(private readonly deps: SpaceGoalServiceDeps) {}

  setGoalAutomationService(service: Pick<GoalAutomationService, 'onTaskCompleted'>): void {
    this.deps.goalAutomationService = service;
  }

  async resolveGoalWorkspacePath(
    spaceId: string,
    rawPath: string | null | undefined
  ): Promise<string | null | undefined> {
    return resolveGoalWorkspacePath(this.deps, spaceId, rawPath);
  }

  createGoal(params: CreateSpaceGoalParams, context?: SpaceGoalMutationContext): SpaceGoal {
    return createGoal(this.deps, params, context);
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
    return updateGoal(this.deps, goalId, params, context);
  }

  pauseGoal(goalId: string, context?: SpaceGoalMutationContext): SpaceGoal {
    return pauseGoal(this.deps, goalId, context);
  }

  resumeGoal(goalId: string, context?: SpaceGoalMutationContext): SpaceGoal {
    return resumeGoal(this.deps, goalId, context);
  }

  createImmediateTask(
    goalId: string,
    context?: SpaceGoalMutationContext
  ): {
    goal: SpaceGoal;
    task: SpaceTask | null;
    queued: boolean;
  } {
    return createImmediateTask(this.deps, goalId, context);
  }

  retryQueuedRunsForSpace(spaceId: string): number {
    return retryQueuedRunsForSpace(this.deps, spaceId);
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
    return handleTaskTerminal(this.deps, taskId, transition);
  }

  supersedeOutcomeNotificationsForTask(taskId: string): void {
    supersedeOutcomeNotificationsForTask(this.deps, taskId);
  }

  canClaimScheduledTask(task: Pick<SpaceTask, 'spaceId' | 'goalId'>): {
    goal: SpaceGoal | null;
    claimable: boolean;
  } {
    return canClaimScheduledTask(this.deps, task);
  }

  /** @public */
  claimOutcomeNotification(params: ClaimOutcomeNotificationParams): ClaimOutcomeNotificationResult {
    return claimOutcomeNotification(this.deps, params);
  }

  /** @public */
  listClaimableOutcomeNotifications(params: {
    spaceId: string;
    callerAgentId: string | null;
    humanAdmissionAllowed: boolean;
    limit?: number;
  }): SpaceGoalOutcomeNotification[] {
    return listClaimableOutcomeNotifications(this.deps, params);
  }

  /** @public */
  applyOutcomeGoalUpdate(params: ApplyOutcomeGoalUpdateParams): SpaceGoal {
    return applyOutcomeGoalUpdate(this.deps, params);
  }

  claimScheduledTask(
    taskId: string,
    nextCheckInAt: number | null
  ): { goal: SpaceGoal | null; claimed: boolean } {
    return claimScheduledTask(this.deps, taskId, nextCheckInAt);
  }

  updateScheduledCheckIn(
    goalId: string,
    nextCheckInAt: number | null,
    context?: SpaceGoalMutationContext
  ): SpaceGoal | null {
    return updateScheduledCheckIn(this.deps, goalId, nextCheckInAt, context);
  }

  listGoalEvents(goalId: string, params: SpaceGoalEventListParams = {}): SpaceGoalEvent[] {
    return listGoalEvents(this.deps, goalId, params);
  }
}
