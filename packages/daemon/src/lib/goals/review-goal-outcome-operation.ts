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

const inputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    notificationId: z
      .string()
      .min(1)
      .optional()
      .describe('Pending notification identity; omit to discover owned pending notifications'),
    goalId: z.string().min(1).optional().describe('Goal the outcome belongs to'),
    taskId: z.string().min(1).optional().describe('Completed task the outcome belongs to'),
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

type Input = z.infer<typeof inputSchema>;

type Claim = {
  spaceId: string;
  notificationId: string;
  goalId: string;
  taskId: string;
  dispositionStatus: 'acknowledged' | 'rejected' | 'superseded';
  hasGoalUpdate: boolean;
};

export type ReviewGoalOutcomeResult =
  | { kind: 'discovery'; accepted: true; notifications: SpaceGoalOutcomeNotification[] }
  | {
      kind: 'claimed';
      accepted: true;
      status: 'claimed' | 'already_applied';
      notification: SpaceGoalOutcomeNotification;
      goal: SpaceGoal;
    }
  | {
      kind: 'rejected';
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

export function hasGoalStateUpdate(input: Input): boolean {
  return (
    input.summary !== undefined ||
    input.nextSteps !== undefined ||
    input.metrics !== undefined ||
    input.observations !== undefined ||
    input.progress !== undefined
  );
}

function rejected(rejection: GoalRejection): ReviewGoalOutcomeResult {
  return { kind: 'rejected', ...rejection };
}

function invalid(message: string): { reason: ReviewGoalOutcomeResult } {
  return { reason: rejected(goalDenial('review_input_invalid', message).reason) };
}

export function admitOutcomeReviewer(
  input: Input,
  caller: OperationCaller,
  deps: ReviewGoalOutcomeDependencies
): { value: string } | { reason: ReviewGoalOutcomeResult } {
  const space = admitGoalSpace(caller, input.spaceId, 'owner', deps);
  return 'reason' in space ? { reason: rejected(space.reason) } : space;
}

export function routeOutcomeReview(
  spaceId: string,
  input: Input,
  caller: OperationCaller,
  deps: ReviewGoalOutcomeDependencies
): { value: Claim } | { reason: ReviewGoalOutcomeResult } {
  const hasGoalUpdate = hasGoalStateUpdate(input);
  if (!input.notificationId) {
    if (hasGoalUpdate) {
      return invalid(
        'goal-state updates require notificationId; call without update fields to discover pending notifications'
      );
    }
    return {
      reason: {
        kind: 'discovery',
        accepted: true,
        notifications: deps.goalService.listClaimableOutcomeNotifications({
          spaceId,
          callerAgentId: caller.agentId ?? null,
          humanAdmissionAllowed: HUMAN_ADMISSION_ALLOWED,
          limit: DISCOVERY_LIMIT,
        }),
      },
    };
  }
  if (!input.disposition && !hasGoalUpdate) {
    return invalid(
      'disposition (acknowledge, reject, or supersede) or a goal-state update is required when notificationId is provided'
    );
  }
  if (input.disposition && input.disposition !== 'acknowledge' && hasGoalUpdate) {
    return invalid('goal-state updates require the acknowledge disposition');
  }
  if (!input.goalId || !input.taskId) {
    return invalid('goalId and taskId are required when notificationId is provided');
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
  input: Input,
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
      'goal.reviewOutcome',
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
      kind: 'claimed',
      accepted: true,
      status: result.status,
      notification: result.notification,
      goal: result.goal,
    };
  }
  if (result.status === 'denied') {
    return {
      kind: 'rejected',
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

const DESCRIPTION =
  'Review a terminal goal-outcome notification. Call without notificationId to discover the pending notifications you own, then terminalize one with a disposition (acknowledge, reject, supersede) or acknowledge it while persisting goal-state updates (summary, nextSteps, metrics, observations, progress). Goal-state updates require the acknowledge disposition and both goalId and taskId. Only the goal owner identity resolved from the calling session may claim; the reviewing actor is never taken from input.';

export function createReviewGoalOutcomeOperation(deps: ReviewGoalOutcomeDependencies) {
  const review = (superpipe({ deps })('goal-review-outcome') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitOutcomeReviewer, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(routeOutcomeReview, ['outcome', 'input', 'caller', 'deps'], 'result:outcome')
    .pipe(applyOutcomeClaim, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<ReviewGoalOutcomeResult>;
  return defineOperation({
    name: 'goal.reviewOutcome',
    description: DESCRIPTION,
    policy: { ...GOAL_OWNER_POLICY, audit: { selfAudited: true } },
    inputSchema,
    resultSchema: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('discovery'),
        accepted: z.literal(true),
        notifications: z.array(GoalOutcomeNotificationSchema),
      }),
      z.object({
        kind: z.literal('claimed'),
        accepted: z.literal(true),
        status: z.enum(['claimed', 'already_applied']),
        notification: GoalOutcomeNotificationSchema,
        goal: SpaceGoalSchema,
      }),
      z.object({
        kind: z.literal('rejected'),
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
    execute: async (input, caller) => review(input, caller),
  });
}
