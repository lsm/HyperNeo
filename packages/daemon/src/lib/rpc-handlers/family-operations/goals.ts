import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { SessionGoalRepository } from '../../../storage/repositories/session-goal-repository.ts';
import { createSessionGoalOperations } from '../../goals/session-goal-operations.ts';
import { SessionGoalSchedules } from '../../goals/session-goal-schedules.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerSessionGoalOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  const audit = new McpAuditLogRepository(context.deps.db.getDatabase());
  const goals = new SessionGoalRepository(context.deps.db.getDatabase(), context.deps.reactiveDb);
  const schedules = new SessionGoalSchedules(
    goals,
    new NeoAskTodoRepository(context.deps.db.getDatabase()),
    context.sessionScheduler,
    context.neoPacks,
    context.goalMandateChange
  );
  context.sessionScheduler.registerSource(schedules);
  return createSessionGoalOperations({
    goals,
    schedules,
    sessionExists: (sessionId) => context.deps.db.getSession(sessionId) !== null,
    audit: (caller, toolName, summary) =>
      audit.createEntry({
        agentName: caller.agentName,
        sessionId: caller.sessionId,
        toolName,
        paramsSummary: JSON.stringify(summary),
      }),
  });
}
