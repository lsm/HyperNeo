import type { SpaceTask } from '@hyperneo/shared';
import { resolveNodeAgents } from '@hyperneo/shared';
import type { NodeExecution } from '@hyperneo/shared';
import {
  runTemplateResolves,
  runTemplateSnapshotRecord,
} from '../space/workflows/run-template-snapshot.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { ChannelCycleRepository } from '../../storage/repositories/channel-cycle-repository.ts';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../space/managers/space-workflow-manager.ts';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../space/managers/node-execution-manager.ts';
import type { InternalEventBus, DaemonInternalEventMap } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import {
  MissingWorkflowAgentError,
  PermanentSpawnError,
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
  formatMissingTemplateReference,
  validateExecutionAgainstWorkflow,
} from '../space/runtime/workflow-node-execution-validation.ts';
import { reopenRun } from './activation-reopen.ts';
import { deadLoopReason, isDeadLoopReached, notifyDeadLoop } from './channel-cycle-bookkeeping.ts';
import {
  findMatchingWorkflowChannel,
  findNodeByAgentName,
  getPostApprovalTargetAgents,
  isChannelCyclicByIndex,
} from './channel-matching.ts';

const log = new Logger('channel-router');

export interface GateResult {
  allowed: boolean;
  reason?: string;
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
  agentExists: (agentId: string) => boolean;
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
      await reopenRun(
        this.config,
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
    const templateResolves = (key: string): boolean => runTemplateResolves(workflow, run, key);
    const missingAgent = findMissingNodeAgentReferences(
      node,
      (id) => this.config.agentExists(id),
      targetAgentName
        ? { slotNames: new Set([targetAgentName]), templateResolves }
        : { templateResolves }
    );
    if (missingAgent.length > 0) {
      const first = missingAgent[0];
      throw new MissingWorkflowAgentError(
        first.templateKey
          ? formatMissingTemplateReference({
              runId,
              nodeLabel: node.name,
              workflowName: workflow.name,
              agentName: first.agentName,
              templateKey: first.templateKey,
              hasSnapshot: runTemplateSnapshotRecord(workflow, run) !== null,
            })
          : formatMissingAgentReference({
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
        agentId: agentEntry.templateKey?.trim() ? null : (agentEntry.agentId ?? null),
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

    const match = findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    if (!match) {
      return { allowed: true };
    }
    const { index } = match;

    const channelIsCyclic = isChannelCyclicByIndex(index, workflow);

    if (channelIsCyclic && isDeadLoopReached(this.config, runId, index)) {
      return { allowed: false, reason: deadLoopReason(fromRole, toTarget) };
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

    const match = findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    const channel = match?.channel;
    const channelIndex = match?.index ?? -1;
    const channelIsCyclic = match ? isChannelCyclicByIndex(channelIndex, workflow) : false;

    let targetNode = findNodeByAgentName(workflow, toTarget);
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
        await notifyDeadLoop(
          this.config,
          this.deadLoopNotifiedAt,
          run.spaceId,
          runId,
          fromRole,
          toTarget,
          channelIndex,
          reservation.recentCount
        );
        throw new ActivationError(deadLoopReason(fromRole, toTarget));
      }
      this.deadLoopNotifiedAt.delete(`${runId}:${channelIndex}`);
    }

    const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
    let activatedTasks: SpaceTask[] | undefined;

    const postApprovalTargetAgents = getPostApprovalTargetAgents(workflow);
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

  private isParentTaskArchived(runId: string): boolean {
    const tasks = this.config.taskRepo.listByWorkflowRunIncludingArchived(runId);
    if (tasks.length === 0) return false;
    return tasks.every((t) => t.archivedAt != null);
  }
}
