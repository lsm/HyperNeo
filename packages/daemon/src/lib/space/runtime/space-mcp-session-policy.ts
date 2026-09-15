import type { Session } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { longTermAgentSessionId } from '../long-term-agent-session.ts';
import type { DirectTaskWorkerIdentity } from '../../tasks/direct-task-worker-identity.ts';

export type SpaceMcpSessionRole =
  | 'ad_hoc_member'
  | 'workflow_worker'
  | 'direct_task_worker'
  | 'long_term_agent'
  | 'universal_read'
  | 'legacy_task_agent'
  | 'outside_space';

export function hasSpaceAuthority(role: SpaceMcpSessionRole | undefined): boolean {
  return role === 'long_term_agent';
}

export interface SpaceMcpSessionPolicyContext {
  readonly hasDirectWorkerProvenance?: (sessionId: string) => boolean;
  readonly resolveDirectWorker?: (sessionId: string) => DirectTaskWorkerIdentity | null;
  readonly nodeExecutionRepo?: Pick<NodeExecutionRepository, 'getByAgentSessionId' | 'getById'>;
  readonly taskRepo?: Pick<SpaceTaskRepository, 'getTask'>;
  readonly longHorizonAgentRepo: Pick<SpaceLongHorizonAgentRepository, 'getById'>;
}

export interface SpaceMcpSessionPolicy {
  readonly role: SpaceMcpSessionRole;
  readonly spaceId?: string;
  readonly owner: 'space-runtime' | 'task-agent-manager' | 'direct-task-executor' | 'none';
  readonly requiredServers: readonly string[];
  readonly attachGenericSpaceTools: boolean;
  readonly attachSpaceChatTools: boolean;
  readonly attachLongTermAgentTools: boolean;
  readonly isWorkflowWorker: boolean;
}

export function spaceAdHocMemberRequiredMcpServers(): readonly string[] {
  return ['space-actions'];
}

export function spaceWorkflowWorkerRequiredMcpServers(): readonly string[] {
  return ['space-actions'];
}

export const FAIL_CLOSED_LONG_HORIZON_AGENT_REPO: SpaceMcpSessionPolicyContext['longHorizonAgentRepo'] =
  {
    getById: () => null,
  };

export function resolveSpaceMcpSessionPolicy(
  session: Session,
  context: SpaceMcpSessionPolicyContext = {
    longHorizonAgentRepo: FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
  }
): SpaceMcpSessionPolicy {
  const spaceId = session.context?.spaceId;

  const hasDirectProvenance = context.hasDirectWorkerProvenance?.(session.id);
  const directWorker =
    hasDirectProvenance === false ? null : context.resolveDirectWorker?.(session.id);
  if (directWorker || hasDirectProvenance) {
    return {
      role: 'direct_task_worker',
      spaceId: directWorker?.spaceId,
      owner: directWorker ? 'direct-task-executor' : 'none',
      requiredServers: [],
      attachGenericSpaceTools: false,
      attachSpaceChatTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    };
  }

  if (session.type === 'space_task_agent') {
    return {
      role: 'legacy_task_agent',
      spaceId,
      owner: 'none',
      requiredServers: [],
      attachGenericSpaceTools: false,
      attachSpaceChatTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    };
  }

  if (session.type === 'space_chat' && spaceId) {
    return {
      role: 'ad_hoc_member',
      spaceId,
      owner: 'space-runtime',
      requiredServers: spaceAdHocMemberRequiredMcpServers(),
      attachGenericSpaceTools: false,
      attachSpaceChatTools: true,
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    };
  }

  const workflowExecution = resolveWorkflowExecution(session, context.nodeExecutionRepo);
  if (workflowExecution) {
    const taskId = session.context?.taskId;
    const task = taskId ? (context.taskRepo?.getTask(taskId) ?? null) : null;
    const resolvedSpaceId = spaceId ?? task?.spaceId;
    return {
      role: 'workflow_worker',
      spaceId: resolvedSpaceId,
      owner: 'task-agent-manager',
      requiredServers: spaceWorkflowWorkerRequiredMcpServers(),
      attachGenericSpaceTools: false,
      attachSpaceChatTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: true,
    };
  }

  if (!spaceId) {
    return {
      role: 'universal_read',
      spaceId: undefined,
      owner: 'none',
      requiredServers: ['space-actions'],
      attachGenericSpaceTools: false,
      attachSpaceChatTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    };
  }

  if (isLongTermAgentSession(session, spaceId, context.longHorizonAgentRepo)) {
    return {
      role: 'long_term_agent',
      spaceId,
      owner: 'space-runtime',
      requiredServers: spaceAdHocMemberRequiredMcpServers(),
      attachGenericSpaceTools: false,
      attachSpaceChatTools: false,
      attachLongTermAgentTools: true,
      isWorkflowWorker: false,
    };
  }

  return {
    role: 'ad_hoc_member',
    spaceId,
    owner: 'space-runtime',
    requiredServers: spaceAdHocMemberRequiredMcpServers(),
    attachGenericSpaceTools: true,
    attachSpaceChatTools: false,
    attachLongTermAgentTools: false,
    isWorkflowWorker: false,
  };
}

function resolveWorkflowExecution(
  session: Session,
  nodeExecutionRepo: SpaceMcpSessionPolicyContext['nodeExecutionRepo']
) {
  const bySessionId = nodeExecutionRepo?.getByAgentSessionId(session.id) ?? null;
  if (bySessionId) return bySessionId;

  const executionId = parseExecutionIdFromSubSessionId(session.id);
  if (!executionId) return null;

  return nodeExecutionRepo?.getById(executionId) ?? null;
}

function parseExecutionIdFromSubSessionId(sessionId: string): string | null {
  const marker = ':exec:';
  const markerIndex = sessionId.indexOf(marker);
  if (markerIndex === -1) return null;
  const executionId = sessionId.slice(markerIndex + marker.length).split(':')[0];
  return executionId || null;
}

function isLongTermAgentSession(
  session: Session,
  spaceId: string,
  longHorizonAgentRepo: SpaceMcpSessionPolicyContext['longHorizonAgentRepo']
): boolean {
  const agentId = session.metadata.promptProvenance?.agentId;
  if (!agentId) return false;
  if (session.id !== longTermAgentSessionId(spaceId, agentId)) return false;
  const agent = longHorizonAgentRepo?.getById(agentId) ?? null;
  return agent !== null && agent.spaceId === spaceId && agent.status === 'active';
}

export function missingMcpServers(
  mcpServers: Record<string, unknown> | undefined,
  requiredServers: readonly string[]
): string[] {
  const serverNames = Object.keys(mcpServers ?? {});
  return requiredServers.filter((name) => !serverNames.includes(name));
}
