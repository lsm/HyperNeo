import type { Session } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { longTermAgentSessionId } from '../long-term-agent-session.ts';

export type SpaceMcpSessionRole =
  | 'coordinator'
  | 'ad_hoc_member'
  | 'workflow_worker'
  | 'long_term_agent'
  | 'universal_read'
  | 'legacy_task_agent'
  | 'outside_space';

export interface SpaceMcpSessionPolicyContext {
  readonly nodeExecutionRepo?: Pick<NodeExecutionRepository, 'getByAgentSessionId' | 'getById'>;
  readonly taskRepo?: Pick<SpaceTaskRepository, 'getTask'>;
}

export interface SpaceMcpSessionPolicy {
  readonly role: SpaceMcpSessionRole;
  readonly spaceId?: string;
  readonly owner: 'space-runtime' | 'task-agent-manager' | 'none';
  readonly requiredServers: readonly string[];
  readonly attachGenericSpaceTools: boolean;
  readonly attachCoordinatorTools: boolean;
  readonly attachLongTermAgentTools: boolean;
  readonly isWorkflowWorker: boolean;
}

export const SPACE_COORDINATOR_REQUIRED_MCP_SERVERS = ['space-agent-tools'] as const;
export const SPACE_AD_HOC_MEMBER_REQUIRED_MCP_SERVERS = ['space-agent-tools'] as const;
export const SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS = ['node-agent'] as const;

export function resolveSpaceMcpSessionPolicy(
  session: Session,
  context: SpaceMcpSessionPolicyContext = {}
): SpaceMcpSessionPolicy {
  const spaceId = session.context?.spaceId;

  if (session.type === 'space_task_agent') {
    return {
      role: 'legacy_task_agent',
      spaceId,
      owner: 'none',
      requiredServers: [],
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    };
  }

  if (session.type === 'space_chat' && spaceId) {
    return {
      role: 'coordinator',
      spaceId,
      owner: 'space-runtime',
      requiredServers: SPACE_COORDINATOR_REQUIRED_MCP_SERVERS,
      attachGenericSpaceTools: false,
      attachCoordinatorTools: true,
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
      requiredServers: SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS,
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: true,
    };
  }

  if (!spaceId) {
    return {
      role: 'outside_space',
      owner: 'none',
      requiredServers: [],
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      attachLongTermAgentTools: false,
      isWorkflowWorker: false,
    };
  }

  if (isLongTermAgentSession(session, spaceId)) {
    return {
      role: 'long_term_agent',
      spaceId,
      owner: 'space-runtime',
      requiredServers: ['space-agent-tools'],
      attachGenericSpaceTools: false,
      attachCoordinatorTools: false,
      attachLongTermAgentTools: true,
      isWorkflowWorker: false,
    };
  }

  return {
    role: 'ad_hoc_member',
    spaceId,
    owner: 'space-runtime',
    requiredServers: SPACE_AD_HOC_MEMBER_REQUIRED_MCP_SERVERS,
    attachGenericSpaceTools: true,
    attachCoordinatorTools: false,
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

function isLongTermAgentSession(session: Session, spaceId: string): boolean {
  const agentId = session.metadata.promptProvenance?.agentId;
  if (!agentId) return false;
  return session.id === longTermAgentSessionId(spaceId, agentId);
}

export function missingMcpServers(
  mcpServers: Record<string, unknown> | undefined,
  requiredServers: readonly string[]
): string[] {
  const serverNames = Object.keys(mcpServers ?? {});
  return requiredServers.filter((name) => !serverNames.includes(name));
}
