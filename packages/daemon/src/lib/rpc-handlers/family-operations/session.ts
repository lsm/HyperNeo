import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { Logger } from '../../logger.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { createSpawnSessionCloneOperation } from '../../session/clone-operations.ts';
import { createReturnSessionCloneOperation } from '../../session/clone-return-operation.ts';
import { createSessionOperations } from '../../session/operations.ts';
import { resolveSpaceMcpSessionPolicy } from '../../space/runtime/space-mcp-session-policy.ts';
import { resolveSessionSpaceId } from '../../space/runtime/space-caller-scope.ts';
import type { FamilyOperationContext } from './context.ts';

const log = new Logger('session-operations');

export function registerSessionOperations(context: FamilyOperationContext): OperationDefinition[] {
  const scopeDeps = {
    getSession: (sessionId: string) => context.deps.db.getSession(sessionId),
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    hasDirectWorkerProvenance: context.hasDirectWorkerProvenance,
    resolveDirectWorker: context.resolveDirectWorker,
  };
  const spawn = createSpawnSessionCloneOperation({
    getSession: scopeDeps.getSession,
    getSpace: (spaceId) => context.deps.spaceManager.getSpace(spaceId),
    resolveRole: (session) => resolveSpaceMcpSessionPolicy(session, scopeDeps).role,
    isGitRepo: async (workspacePath) =>
      (await context.deps.sessionManager.getWorktreeManager().detectGitSupport(workspacePath))
        .isGitRepo,
    createSession: (params) => context.deps.sessionManager.createSession(params),
    addSpaceSession: (spaceId, sessionId) =>
      context.deps.spaceManager.addSession(spaceId, sessionId),
    attachSpaceTools: (sessionId) =>
      context.spaceRuntimeService.reattachMemberSpaceTools(sessionId),
    jobQueue: context.deps.jobQueue,
  });
  const returnToParent = createReturnSessionCloneOperation({
    getSession: scopeDeps.getSession,
    getSpace: (spaceId) => context.deps.spaceManager.getSpace(spaceId),
    sessionSpaceId: (session) => resolveSessionSpaceId(session, scopeDeps),
    getSessionStatus: (sessionId) =>
      (
        context.taskAgentManager?.getCachedAgentSessionById(sessionId) ??
        context.deps.sessionManager.getCachedSession(sessionId)
      )?.getProcessingState().status ?? '',
    markReturned: (sessionId, returnedAt) => {
      const current = context.deps.db.getSession(sessionId);
      if (!current) return;
      context.deps.db.updateSession(sessionId, {
        metadata: { ...current.metadata, clone: { returnedAt } },
      });
    },
    getDatabase: () => context.deps.db.getDatabase(),
    getSdkMessageRepo: () => context.deps.db.getSDKMessageRepo(),
    jobQueue: context.deps.jobQueue,
  });
  return [
    spawn,
    returnToParent,
    ...createSessionOperations({
      getDatabase: () => context.deps.db.getDatabase(),
      getLiveSession: (sessionId) =>
        context.taskAgentManager?.getCachedAgentSessionById(sessionId) ??
        context.deps.sessionManager.getCachedSession(sessionId) ??
        null,
      getSession: scopeDeps.getSession,
      sessionSpaceId: (session) => resolveSessionSpaceId(session, scopeDeps),
      audit: (entry) => {
        try {
          new McpAuditLogRepository(context.deps.db.getDatabase()).createEntry({
            sessionId: entry.caller.sessionId,
            agentName: entry.caller.agentName,
            toolName: entry.toolName,
            spaceId: entry.spaceId,
            paramsSummary: JSON.stringify(entry.paramsSummary),
          });
        } catch (err) {
          log.warn('session audit write failed:', err);
        }
      },
    }),
  ];
}
