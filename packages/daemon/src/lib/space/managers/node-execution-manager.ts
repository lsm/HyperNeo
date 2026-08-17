/**
 * NodeExecutionManager - Workflow-internal execution state management
 *
 * Handles:
 * - Node execution status transitions with validation
 * - Per-execution lifecycle status checks
 * - Agent session tracking per node execution
 *
 * This separates workflow-internal state from the user-facing SpaceTask.
 *
 * Note on "terminal" semantics: `TERMINAL_NODE_EXECUTION_STATUSES` describes
 * the terminal lifecycle of a single node-execution instance, NOT workflow
 * completion. Workflow completion is decided exclusively by `SpaceTask.status`
 * (resolved from `task.reportedStatus`); see `CompletionDetector`.
 */

import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type {
  CreateNodeExecutionParams,
  NodeExecution,
  NodeExecutionStatus,
  UpdateNodeExecutionParams,
} from '@hyperneo/shared';
import { isReservedWorkflowAgentName } from './space-workflow-manager';

/**
 * Valid node execution status transitions.
 * Maps current status -> allowed next statuses.
 *
 * Lifecycle:
 *   pending     → in_progress, cancelled
 *   in_progress → idle, waiting_rebind, blocked, pending, cancelled
 *   waiting_rebind → pending, in_progress, blocked, cancelled
 *   idle        → in_progress (reactivation)
 *   blocked     → in_progress (retry), cancelled
 *   cancelled   → in_progress (retry)
 *
 * `in_progress → pending` is the clean-recovery reset (blank session
 * binding, no crash accounting): performed via direct repo updates by
 * `recoverRateLimitedTasks` (passed rate cap) and
 * `SpaceRuntime.parkInFlightExecutionsForSpace` (space stop), so the spawn
 * path re-drives the execution from scratch on the next active tick.
 */
export const VALID_NODE_EXECUTION_TRANSITIONS: Record<NodeExecutionStatus, NodeExecutionStatus[]> =
  {
    pending: ['in_progress', 'cancelled'],
    in_progress: ['idle', 'waiting_rebind', 'blocked', 'pending', 'cancelled'],
    waiting_rebind: ['pending', 'in_progress', 'blocked', 'cancelled'],
    idle: ['in_progress'], // Reactivation — allows re-running a completed node
    blocked: ['in_progress', 'cancelled'],
    cancelled: ['in_progress'], // Retry
  };

/**
 * Terminal statuses for a single node-execution instance — the agent's
 * current turn has ended and no further processing will occur for this
 * execution row until it is reactivated (via cyclic re-entry) or replaced.
 *
 * IMPORTANT: This set is about the per-execution lifecycle ONLY. It does
 * NOT imply workflow completion. A node going `idle` after sending a
 * message back through a cyclic channel is not "done" — the workflow may
 * continue iterating. Workflow completion is decided exclusively by
 * `SpaceTask.status` being set to a terminal value (resolved from
 * `task.reportedStatus`); see `CompletionDetector`.
 *
 * Used by:
 * - `ChannelRouter.activateNode` — to decide whether an existing execution
 *   should be reactivated rather than replaced.
 * - `ChannelRouter.getActiveExecutionsForNode` — to filter out finished
 *   executions when checking whether a node is currently active.
 */
export const TERMINAL_NODE_EXECUTION_STATUSES = new Set<NodeExecutionStatus>(['idle', 'cancelled']);

/**
 * Check if a node execution status transition is valid.
 */
export function isValidNodeExecutionTransition(
  from: NodeExecutionStatus,
  to: NodeExecutionStatus
): boolean {
  return VALID_NODE_EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Check if a node execution status is terminal for the per-execution
 * lifecycle (not workflow completion — see {@link TERMINAL_NODE_EXECUTION_STATUSES}).
 */
export function isNodeExecutionTerminal(status: NodeExecutionStatus): boolean {
  return TERMINAL_NODE_EXECUTION_STATUSES.has(status);
}

export class NodeExecutionManager {
  private repo: NodeExecutionRepository;

  constructor(private db: BunDatabase) {
    this.repo = new NodeExecutionRepository(db);
  }

  /**
   * Get a node execution by ID.
   */
  getById(id: string): NodeExecution | null {
    return this.repo.getById(id);
  }

  /**
   * List all node executions for a workflow run.
   */
  listByWorkflowRun(workflowRunId: string): NodeExecution[] {
    return this.repo.listByWorkflowRun(workflowRunId);
  }

  /**
   * List node executions for a specific node within a workflow run.
   */
  listByNode(workflowRunId: string, workflowNodeId: string): NodeExecution[] {
    return this.repo.listByNode(workflowRunId, workflowNodeId);
  }

  /**
   * Create a node execution after validating reserved built-in agent names.
   */
  create(params: CreateNodeExecutionParams): NodeExecution {
    this.assertAgentNameAllowed(params.agentName);
    return this.repo.create(params);
  }

  /**
   * Create a node execution if absent after validating reserved built-in agent names.
   */
  createOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
    this.assertAgentNameAllowed(params.agentName);
    return this.repo.createOrIgnore(params);
  }

  /**
   * Update a node execution with partial updates.
   */
  update(id: string, params: UpdateNodeExecutionParams): NodeExecution | null {
    return this.repo.update(id, params);
  }

  /**
   * Transition a node execution to a new status with validation.
   *
   * @throws {Error} when the transition is invalid or the execution is not found.
   */
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

  /**
   * Update the agent session ID for a node execution.
   */
  setAgentSessionId(id: string, agentSessionId: string | null): NodeExecution | null {
    return this.repo.updateSessionId(id, agentSessionId);
  }

  /**
   * Delete a node execution by ID.
   */
  delete(id: string): boolean {
    return this.repo.delete(id);
  }

  /**
   * Delete all node executions for a workflow run.
   */
  deleteByWorkflowRun(workflowRunId: string): void {
    this.repo.deleteByWorkflowRun(workflowRunId);
  }

  private assertAgentNameAllowed(agentName: string): void {
    if (isReservedWorkflowAgentName(agentName)) {
      throw new Error(`Agent name "${agentName}" is reserved for a built-in agent`);
    }
  }
}
