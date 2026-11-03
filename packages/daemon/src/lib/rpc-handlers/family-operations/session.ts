import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { Logger } from '../../logger.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { createSpawnSessionCloneOperation } from '../../session/clone-operations.ts';
import { createReturnSessionCloneOperation } from '../../session/clone-return-operation.ts';
import { createSessionOperations } from '../../session/operations.ts';
import { createSetSessionParentOperation } from '../../session/parent-operation.ts';
import { createSessionRuntimeSettingsOperations } from '../../session/runtime-settings-operations.ts';
import type { Session } from '@hyperneo/shared';
import type { FamilyOperationContext } from './context.ts';

const log = new Logger('session-operations');

export function registerSessionOperations(context: FamilyOperationContext): OperationDefinition[] {
  const space = context.sessionSpace;
  const getSession = (sessionId: string) => context.deps.db.getSession(sessionId);
  const sessionSpaceId = (session: Session) => space?.sessionSpaceId(session);
  const getLiveSession = (sessionId: string) =>
    space?.liveSession(sessionId) ?? context.deps.sessionManager.getCachedSession(sessionId);
  const spawn = createSpawnSessionCloneOperation({
    getSession,
    getSpace: async (spaceId) => (await space?.getSpace(spaceId)) ?? null,
    resolveRole: (session) => space?.resolveRole(session) ?? 'universal_read',
    isGitRepo: async (workspacePath) =>
      (await context.deps.sessionManager.getWorktreeManager().detectGitSupport(workspacePath))
        .isGitRepo,
    createSession: (params) => context.deps.sessionManager.createSession(params),
    addSpaceSession: async (spaceId, sessionId) => space?.addSession(spaceId, sessionId),
    attachSpaceTools: async (sessionId) => space?.attachTools(sessionId),
    jobQueue: context.deps.jobQueue,
  });
  const returnToParent = createReturnSessionCloneOperation({
    getSession,
    getSpace: async (spaceId) => (await space?.getSpace(spaceId)) ?? null,
    sessionSpaceId,
    getSessionStatus: (sessionId) => getLiveSession(sessionId)?.getProcessingState().status ?? '',
    markReturned: async (sessionId, returnedAt) => {
      const current = context.deps.db.getSession(sessionId);
      if (!current) return;
      await context.deps.db.updateSession(sessionId, {
        metadata: { ...current.metadata, clone: { returnedAt } },
      });
    },
    getDatabase: () => context.deps.db.getDatabase(),
    getSdkMessageRepo: () => context.deps.db.getSDKMessageRepo(),
    jobQueue: context.deps.jobQueue,
  });
  const moveSession = createSetSessionParentOperation({
    getSession,
    listChildren: (sessionId) => context.deps.db.listChildSessions(sessionId),
    sessionSpaceId: (session) => sessionSpaceId(session) ?? session.context?.spaceId,
    setParent: async (sessionId, parentId) => {
      const current = context.deps.db.getSession(sessionId);
      if (current)
        await context.deps.db.updateSession(sessionId, {
          metadata: { ...current.metadata, movedUnderParent: parentId !== null },
        });
      await context.deps.db.setSessionParent(sessionId, parentId);
    },
  });
  return [
    spawn,
    returnToParent,
    moveSession,
    ...createSessionRuntimeSettingsOperations({
      getLiveSession: (sessionId) => getLiveSession(sessionId) ?? null,
      getSession,
      sessionSpaceId: (session) => sessionSpaceId(session) ?? session.context?.spaceId,
      capture: (id) => context.deps.db.captureSessionRuntimeSettings(id),
      commit: (snapshot, patch) => context.deps.db.casSessionRuntimeSettings(snapshot, patch),
      isPreparing: (id) =>
        context.deps.sessionManager.isRuntimeSettingsPreparing(id) ||
        !!space?.isRuntimeSettingsPreparing(id),
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
      getLiveSession: (sessionId) => getLiveSession(sessionId) ?? null,
      getSession,
      updateSession: (sessionId, updates) => context.deps.db.updateSession(sessionId, updates),
      sessionSpaceId,
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
