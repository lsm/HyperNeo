import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { Logger } from '../../logger.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { createSpawnSessionCloneOperation } from '../../session/clone-operations.ts';
import { createReturnSessionCloneOperation } from '../../session/clone-return-operation.ts';
import { createSessionOperations } from '../../session/operations.ts';
import { createSetSessionParentOperation } from '../../session/parent-operation.ts';
import { createSessionRuntimeSettingsOperations } from '../../session/runtime-settings-operations.ts';
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
  const moveSession = createSetSessionParentOperation({
    getSession: scopeDeps.getSession,
    listChildren: (sessionId) => context.deps.db.listChildSessions(sessionId),
    sessionSpaceId: (session) =>
      resolveSessionSpaceId(session, scopeDeps) ?? session.context?.spaceId,
    setParent: (sessionId, parentId) => {
      const current = context.deps.db.getSession(sessionId);
      if (current)
        context.deps.db.updateSession(sessionId, {
          metadata: { ...current.metadata, movedUnderParent: parentId !== null },
        });
      context.deps.db.setSessionParent(sessionId, parentId);
      context.deps.db.notifyChange('sessions', { sessionId });
    },
  });
  return [
    spawn,
    returnToParent,
    moveSession,
    ...createSessionRuntimeSettingsOperations({
      getLiveSession: (sessionId) =>
        context.taskAgentManager?.getCachedAgentSessionById(sessionId) ??
        context.deps.sessionManager.getCachedSession(sessionId) ??
        null,
      getSession: scopeDeps.getSession,
      sessionSpaceId: (session) =>
        resolveSessionSpaceId(session, scopeDeps) ?? session.context?.spaceId,
      capture: (id) => context.deps.db.captureSessionRuntimeSettings(id),
      commit: (snapshot, patch) => context.deps.db.casSessionRuntimeSettings(snapshot, patch),
      isPreparing: (id) =>
        context.deps.sessionManager.isRuntimeSettingsPreparing(id) ||
        context.taskAgentManager.isRuntimeSettingsPreparing(id),
      hasPendingWork: (id) =>
        context.deps.db.getJobQueueRepo().activeDeliveryMessageUuids(id).size > 0 ||
        context.deps.db.getJobQueueRepo().activeMailboxMessageUuids(id).size > 0,
      notify: async (id) => {
        const session = context.deps.db.getSession(id);
        if (session)
          await context.deps.internalEventBus.publish('session.updated', {
            sessionId: id,
            source: 'runtime-settings',
            session: { config: session.config },
          });
      },
    }),
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
