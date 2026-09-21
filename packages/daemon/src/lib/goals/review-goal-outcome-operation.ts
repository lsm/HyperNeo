import type { SpaceGoal, SpaceGoalOutcomeNotification } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitGoalSpace,
  GOAL_OWNER_POLICY,
  GOAL_REJECTION_REASONS,
  goalDenial,
  GoalSpaceScopeShape,
  recordGoalAudit,
  type GoalCallerContext,
  type GoalRejection,
  type GoalRejectionReason,
} from './goal-operation-scope.ts';
import {
  GoalMetricsSchema,
  GoalOutcomeNotificationSchema,
  SpaceGoalSchema,
} from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const DISCOVERY_LIMIT = 100;
const HUMAN_ADMISSION_ALLOWED = false;

const listInputSchema = z.object({ ...GoalSpaceScopeShape }).strict();

const resolveInputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    notificationId: z.string().min(1).describe('Pending notification identity'),
    goalId: z.string().min(1).describe('Goal the outcome belongs to'),
    taskId: z.string().min(1).describe('Completed task the outcome belongs to'),
    disposition: z
      .enum(['acknowledge', 'reject', 'supersede'])
      .optional()
      .describe('Terminal disposition'),
    observedGoalRevision: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Goal revision observed by the caller; set when resubmitting after a stale denial'),
    summary: z.string().optional().describe('Replace the goal rolling summary'),
    nextSteps: z.array(z.string()).optional().describe('Replace the goal next steps'),
    metrics: GoalMetricsSchema.optional().describe('Replace the given goal metric values'),
    observations: z
      .array(z.object({ key: z.string(), value: z.number() }).strict())
      .optional()
      .describe('Accumulate metric observations as numeric deltas'),
    progress: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Set goal progress 0-100 (rejected for recurring goals)'),
  })
  .strict();

type ListInput = z.infer<typeof listInputSchema>;
type ResolveInput = z.infer<typeof resolveInputSchema>;

type Claim = {
  spaceId: string;
  notificationId: string;
  goalId: string;
  taskId: string;
  dispositionStatus: 'acknowledged' | 'rejected' | 'superseded';
  hasGoalUpdate: boolean;
};

export type ListOutcomeNotificationsResult =
  | { accepted: true; notifications: SpaceGoalOutcomeNotification[] }
  | GoalRejection;

export type ReviewGoalOutcomeResult =
  | {
      accepted: true;
      status: 'claimed' | 'already_applied';
      notification: SpaceGoalOutcomeNotification;
      goal: SpaceGoal;
    }
  | {
      accepted: false;
      reason: GoalRejectionReason;
      message: string;
      claimReason?: 'unauthorized' | 'superseded' | 'identity_mismatch' | 'stale_revision';
      currentGoalRevision?: number;
      goal?: SpaceGoal;
    };

export interface ReviewGoalOutcomeDependencies extends GoalCallerContext {
  readonly goalService: Pick<
    SpaceGoalService,
    | 'getGoal'
    | 'listClaimableOutcomeNotifications'
    | 'claimOutcomeNotification'
    | 'applyOutcomeGoalUpdate'
  >;
}

export function hasGoalStateUpdate(input: ResolveInput): boolean {
  return (
    input.summary !== undefined ||
    input.nextSteps !== undefined ||
    input.metrics !== undefined ||
    input.observations !== undefined ||
    input.progress !== undefined
  );
}

function rejected(rejection: GoalRejection): ReviewGoalOutcomeResult {
  return { ...rejection };
}

function invalid(message: string): { reason: ReviewGoalOutcomeResult } {
  return { reason: rejected(goalDenial('review_input_invalid', message).reason) };
}

export function admitOutcomeReviewer(
  input: { spaceId?: string },
  caller: OperationCaller,
  deps: ReviewGoalOutcomeDependencies
): { value: string } | { reason: ReviewGoalOutcomeResult } {
  const space = admitGoalSpace(caller, input.spaceId, 'owner', deps);
  return 'reason' in space ? { reason: rejected(space.reason) } : space;
}

export function listOutcomeNotifications(
  spaceId: string,
  caller: OperationCaller,
  deps: ReviewGoalOutcomeDependencies
): ListOutcomeNotificationsResult {
  return {
    accepted: true,
    notifications: deps.goalService.listClaimableOutcomeNotifications({
      spaceId,
      callerAgentId: caller.agentId ?? null,
      humanAdmissionAllowed: HUMAN_ADMISSION_ALLOWED,
      limit: DISCOVERY_LIMIT,
    }),
  };
}

export function routeOutcomeClaim(
  spaceId: string,
  input: ResolveInput,
  deps: ReviewGoalOutcomeDependencies
): { value: Claim } | { reason: ReviewGoalOutcomeResult } {
  const hasGoalUpdate = hasGoalStateUpdate(input);
  if (!input.disposition && !hasGoalUpdate) {
    return invalid(
      'disposition (acknowledge, reject, or supersede) or a goal-state update is required'
    );
  }
  if (input.disposition && input.disposition !== 'acknowledge' && hasGoalUpdate) {
    return invalid('goal-state updates require the acknowledge disposition');
  }
  const goal = deps.goalService.getGoal(input.goalId);
  if (!goal || goal.spaceId !== spaceId) {
    return {
      reason: rejected(goalDenial('goal_not_found', `Goal not found: ${input.goalId}`).reason),
    };
  }
  return {
    value: {
      spaceId,
      notificationId: input.notificationId,
      goalId: input.goalId,
      taskId: input.taskId,
      hasGoalUpdate,
      dispositionStatus: hasGoalUpdate
        ? 'acknowledged'
        : input.disposition === 'reject'
          ? 'rejected'
          : input.disposition === 'supersede'
            ? 'superseded'
            : 'acknowledged',
    },
  };
}

export function applyOutcomeClaim(
  claim: Claim,
  input: ResolveInput,
  caller: OperationCaller,
  deps: ReviewGoalOutcomeDependencies
): ReviewGoalOutcomeResult {
  const result = deps.goalService.claimOutcomeNotification({
    notificationId: claim.notificationId,
    claimedGoalId: claim.goalId,
    claimedTaskId: claim.taskId,
    actorAgentId: caller.agentId ?? null,
    humanAdmissionAllowed: HUMAN_ADMISSION_ALLOWED,
    mutatesGoalState: claim.hasGoalUpdate,
    dispositionStatus: claim.dispositionStatus,
    isResubmission: input.observedGoalRevision != null,
    observedGoalRevision: input.observedGoalRevision ?? null,
    apply: claim.hasGoalUpdate
      ? (goal) =>
          deps.goalService.applyOutcomeGoalUpdate({
            goalId: goal.id,
            summary: input.summary,
            nextSteps: input.nextSteps,
            metrics: input.metrics,
            observations: input.observations,
            progress: input.progress,
            sourceTaskId: claim.taskId,
            sourceSessionId: caller.sessionId ?? null,
          })
      : undefined,
  });
  if (result.status === 'claimed' || result.status === 'already_applied') {
    recordGoalAudit(
      deps,
      caller,
      claim.spaceId,
      'goal.outcome.resolve',
      {
        notificationId: claim.notificationId,
        goalId: claim.goalId,
        disposition: claim.dispositionStatus,
        hasGoalUpdate: claim.hasGoalUpdate,
        status: result.status,
      },
      claim.taskId
    );
    return {
      accepted: true,
      status: result.status,
      notification: result.notification,
      goal: result.goal,
    };
  }
  if (result.status === 'denied') {
    return {
      accepted: false,
      reason: 'review_denied',
      message: `Outcome claim denied: ${result.reason}`,
      claimReason: result.reason,
      currentGoalRevision: result.currentGoalRevision,
      goal: result.goal,
    };
  }
  return rejected(
    goalDenial('notification_not_found', `Notification not found: ${claim.notificationId}`).reason
  );
}

const LIST_DESCRIPTION =
  'List the terminal goal-outcome notifications you can claim, oldest first, up to 100. The owner identity is resolved from the calling session and never taken from input, so this returns only what you may act on. Resolve one with goal.outcome.resolve.';

const RESOLVE_DESCRIPTION =
  'Terminalize one goal-outcome notification with a disposition (acknowledge, reject, supersede), or acknowledge it while persisting goal-state updates (summary, nextSteps, metrics, observations, progress). notificationId, goalId and taskId are all required and come from goal.outcome.list; the outcome wake names the goal and task in prose but carries none of the three identities. Goal-state updates require the acknowledge disposition. Only the goal owner identity resolved from the calling session may claim; the reviewing actor is never taken from input. Claims are single-owner and idempotent, so a retry of the same claim returns already_applied without duplicating effects.';

export function createListGoalOutcomeNotificationsOperation(deps: ReviewGoalOutcomeDependencies) {
  const list = (superpipe({ deps })('goal-outcome-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitOutcomeReviewer, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(listOutcomeNotifications, ['outcome', 'caller', 'deps'], 'outcome')
    .end('outcome') as (
    input: ListInput,
    caller: OperationCaller
  ) => ListOutcomeNotificationsResult;
  return defineOperation({
    name: 'goal.outcome.list',
    description: LIST_DESCRIPTION,
    policy: GOAL_OWNER_POLICY,
    inputSchema: listInputSchema.default({}),
    resultSchema: z.union([
      z.object({
        accepted: z.literal(true),
        notifications: z.array(GoalOutcomeNotificationSchema),
      }),
      z.object({
        accepted: z.literal(false),
        reason: z.enum(GOAL_REJECTION_REASONS),
        message: z.string(),
      }),
    ]),
    execute: async (input, caller) => list(input, caller),
  });
}

export function createResolveGoalOutcomeOperation(deps: ReviewGoalOutcomeDependencies) {
  const resolve = (superpipe({ deps })('goal-outcome-resolve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitOutcomeReviewer, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(routeOutcomeClaim, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(applyOutcomeClaim, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: ResolveInput,
    caller: OperationCaller
  ) => Promise<ReviewGoalOutcomeResult>;
  return defineOperation({
    name: 'goal.outcome.resolve',
    description: RESOLVE_DESCRIPTION,
    policy: GOAL_OWNER_POLICY,
    inputSchema: resolveInputSchema,
    resultSchema: z.union([
      z.object({
        accepted: z.literal(true),
        status: z.enum(['claimed', 'already_applied']),
        notification: GoalOutcomeNotificationSchema,
        goal: SpaceGoalSchema,
      }),
      z.object({
        accepted: z.literal(false),
        reason: z.enum(GOAL_REJECTION_REASONS),
        message: z.string(),
        claimReason: z
          .enum(['unauthorized', 'superseded', 'identity_mismatch', 'stale_revision'])
          .optional(),
        currentGoalRevision: z.number().optional(),
        goal: SpaceGoalSchema.optional(),
      }),
    ]),
    execute: async (input, caller) => resolve(input, caller),
  });
}
