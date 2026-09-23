import type { SpaceGoal, SpaceGoalEvent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitGoalAccess,
  GOAL_READ_POLICY,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { SpaceGoalEventSchema } from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const inputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    goalId: z.string().min(1).describe('Goal ID'),
    limit: z.number().int().min(1).max(100).optional().describe('Max events to return'),
    before: z.number().int().optional().describe('Return events before this timestamp'),
    beforeId: z.string().min(1).optional().describe('Cursor event ID for same-timestamp paging'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Result = { accepted: true; total: number; events: SpaceGoalEvent[] } | GoalRejection;

export interface ListGoalEventsDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'getGoal' | 'listGoalEvents'>;
}

export function admitGoalEventListing(
  input: Input,
  caller: OperationCaller,
  deps: ListGoalEventsDependencies
): { value: SpaceGoal } | { reason: GoalRejection } {
  return admitGoalAccess(caller, input, 'read', deps, (goalId) => deps.goalService.getGoal(goalId));
}

export function readGoalEvents(
  goal: SpaceGoal,
  input: Input,
  deps: ListGoalEventsDependencies
): Result {
  const events = deps.goalService.listGoalEvents(goal.id, {
    limit: input.limit,
    before: input.before,
    beforeId: input.beforeId,
  });
  return { accepted: true, total: events.length, events };
}

const DESCRIPTION =
  'List append-only history events for a goal to understand why its rolling state changed; returns newest-first events. Returns { accepted: true, total, events } or { accepted: false, reason }.';

export function createListGoalEventsOperation(deps: ListGoalEventsDependencies) {
  const listGoalEvents = (superpipe({ deps })('goal-events-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalEventListing, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(readGoalEvents, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.event.list',
    description: DESCRIPTION,
    policy: GOAL_READ_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({
        accepted: z.literal(true),
        total: z.number().int().min(0),
        events: z.array(SpaceGoalEventSchema),
      }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => listGoalEvents(input, caller),
  });
}
