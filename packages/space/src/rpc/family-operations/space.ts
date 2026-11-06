import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import { resolveSessionSpaceId } from '../../../../daemon/src/lib/session-resolution/space-caller-scope.ts';
import { resolveSpaceMcpSessionPolicy } from '../../../../daemon/src/lib/session-resolution/space-mcp-session-policy.ts';
import { registerAgentOperations } from './agents.ts';
import { registerArtifactOperations } from './artifacts.ts';
import { registerAuditOperations } from '../../../../daemon/src/lib/rpc-handlers/family-operations/audit.ts';
import type {
  FamilyOperationContext,
  SessionSpacePort,
} from '../../../../daemon/src/lib/rpc-handlers/family-operations/context.ts';
import { registerEvolutionOperations } from './evolution.ts';
import { registerExternalEventOperations } from './external-events.ts';
import { registerGoalOperations } from './goals.ts';
import { registerMessagingOperations } from './messaging.ts';
import { registerScheduleOperations } from './schedule.ts';
import type { SpaceFamilyContext } from './space-context.ts';
import { registerSpaceOperations } from './spaces.ts';
import { registerWorkflowOperations } from './workflows.ts';

export function createSessionSpacePort(
  context: Omit<SpaceFamilyContext, Exclude<keyof FamilyOperationContext, 'deps'>>
): SessionSpacePort {
  const scopeDeps = {
    getSession: (sessionId: string) => context.deps.db.getSession(sessionId),
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    hasDirectWorkerProvenance: context.hasDirectWorkerProvenance,
    resolveDirectWorker: context.resolveDirectWorker,
  };
  return {
    sessionSpaceId: (session) => resolveSessionSpaceId(session, scopeDeps),
    resolveRole: (session) => resolveSpaceMcpSessionPolicy(session, scopeDeps).role,
    getSpace: (spaceId) => context.spaceManager.getSpace(spaceId),
    addSession: (spaceId, sessionId) => context.spaceManager.addSession(spaceId, sessionId),
    attachTools: (sessionId) => context.spaceRuntimeService.reattachMemberSpaceTools(sessionId),
    liveSession: (sessionId) => context.taskAgentManager?.getCachedAgentSessionById(sessionId),
    isRuntimeSettingsPreparing: (sessionId) =>
      context.taskAgentManager.isRuntimeSettingsPreparing(sessionId),
  };
}

export function collectSpaceFamilyOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return [
    ...registerAgentOperations(context),
    ...registerArtifactOperations(context),
    ...registerAuditOperations(context),
    ...registerEvolutionOperations(context),
    ...registerExternalEventOperations(context),
    ...registerGoalOperations(context),
    ...registerMessagingOperations(context),
    ...registerScheduleOperations(context),
    ...registerSpaceOperations(context),
    ...registerWorkflowOperations(context),
  ];
}
