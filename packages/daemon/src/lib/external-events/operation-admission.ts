import type { Session } from '@hyperneo/shared';
import type { OperationCaller, OperationCallerRole } from '../operations/registry.ts';
import {
  resolveWorkflowExecution,
  type SpaceMcpSessionPolicyContext,
} from '../space/runtime/space-mcp-session-policy.ts';

export type EventCallerRejection = 'caller_denied';

export const EXTERNAL_EVENT_READ_ROLES: readonly OperationCallerRole[] = [
  'ad_hoc_member',
  'long_term_agent',
  'workflow_worker',
];

export const NODE_EVENT_ROLES: readonly OperationCallerRole[] = ['workflow_worker'];

export interface EventCallerDependencies extends SpaceMcpSessionPolicyContext {
  getSession: (sessionId: string) => Session | null;
}

export function admitEventCallerSpace(
  input: { spaceId?: string },
  caller: OperationCaller,
  roles: readonly OperationCallerRole[]
): { value: string } | { reason: EventCallerRejection } {
  if (caller.source !== 'mcp') {
    return input.spaceId ? { value: input.spaceId } : { reason: 'caller_denied' };
  }
  if (!caller.role || !roles.includes(caller.role) || !caller.spaceId) {
    return { reason: 'caller_denied' };
  }
  if (input.spaceId !== undefined && input.spaceId !== caller.spaceId) {
    return { reason: 'caller_denied' };
  }
  return { value: caller.spaceId };
}

export interface WorkerNodeSlot {
  workflowRunId: string;
  nodeId: string;
  agentName: string;
  taskId: string | undefined;
}

export function resolveWorkerNodeSlot(
  caller: OperationCaller,
  deps: EventCallerDependencies
): WorkerNodeSlot | null {
  if (caller.source !== 'mcp' || caller.role !== 'workflow_worker' || !caller.sessionId) {
    return null;
  }
  const session = deps.getSession(caller.sessionId);
  if (!session) return null;
  const execution = resolveWorkflowExecution(session, deps.nodeExecutionRepo);
  if (!execution) return null;
  return {
    workflowRunId: execution.workflowRunId,
    nodeId: execution.workflowNodeId,
    agentName: execution.agentName,
    taskId: session.context?.taskId,
  };
}
