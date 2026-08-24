import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type {
  CreateNodeExecutionParams,
  NodeExecution,
  NodeExecutionStatus,
  UpdateNodeExecutionParams,
} from '@hyperneo/shared';
import { isReservedWorkflowAgentName } from './space-workflow-manager.ts';

export const VALID_NODE_EXECUTION_TRANSITIONS: Record<NodeExecutionStatus, NodeExecutionStatus[]> =
  {
    pending: ['in_progress', 'cancelled'],
    in_progress: ['idle', 'waiting_rebind', 'blocked', 'cancelled'],
    waiting_rebind: ['pending', 'in_progress', 'blocked', 'cancelled'],
    idle: ['in_progress'],
    blocked: ['in_progress', 'cancelled'],
    cancelled: ['in_progress'],
  };

export const TERMINAL_NODE_EXECUTION_STATUSES = new Set<NodeExecutionStatus>(['idle', 'cancelled']);

export function isValidNodeExecutionTransition(
  from: NodeExecutionStatus,
  to: NodeExecutionStatus
): boolean {
  return VALID_NODE_EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isNodeExecutionTerminal(status: NodeExecutionStatus): boolean {
  return TERMINAL_NODE_EXECUTION_STATUSES.has(status);
}

export class NodeExecutionManager {
  private repo: NodeExecutionRepository;

  constructor(private db: BunDatabase) {
    this.repo = new NodeExecutionRepository(db);
  }

  getById(id: string): NodeExecution | null {
    return this.repo.getById(id);
  }

  listByWorkflowRun(workflowRunId: string): NodeExecution[] {
    return this.repo.listByWorkflowRun(workflowRunId);
  }

  listByNode(workflowRunId: string, workflowNodeId: string): NodeExecution[] {
    return this.repo.listByNode(workflowRunId, workflowNodeId);
  }

  create(params: CreateNodeExecutionParams): NodeExecution {
    this.assertAgentNameAllowed(params.agentName);
    return this.repo.create(params);
  }

  createOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
    this.assertAgentNameAllowed(params.agentName);
    return this.repo.createOrIgnore(params);
  }

  update(id: string, params: UpdateNodeExecutionParams): NodeExecution | null {
    return this.repo.update(id, params);
  }

  setExecutionStatus(id: string, newStatus: NodeExecutionStatus): NodeExecution {
    const execution = this.repo.getById(id);
    if (!execution) {
      throw new Error(`NodeExecution not found: ${id}`);
    }

    if (!isValidNodeExecutionTransition(execution.status, newStatus)) {
      throw new Error(
        `Invalid node execution status transition from '${execution.status}' to '${newStatus}'. ` +
          `Allowed: ${VALID_NODE_EXECUTION_TRANSITIONS[execution.status].join(', ') || 'none'}`
      );
    }

    const updated = this.repo.updateStatus(id, newStatus);
    if (!updated) {
      throw new Error(`Failed to update node execution: ${id}`);
    }

    return updated;
  }

  setAgentSessionId(id: string, agentSessionId: string | null): NodeExecution | null {
    return this.repo.updateSessionId(id, agentSessionId);
  }

  delete(id: string): boolean {
    return this.repo.delete(id);
  }

  deleteByWorkflowRun(workflowRunId: string): void {
    this.repo.deleteByWorkflowRun(workflowRunId);
  }

  private assertAgentNameAllowed(agentName: string): void {
    if (isReservedWorkflowAgentName(agentName)) {
      throw new Error(`Agent name "${agentName}" is reserved for a built-in agent`);
    }
  }
}
