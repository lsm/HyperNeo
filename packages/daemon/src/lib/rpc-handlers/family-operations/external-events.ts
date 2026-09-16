import { createNodeAgentRestoreOperation } from '../../external-events/node-agent-restore-operation.ts';
import { createExternalEventOperations } from '../../external-events/operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerExternalEventOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  return [
    ...createExternalEventOperations({
      eventStore: context.deps.externalEventStore,
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
    createNodeAgentRestoreOperation({
      restoreNodeAgent: (sessionId, reason) =>
        context.taskAgentManager.restoreNodeAgentSession(sessionId, reason),
      getSession: (sessionId) => context.deps.db.getSession(sessionId),
      taskRepo: context.spaceTaskRepo,
      nodeExecutionRepo: context.nodeExecutionRepo,
      longHorizonAgentRepo: context.longHorizonAgentRepo,
    }),
  ];
}
