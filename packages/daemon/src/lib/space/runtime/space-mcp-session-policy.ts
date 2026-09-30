import type { Session } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import {
  classifySession,
  hasCapability,
  requiredMcpServersFor,
  type SessionFacts,
  type SessionKind,
} from '../../session-profile/classify.ts';
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
  readonly kind: SessionKind;
  readonly spaceId?: string;
  readonly owner: 'space-runtime' | 'task-agent-manager' | 'none';
  readonly requiredServers: readonly string[];
  readonly attachGenericSpaceTools: boolean;
  readonly attachCoordinatorTools: boolean;
  readonly attachLongTermAgentTools: boolean;
  readonly isWorkflowWorker: boolean;
}

const OWNER_BY_KIND: Record<SessionKind, SpaceMcpSessionPolicy['owner']> = {
  'chat.default': 'none',
  'space.chat': 'space-runtime',
  'space.agent': 'space-runtime',
  'space.member': 'space-runtime',
  'space.task.postApproval': 'space-runtime',
  'space.task.worker': 'task-agent-manager',
  'space.task.legacy': 'none',
};

export function resolveSpaceMcpSessionPolicy(
  session: Session,
  context: SpaceMcpSessionPolicyContext = {}
): SpaceMcpSessionPolicy {
  const profile = classifySession(sessionFacts(session, context));
  return {
    kind: profile.kind,
    spaceId: profile.spaceId,
    owner: OWNER_BY_KIND[profile.kind],
    requiredServers: requiredMcpServersFor(profile.kind),
    attachGenericSpaceTools: hasCapability(profile, 'surface.member'),
    attachCoordinatorTools: hasCapability(profile, 'surface.console'),
    attachLongTermAgentTools: hasCapability(profile, 'surface.longHorizonAgent'),
    isWorkflowWorker: hasCapability(profile, 'surface.workflowNode'),
  };
}

function sessionFacts(session: Session, context: SpaceMcpSessionPolicyContext): SessionFacts {
  const spaceId = session.context?.spaceId;
  const taskId = session.context?.taskId;
  const agentId = session.metadata.promptProvenance?.agentId;
  const isWorkflowWorker = resolveWorkflowExecution(session, context.nodeExecutionRepo) !== null;
  const taskSpaceId =
    isWorkflowWorker && taskId
      ? (context.taskRepo?.getTask?.(taskId)?.spaceId ?? undefined)
      : undefined;
  return {
    sessionId: session.id,
    sessionType: session.type ?? 'worker',
    ...(spaceId ? { spaceId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskSpaceId ? { taskSpaceId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentId && spaceId && isLongTermAgentSession(session, spaceId)
      ? { isCanonicalAgentSession: true }
      : {}),
    ...(isWorkflowWorker ? { isWorkflowWorker: true } : {}),
  };
}

function resolveWorkflowExecution(
  session: Session,
  nodeExecutionRepo: SpaceMcpSessionPolicyContext['nodeExecutionRepo']
) {
  const bySessionId = nodeExecutionRepo?.getByAgentSessionId?.(session.id) ?? null;
  if (bySessionId) return bySessionId;

  const executionId = parseExecutionIdFromSubSessionId(session.id);
  if (!executionId) return null;

  return nodeExecutionRepo?.getById?.(executionId) ?? null;
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
