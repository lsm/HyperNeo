import type { SpaceTask, SpaceWorkflow, WorkflowChannel, WorkflowNode } from '@hyperneo/shared';
import { resolveNodeAgents, isChannelCyclic } from '@hyperneo/shared';
import type { NodeExecution } from '@hyperneo/shared';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import {
  DEAD_LOOP_THRESHOLD,
  DEAD_LOOP_WINDOW_MS,
} from '../../../storage/repositories/channel-cycle-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../managers/space-workflow-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import type {
  InternalEventBus,
  DaemonInternalEventMap,
  InternalEventPayload,
} from '../../internal-event-bus';
import { Logger } from '../../logger';
import {
  MissingWorkflowAgentError,
  PermanentSpawnError,
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
  validateExecutionAgainstWorkflow,
} from './workflow-node-execution-validation';

const log = new Logger('channel-router');

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

interface WorkflowRunReopenedEvent {
  kind: 'workflow_run_reopened';
  spaceId: string;
  runId: string;
  fromStatus: 'done' | 'cancelled' | 'blocked';
  reason: string;
  by: string;
  timestamp: string;
}

export interface DeliveredMessage {
  runId: string;
  fromRole: string;
  toRole: string;
  message: string;
  targetNodeId: string;
  isFanOut: boolean;
  activatedTasks?: SpaceTask[];
}

export class ActivationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ActivationError';
  }
}

export const ARCHIVED_TASK_ERROR_MESSAGE = 'This task is archived — create a new task to continue.';

export interface ChannelRouterConfig {
  taskRepo: SpaceTaskRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  workflowManager: SpaceWorkflowManager;
  agentManager: SpaceAgentManager;
  nodeExecutionRepo: NodeExecutionRepository;
  channelCycleRepo?: ChannelCycleRepository;
  isSessionAlive?: (sessionId: string) => boolean;
  findPostApprovalSessionId?: (runId: string) => string | undefined;
  isPostApprovalSessionInMemory?: (sessionId: string) => boolean;
  cancelSessionById?: (sessionId: string) => void;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
}

export class ChannelRouter {
  constructor(private readonly config: ChannelRouterConfig) {}

  private readonly deadLoopNotifiedAt = new Map<string, number>();

  async activateNode(
    runId: string,
    nodeId: string,
    options?: {
      reopenReason?: string;
      reopenBy?: string;
      allowTerminalReopen?: boolean;
      targetAgentName?: string;
    }
  ): Promise<SpaceTask[]> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) {
      throw new ActivationError(`Run not found: ${runId}`);
    }

    if (this.isParentTaskArchived(runId)) {
      throw new ActivationError(ARCHIVED_TASK_ERROR_MESSAGE);
    }

    if (run.status === 'done' || run.status === 'cancelled') {
      if (!options?.allowTerminalReopen) {
        throw new ActivationError(
          `Run ${runId} is ${run.status} — create a new task or use an explicit resume action.`
        );
      }
      await this.reopenRun(
        run.id,
        run.status,
        run.spaceId,
        options?.reopenReason ??
          `inbound activation of node "${nodeId}" on run in status "${run.status}"`,
        options?.reopenBy ?? 'activation'
      );
    }

    const existingTasks = this.getActiveTasksForNode(runId, nodeId);
    if (existingTasks.length > 0) {
      const targetAgentName = options?.targetAgentName;
      if (!targetAgentName) return existingTasks;
      const targetSlotExists = this.config.nodeExecutionRepo
        .listByNode(runId, nodeId)
        .some(
          (e) => e.agentName === targetAgentName && !TERMINAL_NODE_EXECUTION_STATUSES.has(e.status)
        );
      if (targetSlotExists) return existingTasks;
    }

    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    if (!workflow) {
      throw new ActivationError(`Workflow not found: ${run.workflowId}`);
    }
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new ActivationError(`Node "${nodeId}" not found in workflow "${run.workflowId}"`);
    }

    let agents: ReturnType<typeof resolveNodeAgents>;
    try {
      agents = resolveNodeAgents(node);
    } catch (err) {
      throw new ActivationError(
        `Cannot resolve agents for node "${nodeId}": ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    const targetAgentName = options?.targetAgentName;
    const missingAgent = findMissingNodeAgentReferences(
      node,
      (id) => this.config.agentManager.getById(id) !== null,
      targetAgentName ? { slotNames: new Set([targetAgentName]) } : undefined
    );
    if (missingAgent.length > 0) {
      const first = missingAgent[0];
      throw new MissingWorkflowAgentError(
        formatMissingAgentReference({
          runId,
          nodeLabel: node.name,
          agentName: first.agentName,
          agentId: first.agentId,
        }),
        first
      );
    }

    const existingExecutions = this.config.nodeExecutionRepo.listByNode(runId, nodeId);
    const existingByAgentName = new Map(
      existingExecutions.map((execution) => [execution.agentName, execution])
    );

    for (const agentEntry of agents) {
      if (options?.targetAgentName && agentEntry.name !== options.targetAgentName) continue;
      const agentName = agentEntry.name;
      const existing = existingByAgentName.get(agentName);
      if (existing) {
        const validation = validateExecutionAgainstWorkflow(existing, workflow);
        if (!validation.valid) {
          if (existing.agentSessionId) {
            this.config.cancelSessionById?.(existing.agentSessionId);
          }
          this.config.nodeExecutionRepo.update(existing.id, {
            status: 'cancelled',
            result: validation.reason,
            completedAt: Date.now(),
          });
          log.warn(
            `ChannelRouter: cancelled stale workflow node execution ${existing.id}: ${validation.reason}`
          );
          throw new PermanentSpawnError(validation.reason);
        }

        if (TERMINAL_NODE_EXECUTION_STATUSES.has(existing.status)) {
          const sessionId = existing.agentSessionId;
          const probe = this.config.isSessionAlive;
          const sessionAlive = sessionId !== null && (!probe || probe(sessionId));
          if (sessionAlive) {
            this.config.nodeExecutionRepo.update(existing.id, {
              status: 'in_progress',
            });
          } else {
            this.config.nodeExecutionRepo.update(existing.id, {
              status: 'pending',
              result: null,
              startedAt: null,
              completedAt: null,
            });
          }
        }
        continue;
      }
      if (isReservedWorkflowAgentName(agentName)) {
        throw new ActivationError(`Agent name "${agentName}" is reserved for a built-in agent`);
      }
      this.config.nodeExecutionRepo.createOrIgnore({
        workflowRunId: runId,
        workflowNodeId: nodeId,
        agentName,
        agentId: agentEntry.agentId ?? null,
        status: 'pending',
      });
    }

    const canonicalTask = this.getCanonicalTaskForRun(runId);
    return canonicalTask ? [canonicalTask] : [];
  }

  async canDeliver(runId: string, fromRole: string, toTarget: string): Promise<GateResult> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) throw new ActivationError(`Run not found: ${runId}`);

    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    if (!workflow) throw new ActivationError(`Workflow not found: ${run.workflowId}`);

    const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    if (!match) {
      return { allowed: true };
    }
    const { index } = match;

    const channelIsCyclic = this.isChannelCyclicByIndex(index, workflow);

    if (channelIsCyclic && this.isDeadLoopReached(runId, index)) {
      return { allowed: false, reason: this.deadLoopReason(fromRole, toTarget) };
    }

    return { allowed: true };
  }

  getActiveExecutionsForNode(runId: string, nodeId: string): NodeExecution[] {
    return this.config.nodeExecutionRepo
      .listByNode(runId, nodeId)
      .filter((e) => !TERMINAL_NODE_EXECUTION_STATUSES.has(e.status));
  }

  private resolveLivePostApprovalSession(runId: string): string | undefined {
    const sessionId = this.config.findPostApprovalSessionId?.(runId);
    if (!sessionId) return undefined;
    const probe = this.config.isPostApprovalSessionInMemory ?? this.config.isSessionAlive;
    return !probe || probe(sessionId) ? sessionId : undefined;
  }

  private getPostApprovalTargetAgents(workflow: SpaceWorkflow): Set<string> {
    const agents = new Set<string>();
    for (const node of workflow.nodes) {
      const targetAgent = node.postApproval?.targetAgent;
      if (targetAgent && targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) agents.add(targetAgent);
    }
    const legacy = workflow.postApproval?.targetAgent;
    if (legacy && legacy !== POST_APPROVAL_TASK_AGENT_TARGET) agents.add(legacy);
    return agents;
  }

  async deliverMessage(
    runId: string,
    fromRole: string,
    toTarget: string,
    message: string
  ): Promise<DeliveredMessage> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) {
      throw new ActivationError(`Run not found: ${runId}`);
    }

    if (this.isParentTaskArchived(runId)) {
      throw new ActivationError(ARCHIVED_TASK_ERROR_MESSAGE);
    }

    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    if (!workflow) {
      throw new ActivationError(`Workflow not found: ${run.workflowId}`);
    }

    const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    const channel = match?.channel;
    const channelIndex = match?.index ?? -1;
    const channelIsCyclic = match ? this.isChannelCyclicByIndex(channelIndex, workflow) : false;

    let targetNode = this.findNodeByAgentName(workflow, toTarget);
    let isFanOut = false;

    if (!targetNode) {
      const byName = workflow.nodes.find((n) => n.name === toTarget);
      if (byName) {
        targetNode = byName;
        isFanOut = true;
      } else {
        throw new ActivationError(
          `No node found with agent name or node name "${toTarget}" in workflow "${run.workflowId}"`
        );
      }
    }

    if (channelIsCyclic && channel) {
      const reservation = this.config.channelCycleRepo
        ? this.config.channelCycleRepo.reserveCycleEvent(runId, channelIndex)
        : { allowed: true, recentCount: 0 };
      if (!reservation.allowed) {
        await this.notifyDeadLoop(
          run.spaceId,
          runId,
          fromRole,
          toTarget,
          channelIndex,
          reservation.recentCount
        );
        throw new ActivationError(this.deadLoopReason(fromRole, toTarget));
      }
      this.deadLoopNotifiedAt.delete(`${runId}:${channelIndex}`);
    }

    const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
    let activatedTasks: SpaceTask[] | undefined;

    const postApprovalTargetAgents = this.getPostApprovalTargetAgents(workflow);
    const skipForLiveMerger =
      postApprovalTargetAgents.size > 0 &&
      !!this.resolveLivePostApprovalSession(runId) &&
      resolveNodeAgents(targetNode).some((agent) => postApprovalTargetAgents.has(agent.name));

    if (activeTasks.length === 0 && !skipForLiveMerger) {
      activatedTasks = await this.activateNode(runId, targetNode.id, {
        allowTerminalReopen: true,
        reopenBy: `agent:${fromRole}`,
        reopenReason: `peer send_message from "${fromRole}" to "${toTarget}"`,
      });
    }

    return {
      runId,
      fromRole,
      toRole: toTarget,
      message,
      targetNodeId: targetNode.id,
      isFanOut,
      activatedTasks,
    };
  }

  private getActiveTasksForNode(runId: string, nodeId: string): SpaceTask[] {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return [];
    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    const node =
      workflow?.nodes.find((n) => n.id === nodeId) ??
      workflow?.nodes.find((n) => n.name === nodeId);
    if (!node) return [];

    const activeExecutions = this.config.nodeExecutionRepo
      .listByNode(runId, node.id)
      .filter((execution) => !TERMINAL_NODE_EXECUTION_STATUSES.has(execution.status));
    if (activeExecutions.length === 0) return [];

    const canonicalTask = this.getCanonicalTaskForRun(runId);
    return canonicalTask ? [canonicalTask] : [];
  }

  private getCanonicalTaskForRun(runId: string): SpaceTask | null {
    const runTasks = this.config.taskRepo.listByWorkflowRun(runId);
    return runTasks[0] ?? null;
  }

  private findNodeByAgentName(workflow: SpaceWorkflow, role: string): WorkflowNode | undefined {
    for (const node of workflow.nodes) {
      try {
        const agents = resolveNodeAgents(node);
        if (agents.some((a) => a.name === role)) return node;
      } catch {
        // Skip malformed nodes (neither agentId nor agents defined)
      }
    }
    return undefined;
  }

  private findMatchingWorkflowChannel(
    workflow: SpaceWorkflow,
    fromRole: string,
    toTarget: string
  ): { channel: WorkflowChannel; index: number } | undefined {
    const fromNodeName = this.findNodeByAgentName(workflow, fromRole)?.name;
    const toNodeName =
      this.findNodeByAgentName(workflow, toTarget)?.name ??
      workflow.nodes.find((node) => node.name === toTarget)?.name;
    const channels = workflow.channels ?? [];
    const index = channels.findIndex((ch) => {
      if (ch.from !== '*' && ch.from !== fromRole && ch.from !== fromNodeName) return false;
      if (ch.to === '*' || ch.to === toTarget || (!!toNodeName && ch.to === toNodeName))
        return true;
      if (Array.isArray(ch.to)) {
        return ch.to.includes(toTarget) || (!!toNodeName && ch.to.includes(toNodeName));
      }
      return false;
    });
    return index >= 0 ? { channel: channels[index], index } : undefined;
  }

  private isChannelCyclicByIndex(channelIndex: number, workflow: SpaceWorkflow): boolean {
    const channels = workflow.channels ?? [];
    return isChannelCyclic(channelIndex, channels, workflow.nodes);
  }

  private isDeadLoopReached(runId: string, channelIndex: number): boolean {
    if (!this.config.channelCycleRepo) return false;
    return this.config.channelCycleRepo.isDeadLoopReached(runId, channelIndex);
  }

  private deadLoopReason(fromRole: string, toTarget: string): string {
    const windowMin = Math.round(DEAD_LOOP_WINDOW_MS / 60000);
    return (
      `Cyclic channel from "${fromRole}" to "${toTarget}" is in a dead loop: ` +
      `${DEAD_LOOP_THRESHOLD} message round-trips within ${windowMin} minute(s). ` +
      `Spread the exchange out or break the loop.`
    );
  }

  private async notifyDeadLoop(
    spaceId: string,
    runId: string,
    fromRole: string,
    toTarget: string,
    channelIndex: number,
    recentCount: number
  ): Promise<void> {
    if (!this.config.internalEventBus) return;
    const key = `${runId}:${channelIndex}`;
    const now = Date.now();
    const last = this.deadLoopNotifiedAt.get(key);
    if (last !== undefined && now - last < DEAD_LOOP_WINDOW_MS) return;
    try {
      await this.config.internalEventBus.publish('space.workflowRun.deadLoop', {
        namespaceId: 'global',
        spaceId,
        runId,
        fromAgent: fromRole,
        toTarget,
        channelIndex,
        recentCount,
        threshold: DEAD_LOOP_THRESHOLD,
        windowMs: DEAD_LOOP_WINDOW_MS,
        reason: this.deadLoopReason(fromRole, toTarget),
        timestamp: new Date(now).toISOString(),
      } satisfies DaemonInternalEventMap['space.workflowRun.deadLoop'] & InternalEventPayload);
      this.deadLoopNotifiedAt.set(key, now);
    } catch {
      // Swallow — surfacing must not break the delivery path. Dedupe is NOT
      // recorded, so the next blocked send retries the notification.
    }
  }

  private isParentTaskArchived(runId: string): boolean {
    const tasks = this.config.taskRepo.listByWorkflowRunIncludingArchived(runId);
    if (tasks.length === 0) return false;
    return tasks.every((t) => t.archivedAt != null);
  }

  private async reopenRun(
    runId: string,
    fromStatus: 'done' | 'cancelled' | 'blocked',
    spaceId: string,
    reason: string,
    by: string
  ): Promise<void> {
    this.config.workflowRunRepo.transitionStatus(runId, 'in_progress');
    await this.safeNotify({
      kind: 'workflow_run_reopened',
      spaceId,
      runId,
      fromStatus,
      reason,
      by,
      timestamp: new Date().toISOString(),
    });
  }

  private async safeNotify(event: WorkflowRunReopenedEvent): Promise<void> {
    if (!this.config.internalEventBus) return;
    try {
      await this.config.internalEventBus.publish('space.workflowRun.reopened', {
        namespaceId: 'global',
        spaceId: event.spaceId,
        runId: event.runId,
        fromStatus: event.fromStatus,
        reason: event.reason,
        by: event.by,
        timestamp: event.timestamp,
      } satisfies DaemonInternalEventMap['space.workflowRun.reopened'] & InternalEventPayload);
    } catch {
      // Swallow — bus errors must not break message delivery.
    }
  }
}
