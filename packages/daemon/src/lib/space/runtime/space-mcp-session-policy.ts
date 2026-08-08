import type { Session } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { longTermAgentSessionId } from '../long-term-agent-session';
import { isDesignatedMergerSession, MERGE_PR_TOOL } from './post-approval-tool-invariant';

export type SpaceMcpSessionRole =
  | 'coordinator'
  | 'ad_hoc_member'
  | 'workflow_worker'
  | 'long_term_agent'
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
  /** Fully-qualified tools that must be callable (server present AND not disallowed). */
  readonly requiredTools?: readonly string[];
  readonly attachGenericSpaceTools: boolean;
  readonly attachCoordinatorTools: boolean;
  readonly attachLongTermAgentTools: boolean;
  readonly isWorkflowWorker: boolean;
}

export const SPACE_COORDINATOR_REQUIRED_MCP_SERVERS = ['space-agent-tools'] as const;
export const SPACE_AD_HOC_MEMBER_REQUIRED_MCP_SERVERS = ['space-agent-tools'] as const;
export const SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS = ['node-agent'] as const;
/**
 * A workflow worker that is simultaneously a task's designated post-approval
 * merger (e.g. a reused `:exec:` session the PostApprovalRouter injected the
 * merge kickoff into) needs `space-agent-tools` in addition to `node-agent`,
 * because it hosts the deterministic `merge_pr` gate the merger procedure
 * mandates. See {@link resolveSpaceMcpSessionPolicy} (#879).
 */
export const SPACE_DESIGNATED_MERGER_REQUIRED_MCP_SERVERS = [
  'node-agent',
  'space-agent-tools',
] as const;

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
    // A workflow worker that is THIS task's designated post-approval MERGER —
    // a reused `:exec:` session the PostApprovalRouter injected the merge
    // kickoff into — additionally requires `space-agent-tools`, which hosts the
    // deterministic `merge_pr` gate the merger's procedure mandates. This is
    // gated on BOTH `postApprovalSessionId === session.id` AND an explicitly
    // TRUE `postApprovalRequiresMerge` (see isDesignatedMergerSession): the
    // router/spawner stamp `postApprovalSessionId` for every dispatched route
    // (not just merges), so the merge-gate flag is what distinguishes a genuine
    // merge route. Without this precision a non-merge reused post-approval
    // worker would be mis-classified as requiring `space-agent-tools` and the
    // invariant would throw (#879 P1-2). A NULL flag (legacy row predating
    // migration 179) reads as "not the merger" here; rehydrateSubSession
    // lazy-derives + persists such rows so this branch sees TRUE for them on
    // every turn after the restart restore.
    // `attachGenericSpaceTools` is true so `ensureMemberSpaceMcpInvariant`
    // enforces the server AND `reattachMemberSpaceTools` can self-heal it.
    //
    // NOTE: the spawner stamps the role durably BEFORE the kickoff and eagerly
    // attaches `space-agent-tools`, so this check is TRUE from the very first
    // turn; this branch then re-affirms it on every subsequent turn and pairs
    // with the rehydrate path for post-restart restore.
    const isDesignatedMerger = isDesignatedMergerSession(task, session.id);
    return {
      role: 'workflow_worker',
      spaceId: resolvedSpaceId,
      owner: 'task-agent-manager',
      requiredServers: isDesignatedMerger
        ? SPACE_DESIGNATED_MERGER_REQUIRED_MCP_SERVERS
        : SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS,
      // #879 (3741142853): the invariant must ALSO verify the qualified tool is
      // callable, not just that `space-agent-tools` is present — a live
      // `config.tools.update` that adds an exact/wildcard disallowedTools entry
      // removes `merge_pr` while the server map is unchanged, and a
      // server-only check would let the degraded merger turn start.
      requiredTools: isDesignatedMerger ? [MERGE_PR_TOOL] : undefined,
      attachGenericSpaceTools: isDesignatedMerger,
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
