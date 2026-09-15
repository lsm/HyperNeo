import type {
  SpaceGoal,
  SpaceGoalOutcomeNotification,
  SpaceTask,
  SpaceTaskStatus,
  UpdateSpaceGoalParams,
} from '@hyperneo/shared';
import { syncLinkedScheduleIfNeeded } from './check-in-schedule.ts';
import { decideClaimAdmission } from './claim-admission-gates.ts';
import { recordGoalEvent } from './event-recording.ts';
import { combineOutcomeMetrics } from './metrics-rollup.ts';
import { requireGoal, runAtomic } from './persistence.ts';
import { decideReportableTerminal } from './reportable-terminal-gates.ts';
import type {
  ApplyOutcomeGoalUpdateParams,
  ClaimOutcomeNotificationParams,
  ClaimOutcomeNotificationResult,
  SpaceGoalServiceDeps,
} from './service.ts';

export function supersedeOutcomeNotificationsForTask(
  deps: SpaceGoalServiceDeps,
  taskId: string
): void {
  deps.outcomeNotificationRepo?.supersedeForTask(taskId);
}

export function recordOutcomeNotification(
  deps: SpaceGoalServiceDeps,
  task: SpaceTask,
  goal: SpaceGoal,
  terminalGeneration: number,
  transition: { fromStatus?: SpaceTaskStatus | null }
): SpaceGoalOutcomeNotification | null {
  if (!deps.outcomeNotificationRepo) return null;
  const hasStartGeneration = task.startedAt !== null;
  const priorPending = deps.outcomeNotificationRepo
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
    deps.outcomeNotificationRepo.supersedeForTaskOlderThan(task.id, terminalGeneration);
  }
  return deps.outcomeNotificationRepo.create({
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

export function claimOutcomeNotification(
  deps: SpaceGoalServiceDeps,
  params: ClaimOutcomeNotificationParams
): ClaimOutcomeNotificationResult {
  return runAtomic(deps, () => {
    const notification = deps.outcomeNotificationRepo?.getById(params.notificationId) ?? null;
    if (!notification) return { status: 'not_found' };
    const goal = deps.goalRepo.getById(notification.goalId);
    if (!goal) return { status: 'not_found' };
    const authorizedAgentIds = resolveClaimAuthorizedAgentIds(deps, goal);
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
      deps.outcomeNotificationRepo?.updateStatus(notification.id, params.dispositionStatus) ??
      notification;
    return { status: 'claimed', notification: terminalized, goal: appliedGoal };
  });
}

export function listClaimableOutcomeNotifications(
  deps: SpaceGoalServiceDeps,
  params: {
    spaceId: string;
    callerAgentId: string | null;
    humanAdmissionAllowed: boolean;
    limit?: number;
  }
): SpaceGoalOutcomeNotification[] {
  const notificationRepo = deps.outcomeNotificationRepo;
  if (!notificationRepo) return [];
  const goals = deps.goalRepo.list({ spaceId: params.spaceId, includeArchived: true });
  const claimable: SpaceGoalOutcomeNotification[] = [];
  for (const goal of goals) {
    const authorizedAgentIds = resolveClaimAuthorizedAgentIds(deps, goal);
    const isAuthorized =
      params.callerAgentId === null
        ? params.humanAdmissionAllowed
        : authorizedAgentIds.includes(params.callerAgentId);
    if (!isAuthorized) continue;
    claimable.push(...notificationRepo.listPendingByGoal(goal.id));
  }
  return claimable.slice(0, params.limit ?? 100);
}

export function applyOutcomeGoalUpdate(
  deps: SpaceGoalServiceDeps,
  params: ApplyOutcomeGoalUpdateParams
): SpaceGoal {
  const goal = requireGoal(deps, params.goalId);
  const metrics = combineOutcomeMetrics(goal.metrics, params.metrics, params.observations);
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
  syncLinkedScheduleIfNeeded(
    deps,
    goal,
    { summary: params.summary, nextSteps: params.nextSteps },
    goal.status,
    updates
  );
  const updated = deps.goalRepo.update(goal.id, updates);
  if (!updated) return goal;
  recordGoalEvent(deps, updated, 'updated', goal, updated, {
    source: 'space_agent_tool',
    sourceTaskId: params.sourceTaskId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    note: 'Goal outcome reviewed',
  });
  return updated;
}

function resolveClaimAuthorizedAgentIds(deps: SpaceGoalServiceDeps, goal: SpaceGoal): string[] {
  const goalScopeRepo = deps.goalScopeRepo;
  const agentRepo = deps.agentRepo;
  if (!goalScopeRepo || !agentRepo) return [];
  const resolution = goalScopeRepo.getPrimaryGoalOwner(goal.id, goal.spaceId);
  if (resolution.action !== 'resolved') return [];
  const owner = agentRepo.getById(resolution.owner.agentId);
  return owner?.status === 'active' ? [owner.id] : [];
}
