import type { SpaceGoal } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { hasSpaceAuthority } from '../space/runtime/space-mcp-session-policy.ts';
import {
  admitGoalSpace,
  GOAL_WRITE_POLICY,
  goalDenial,
  goalMutationContext,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  recordGoalAudit,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { SpaceGoalSchema } from './goal-result-schemas.ts';
import { decideGoalOwnershipMutationAdmission } from './ownership-gates.ts';
import type { SpaceGoalService } from './service.ts';
import { GoalWritableFieldsShape } from './update-goal-operation.ts';

const inputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    ...GoalWritableFieldsShape,
    title: z.string().min(1).describe('Goal title'),
    checkInCronExpression: z
      .string()
      .optional()
      .describe('Cron expression for recurring check-in task creation'),
    triggerImmediately: z.boolean().optional().describe('Create the first goal task immediately'),
    ownerAgentId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Long-horizon agent to assign as the goal primary owner at creation. Defaults to the calling agent when absent.'
      ),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Scope = { spaceId: string; ownerAgentId: string | null };
type Result = { accepted: true; goal: SpaceGoal } | GoalRejection;

export interface CreateGoalDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'createGoal' | 'resolveGoalWorkspacePath'>;
}

export function admitGoalCreation(
  input: Input,
  caller: OperationCaller,
  deps: CreateGoalDependencies
): { value: string } | { reason: GoalRejection } {
  return admitGoalSpace(caller, input.spaceId, 'mutate', deps);
}

export function resolveCreateGoalOwner(
  spaceId: string,
  input: Input,
  caller: OperationCaller,
  deps: CreateGoalDependencies
): { value: Scope } | { reason: GoalRejection } {
  const explicit = input.ownerAgentId;
  const callerHasAuthority = hasSpaceAuthority(caller.role);
  const self = caller.agentId ? deps.longHorizonAgentRepo.getById(caller.agentId) : null;
  if (typeof explicit !== 'string' || explicit.length === 0) {
    return { value: { spaceId, ownerAgentId: self?.spaceId === spaceId ? self.id : null } };
  }
  const owner = deps.longHorizonAgentRepo.getById(explicit);
  if (owner?.spaceId !== spaceId) {
    return goalDenial('owner_not_found', `Long-horizon agent not found: ${explicit}`);
  }
  if (callerHasAuthority && (self?.spaceId !== spaceId || self.status !== 'active')) {
    return goalDenial(
      'owner_denied',
      'This operation requires an active Space agent identity; the provenance agent is missing or inactive.'
    );
  }
  const admission = decideGoalOwnershipMutationAdmission({
    hasSpaceAuthority: callerHasAuthority,
    hasSession: typeof caller.sessionId === 'string',
  });
  if (caller.agentId !== explicit && admission.action === 'deny') {
    return goalDenial(
      'owner_denied',
      'Specifying an owner other than yourself requires a Space agent session or explicit human authorization.'
    );
  }
  return { value: { spaceId, ownerAgentId: explicit } };
}

export async function applyGoalCreation(
  scope: Scope,
  input: Input,
  caller: OperationCaller,
  deps: CreateGoalDependencies
): Promise<Result> {
  const goal = deps.goalService.createGoal(
    {
      spaceId: scope.spaceId,
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority,
      labels: input.labels,
      metrics: input.metrics,
      summary: input.summary,
      progress: input.progress,
      nextSteps: input.nextSteps,
      preferredWorkflowId: input.preferredWorkflowId,
      autoTriggerNext: input.autoTriggerNext,
      checkInCronExpression: input.checkInCronExpression,
      checkInTimezone: input.checkInTimezone,
      triggerImmediately: input.triggerImmediately,
      primaryOwnerAgentId: scope.ownerAgentId,
      workspacePath: await deps.goalService.resolveGoalWorkspacePath(
        scope.spaceId,
        input.workspacePath
      ),
    },
    goalMutationContext(caller)
  );
  recordGoalAudit(deps, caller, scope.spaceId, 'goal.create', {
    title: input.title,
    type: input.type,
    priority: input.priority,
    triggerImmediately: input.triggerImmediately,
    checkInCronExpression: input.checkInCronExpression,
  });
  return { accepted: true, goal };
}

const DESCRIPTION =
  'Create a long-horizon goal, optionally scheduling recurring check-ins or triggering the first task immediately. ownerAgentId names the primary owner and defaults to the calling agent; naming someone else requires Space authority. Requires an active session in the owning Space. Returns { accepted: true, goal } or { accepted: false, reason }.';

export function createCreateGoalOperation(deps: CreateGoalDependencies) {
  const create = (superpipe({ deps })('goal-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalCreation, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(resolveCreateGoalOwner, ['outcome', 'input', 'caller', 'deps'], 'result:outcome')
    .pipe(applyGoalCreation, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.create',
    description: DESCRIPTION,
    policy: { ...GOAL_WRITE_POLICY, audit: { selfAudited: true } },
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({ accepted: z.literal(true), goal: SpaceGoalSchema }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => create(input, caller),
  });
}
