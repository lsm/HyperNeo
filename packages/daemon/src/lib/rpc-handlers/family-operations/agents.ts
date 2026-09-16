import { createAgentOperations } from '../../agents/operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerAgentOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createAgentOperations({
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
  });
}
