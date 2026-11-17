import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { SessionGoalRepository } from '../../../storage/repositories/session-goal-repository.ts';
import { createSessionGoalOperations } from '../../goals/session-goal-operations.ts';
import { SessionGoalSchedules } from '../../goals/session-goal-schedules.ts';
import { goalParentProblem, startGoalSession } from '../../goals/goal-session-start.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerSessionGoalOperations(
  context: FamilyOperationContext
): OperationDefinition[] {
  const audit = new McpAuditLogRepository(context.deps.db.getDatabase());
  const goals = new SessionGoalRepository(context.deps.db.getDatabase(), context.deps.reactiveDb);
  const parentProblem = (sessionId: string) =>
    goalParentProblem(sessionId, {
      getSession: (id) => context.deps.db.getSession(id),
      getSpace: async (spaceId) => (await context.sessionSpace?.getSpace(spaceId)) ?? null,
      resolveRole: (session) => context.sessionSpace?.resolveRole(session) ?? 'universal_read',
    });
  const canReturn = (sessionId: string) => {
    const session = context.deps.db.getSession(sessionId);
    return (
      !!session?.parentSessionId &&
      !session.id.startsWith('neo:') &&
      !session.metadata?.movedUnderParent
    );
  };
  const releaseSession = async (sessionId: string) => {
    await context.deps.sessionManager.archiveSessionResources(sessionId, 'work_archive');
  };
  const schedules = new SessionGoalSchedules(
    goals,
    new NeoAskTodoRepository(context.deps.db.getDatabase()),
    context.sessionScheduler,
    context.neoPacks,
    canReturn,
    context.goalMandateChange,
    (owner) => {
      const neo = context.defaultNeoSession?.();
      if (!neo || owner === neo) return '';
      return context.deps.db.getSession(owner)?.parentSessionId === neo
        ? ' Send Neo the review summary with session.clone.return.'
        : ` Send Neo the review summary with message.send to ${neo}, kind done.`;
    },
    (owner) => context.defaultNeoSession?.() ?? (owner.startsWith('neo:') ? owner : undefined)
  );
  context.sessionScheduler.registerSource(schedules);
  context.startupTasks?.push(
    goals.listScheduled().then((rows) => {
      for (const goal of rows) schedules.reconcile(goal);
    })
  );
  return createSessionGoalOperations({
    goals,
    schedules,
    sessionExists: (sessionId) => context.deps.db.getSession(sessionId) !== null,
    parentProblem,
    canReturn,
    startSession: async (parentSessionId, title) => {
      const parent = context.deps.db.getSession(parentSessionId);
      if (!parent) throw new Error(`Session not found: ${parentSessionId}`);
      return startGoalSession(parent, title, {
        isGitRepo: async (workspacePath) =>
          (await context.deps.sessionManager.getWorktreeManager().detectGitSupport(workspacePath))
            .isGitRepo,
        createSession: (params) => context.deps.sessionManager.createSession(params),
        addSpaceSession: async (spaceId, sessionId) =>
          context.sessionSpace?.addSession(spaceId, sessionId),
        attachSpaceTools: async (sessionId) => context.sessionSpace?.attachTools(sessionId),
        releaseSession,
      });
    },
    releaseSession,
    neoChanged: context.neoChanged,
    ensureNeo: context.ensureNeo,
    reportMetricTarget: (id, text) => {
      if (!context.reportGoalMetric) throw new Error('Goal metric reporting is unavailable');
      context.reportGoalMetric(id, text);
    },
    metricReported: context.notifyGoalMetric,
    audit: (caller, toolName, summary) =>
      audit.createEntry({
        agentName: caller.agentName,
        sessionId: caller.sessionId,
        toolName,
        paramsSummary: JSON.stringify(summary),
      }),
  });
}
