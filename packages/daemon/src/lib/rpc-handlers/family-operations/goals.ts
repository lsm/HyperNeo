import { createGoalOperations } from '../../goals/operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerGoalOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createGoalOperations({
    goalService: context.spaceGoalService,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    taskRepo: context.spaceTaskRepo,
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
  });
}
