import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createCreateGoalOperation } from '../../../../../space/src/goals/create-goal-operation';
import { createGetGoalOperation } from '../../../../../space/src/goals/get-goal-operation';
import { createListGoalsOperation } from '../../../../../space/src/goals/list-goals-operation';
import { createUpdateGoalOperation } from '../../../../../space/src/goals/update-goal-operation';
import { createListGoalEventsOperation } from '../../../../../space/src/goals/list-goal-events-operation';
import { createListGoalTasksOperation } from '../../../../../space/src/goals/list-goal-tasks-operation';
import { createGetGoalOwnerOperation } from '../../../../../space/src/goals/get-goal-owner-operation';
import { createTriggerGoalTaskOperation } from '../../../../../space/src/goals/goal-state-operations';
import {
  createListGoalOutcomeNotificationsOperation,
  createResolveGoalOutcomeOperation,
} from '../../../../../space/src/goals/review-goal-outcome-operation';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const caller: OperationCaller = { source: 'mcp', role: 'long_term_agent' };
const operations = [
  createCreateGoalOperation(deps),
  createGetGoalOperation(deps),
  createListGoalsOperation(deps),
  createUpdateGoalOperation(deps),
  createListGoalEventsOperation(deps),
  createListGoalTasksOperation(deps),
  createGetGoalOwnerOperation(deps),
  createTriggerGoalTaskOperation(deps),
  createListGoalOutcomeNotificationsOperation(deps),
  createResolveGoalOutcomeOperation(deps),
];

describe('goal operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute({ spaceId: 'space-1', goalId: 'missing' } as never, caller)
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
