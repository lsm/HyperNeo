import { POST_APPROVAL_COMPLETION_INSTRUCTIONS } from '@hyperneo/prompts';
import type {
  SpaceTask,
  SpaceWorkflow,
  SpaceApprovalSource,
  UpdateSpaceTaskParams,
  PostApprovalRoute,
} from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import {
  interpolatePostApprovalTemplate,
  type PostApprovalTemplateContext,
} from '../workflows/post-approval-template';
import { Logger } from '../../logger';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';

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
  taskRepo: Pick<SpaceTaskRepository, 'updateTask' | 'getTask'>;
  spawner: PostApprovalSubSessionSpawner;
  livenessProbe?: SessionLivenessProbe;
  resolveCompletionOutcome?: (task: SpaceTask) => UpdateSpaceTaskParams | null;
  goalService?: Pick<import('../goals/goal-service').SpaceGoalService, 'handleTaskTerminal'>;
  evolutionScopeService?: Pick<
    import('../evolution-scope-service').EvolutionScopeService,
    'captureCompletedTaskEvidence'
  >;
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
      try {
        const handled = this.deps.goalService?.handleTaskTerminal(task.id, {
          fromStatus: task.status,
          updates,
        });
        if (!handled) {
          this.deps.taskRepo.updateTask(task.id, updates);
        }
      } catch (err) {
        log.warn(
          `Goal terminal handling threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
        );
        this.deps.taskRepo.updateTask(task.id, updates);
      }
      try {
        this.deps.evolutionScopeService?.captureCompletedTaskEvidence({ taskId: task.id });
      } catch (err) {
        log.warn(
          `Forge evidence capture threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
        );
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

    if (task.postApprovalSessionId) {
      const alive = this.deps.livenessProbe
        ? this.deps.livenessProbe.isSessionAlive(task.postApprovalSessionId)
        : true;
      if (alive) {
        log.info(
          `PostApprovalRouter.route: task ${task.id} already has live post-approval session ${task.postApprovalSessionId}; skipping re-dispatch`
        );
        return {
          mode: 'already-routed',
          postApprovalSessionId: task.postApprovalSessionId,
        };
      }
    }

    if (!workflow) {
      const reason = `task ${task.id}: cannot spawn post-approval sub-session without workflow`;
      log.warn(`PostApprovalRouter.route: ${reason}`);
      clearPendingCompletionState(this.deps.taskRepo, task.id);
      return { mode: 'skipped', reason };
    }

    const route = dispatchable[0]!;
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
    const { sessionId } = await this.deps.spawner.spawnPostApprovalSubSession({
      task,
      workflow,
      targetAgent: route.targetAgent!,
      kickoffMessage,
    });

    this.deps.taskRepo.updateTask(task.id, {
      pendingCheckpointType: null,
      pendingCompletionSubmittedByNodeId: null,
      pendingCompletionSubmittedAt: null,
      pendingCompletionReason: null,
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: startedAt,
      postApprovalBlockedReason: null,
    });

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
