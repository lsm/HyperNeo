import { POST_APPROVAL_COMPLETION_INSTRUCTIONS } from '@hyperneo/prompts';
import type {
  SpaceTask,
  SpaceWorkflow,
  SpaceApprovalSource,
  UpdateSpaceTaskParams,
  PostApprovalRoute,
} from '@hyperneo/shared';
import { resolveNodeAgents } from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import {
  interpolatePostApprovalTemplate,
  type PostApprovalTemplateContext,
} from '../workflows/post-approval-template.ts';
import { Logger } from '../../logger.ts';
import {
  isSpawnSupersededError,
  isTransientSpawnError,
} from './workflow-node-execution-validation.ts';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator.ts';

const log = new Logger('post-approval-router');

export const POST_APPROVAL_ROUTING_FLAG_ENV = 'HYPERNEO_TASK_AGENT_POST_APPROVAL_ROUTING';

export function isPostApprovalRoutingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const raw = env[POST_APPROVAL_ROUTING_FLAG_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

export interface PostApprovalSubSessionSpawner {
  spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
  }): Promise<{ sessionId: string }>;
}

export interface SessionLivenessProbe {
  isSessionAlive(sessionId: string): boolean;
}

export interface PostApprovalRouterDeps {
  taskRepo: Pick<SpaceTaskRepository, 'updateTask' | 'getTask' | 'casPostApprovalRouting'>;
  spawner: PostApprovalSubSessionSpawner;
  livenessProbe?: SessionLivenessProbe;
  resolveCompletionOutcome?: (task: SpaceTask) => UpdateSpaceTaskParams | null;
  goalService?: Pick<import('../goals/goal-service.ts').SpaceGoalService, 'handleTaskTerminal'>;
  evolutionScopeService?: Pick<
    import('../evolution-scope-service.ts').EvolutionScopeService,
    'captureCompletedTaskEvidence'
  >;
  validateRecordedPointer?: (args: {
    sessionId: string;
    taskId: string;
    routeNodeId: string | null;
    routeAgentName: string;
    workflowRunId: string | null;
  }) => boolean;
  cancelSpawnedWorker?: (sessionId: string) => void;
}

export interface PostApprovalRouteContext extends PostApprovalTemplateContext {
  approvalSource: SpaceApprovalSource;
  reviewerName?: string;
  spaceId?: string;
  workspacePath?: string;
  autonomyLevel?: number;
}

export type PostApprovalRouteResult =
  | { mode: 'no-route'; taskStatus: 'done' }
  | {
      mode: 'spawn';
      postApprovalSessionId: string;
      postApprovalStartedAt: number;
      missingKeys: string[];
    }
  | { mode: 'already-routed'; postApprovalSessionId: string }
  | { mode: 'skipped'; reason: string };

export function appendPostApprovalCompletionInstructions(interpolatedInstructions: string): string {
  const trimmed = interpolatedInstructions.trim();
  return `${trimmed}\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`;
}

export function collectPostApprovalRoutes(workflow: SpaceWorkflow | null): PostApprovalRoute[] {
  if (!workflow) return [];
  const nodeRoutes = workflow.nodes
    .map((node) => node.postApproval)
    .filter((route): route is PostApprovalRoute => !!route);
  if (nodeRoutes.length > 0) return nodeRoutes;
  return workflow.postApproval ? [workflow.postApproval] : [];
}

export function collectDispatchablePostApprovalRoutes(
  workflow: SpaceWorkflow | null
): PostApprovalRoute[] {
  return collectPostApprovalRoutes(workflow).filter(
    (route) => route.targetAgent && route.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET
  );
}

export function selectFirstDispatchablePostApprovalRoute(
  workflow: SpaceWorkflow | null
): { route: PostApprovalRoute; nodeId: string | null } | null {
  if (!workflow) return null;
  let selected: PostApprovalRoute | null = null;
  let declaredByNodeId: string | null = null;
  for (const node of workflow.nodes) {
    const route = node.postApproval;
    if (route?.targetAgent && route.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) {
      selected = route;
      declaredByNodeId = node.id;
      break;
    }
  }
  if (!selected) {
    const legacy = workflow.postApproval;
    if (legacy?.targetAgent && legacy.targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) {
      selected = legacy;
    }
  }
  if (!selected) return null;
  const targetAgent = selected.targetAgent;
  for (const node of workflow.nodes) {
    let ownsTarget = false;
    try {
      ownsTarget = resolveNodeAgents(node).some(
        (agent) => agent.name === targetAgent || agent.agentId === targetAgent
      );
    } catch {
      continue;
    }
    if (ownsTarget) return { route: selected, nodeId: node.id };
  }
  return { route: selected, nodeId: declaredByNodeId };
}

export function clearPendingCompletionState(
  taskRepo: Pick<SpaceTaskRepository, 'updateTask'>,
  taskId: string
): void {
  taskRepo.updateTask(taskId, {
    pendingCheckpointType: null,
    pendingCompletionSubmittedByNodeId: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
  });
}

export function mapPostApprovalDispatchWarning(detail: string): string {
  const trimmed = (detail ?? '').trim();
  const lower = trimmed.toLowerCase();
  const interrupted =
    lower.includes('interrupted') || lower.includes('abort') || lower.includes('cancel');
  const cause = interrupted
    ? `post-approval dispatch was interrupted (${trimmed})`
    : `post-approval dispatch hit an error: ${trimmed}`;
  return `Approval recorded, but ${cause}. The task is approved; you may need to manually trigger post-approval work.`;
}

export class PostApprovalRouter {
  constructor(private readonly deps: PostApprovalRouterDeps) {}

  private approvalGenerationHolds(task: SpaceTask): boolean {
    const fresh = this.deps.taskRepo.getTask(task.id);
    return (
      fresh?.status === 'approved' &&
      fresh.workflowRunId === task.workflowRunId &&
      fresh.approvedAt === task.approvedAt &&
      fresh.postApprovalSessionId === task.postApprovalSessionId
    );
  }

  private recordBlockedReasonIfCurrent(task: SpaceTask, reason: string): void {
    if (!this.approvalGenerationHolds(task)) return;
    this.deps.taskRepo.updateTask(task.id, {
      postApprovalBlockedReason: reason,
      pendingCheckpointType: null,
      pendingCompletionSubmittedByNodeId: null,
      pendingCompletionSubmittedAt: null,
      pendingCompletionReason: null,
    });
  }

  async route(
    task: SpaceTask,
    workflow: SpaceWorkflow | null,
    context: PostApprovalRouteContext
  ): Promise<PostApprovalRouteResult> {
    if (task.status !== 'approved') {
      const reason = `task ${task.id} is not in 'approved' (status=${task.status}); router will not dispatch`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      return { mode: 'skipped', reason };
    }

    const sourceNodeId = task.postApprovalSourceNodeId || workflow?.endNodeId || null;

    const allRoutes = collectPostApprovalRoutes(workflow);
    const dispatchable: PostApprovalRoute[] = [];
    for (const candidate of allRoutes) {
      if (!candidate.targetAgent) continue;
      if (candidate.targetAgent === POST_APPROVAL_TASK_AGENT_TARGET) {
        log.warn(
          `PostApprovalRouter.route: task ${task.id} has a legacy task-agent post-approval target; skipping that route`
        );
        continue;
      }
      dispatchable.push(candidate);
    }

    if (dispatchable.length === 0) {
      const outcomeUpdates = this.deps.resolveCompletionOutcome?.(task) ?? null;
      const updates: UpdateSpaceTaskParams = {
        ...outcomeUpdates,
        status: 'done',
        completedAt: Date.now(),
        pendingCheckpointType: null,
        pendingCompletionSubmittedByNodeId: sourceNodeId,
        pendingCompletionSubmittedAt: null,
        pendingCompletionReason: null,
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
        postApprovalSourceNodeId: null,
      };
      let terminalHandled = false;
      try {
        const handled = this.deps.goalService?.handleTaskTerminal(task.id, {
          fromStatus: task.status,
          updates,
        });
        terminalHandled = handled != null;
        if (!handled) {
          this.deps.taskRepo.updateTask(task.id, updates);
        }
      } catch (err) {
        log.warn(
          `Goal terminal handling threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
      if (!terminalHandled) {
        try {
          this.deps.evolutionScopeService?.captureCompletedTaskEvidence({ taskId: task.id });
        } catch (err) {
          log.warn(
            `Forge evidence capture threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      log.info(
        `post-approval.route: spaceId=${task.spaceId} taskId=${task.id} sourceNodeId=${sourceNodeId ?? 'none'} routes=0 mode=none autonomyLevel=${context.autonomyLevel ?? 'unknown'}`
      );
      log.info(
        `task.status-transition: taskId=${task.id} from=approved to=done source=no-post-approval`
      );
      return { mode: 'no-route', taskStatus: 'done' };
    }

    if (dispatchable.length > 1) {
      log.warn(
        `PostApprovalRouter.route: task ${task.id} declares ${dispatchable.length} post-approval routes; multi-route fan-out is not supported. Only the first (targetAgent=${dispatchable[0]?.targetAgent}) will dispatch — extras ignored.`
      );
    }

    const selected = selectFirstDispatchablePostApprovalRoute(workflow);
    let staleReplacedSessionId: string | null = null;

    if (task.postApprovalSessionId) {
      const alive = this.deps.livenessProbe
        ? this.deps.livenessProbe.isSessionAlive(task.postApprovalSessionId)
        : true;
      if (alive) {
        const onRouteSlot = this.deps.validateRecordedPointer
          ? this.deps.validateRecordedPointer({
              sessionId: task.postApprovalSessionId,
              taskId: task.id,
              routeNodeId: selected?.nodeId ?? null,
              routeAgentName: selected?.route.targetAgent ?? '',
              workflowRunId: task.workflowRunId ?? null,
            })
          : true;
        if (onRouteSlot) {
          log.info(
            `PostApprovalRouter.route: task ${task.id} already has live post-approval session ${task.postApprovalSessionId}; skipping re-dispatch`
          );
          if (task.postApprovalBlockedReason && this.approvalGenerationHolds(task)) {
            this.deps.taskRepo.updateTask(task.id, { postApprovalBlockedReason: null });
          }
          return {
            mode: 'already-routed',
            postApprovalSessionId: task.postApprovalSessionId,
          };
        }
        staleReplacedSessionId = task.postApprovalSessionId;
        log.warn(
          `PostApprovalRouter.route: task ${task.id} recorded pointer ${task.postApprovalSessionId} is not a worker on the post-approval route slot (targetAgent=${selected?.route.targetAgent ?? 'unknown'}); treating it as stale and re-dispatching`
        );
      }
    }

    if (!workflow) {
      const reason = `task ${task.id}: cannot spawn post-approval sub-session without workflow`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      clearPendingCompletionState(this.deps.taskRepo, task.id);
      return { mode: 'skipped', reason };
    }

    const route = selected?.route ?? dispatchable[0]!;
    const { text: interpolatedInstructions, missingKeys } = interpolatePostApprovalTemplate(
      route.instructions ?? '',
      context
    );
    if (missingKeys.length > 0) {
      log.warn(
        `PostApprovalRouter.route: task ${task.id} kickoff referenced unknown keys: ${missingKeys.join(', ')}`
      );
    }
    if (!interpolatedInstructions.trim()) {
      const reason = `task ${task.id}: post-approval route (targetAgent=${route.targetAgent}) has an empty instructions template`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      clearPendingCompletionState(this.deps.taskRepo, task.id);
      return { mode: 'skipped', reason };
    }

    const startedAt = Date.now();
    const kickoffMessage = appendPostApprovalCompletionInstructions(interpolatedInstructions);
    let spawnedSessionId: string;
    try {
      ({ sessionId: spawnedSessionId } = await this.deps.spawner.spawnPostApprovalSubSession({
        task,
        workflow,
        targetAgent: route.targetAgent!,
        kickoffMessage,
      }));
    } catch (err) {
      if (isSpawnSupersededError(err)) {
        const reason = `post-approval spawn for task ${task.id} superseded at ${err.stage ?? 'unknown'} — a concurrent writer moved the guarded row; the dispatch stays recorded as blocked for retry`;
        log.warn(`PostApprovalRouter.route: ${reason}`);
        this.recordBlockedReasonIfCurrent(task, reason);
        return { mode: 'skipped', reason };
      }
      if (isTransientSpawnError(err)) {
        const reason = `post-approval spawn for task ${task.id} deferred: ${err.message}; the dispatch stays recorded as blocked for retry`;
        log.warn(`PostApprovalRouter.route: ${reason}`);
        this.recordBlockedReasonIfCurrent(task, reason);
        return { mode: 'skipped', reason };
      }
      throw err;
    }
    const sessionId = spawnedSessionId;

    const recorded = this.deps.taskRepo.casPostApprovalRouting(
      task.id,
      {
        workflowRunId: task.workflowRunId ?? null,
        approvedAt: task.approvedAt ?? null,
        priorPostApprovalSessionId: task.postApprovalSessionId ?? null,
      },
      { postApprovalSessionId: sessionId, postApprovalStartedAt: startedAt }
    );
    if (recorded !== 'won') {
      const fresh = this.deps.taskRepo.getTask(task.id);
      if (fresh?.postApprovalSessionId !== sessionId) {
        this.deps.cancelSpawnedWorker?.(sessionId);
      }
      const reason = `post-approval routing for task ${task.id} lost the conditional write (status=${fresh?.status ?? 'missing'}, workflowRunId=${fresh?.workflowRunId ?? 'none'}); spawned worker ${sessionId} cancelled`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      return { mode: 'skipped', reason };
    }
    if (staleReplacedSessionId !== null && staleReplacedSessionId !== sessionId) {
      this.deps.cancelSpawnedWorker?.(staleReplacedSessionId);
    }

    log.info(
      `post-approval.route: spaceId=${task.spaceId} taskId=${task.id} sourceNodeId=${sourceNodeId ?? 'none'} routes=${dispatchable.length} dispatched=1 mode=spawn autonomyLevel=${context.autonomyLevel ?? 'unknown'} sessionId=${sessionId}`
    );
    return {
      mode: 'spawn',
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: startedAt,
      missingKeys,
    };
  }
}
