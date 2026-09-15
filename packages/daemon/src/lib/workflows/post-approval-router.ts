import type {
  SpaceTask,
  SpaceWorkflow,
  SpaceApprovalSource,
  UpdateSpaceTaskParams,
  PostApprovalRoute,
} from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import {
  interpolatePostApprovalTemplate,
  type PostApprovalTemplateContext,
} from './post-approval-template.ts';
import { Logger } from '../logger.ts';
import { isSpawnSupersededError, isTransientSpawnError } from './node-execution-validation.ts';
import { POST_APPROVAL_TASK_AGENT_TARGET } from './post-approval-validator.ts';
import {
  appendPostApprovalCompletionInstructions,
  clearPendingCompletionState,
  collectPostApprovalRoutes,
  selectFirstDispatchablePostApprovalRoute,
} from './post-approval-route-selection.ts';

export {
  clearPendingCompletionState,
  collectDispatchablePostApprovalRoutes,
  isCoderOwnedMergeWorkflow,
  mapPostApprovalDispatchWarning,
} from './post-approval-route-selection.ts';

const log = new Logger('post-approval-router');

export interface PostApprovalSubSessionSpawner {
  spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
    requireSucceededRun?: boolean;
    expectedApprovedAt?: number | null;
    expectedWorkflowRunId?: string | null;
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
  goalService?: Pick<
    import('../space/goals/goal-service.ts').SpaceGoalService,
    'handleTaskTerminal'
  >;
  evolutionScopeService?: Pick<
    import('../space/evolution-scope-service.ts').EvolutionScopeService,
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
  ownsRecordedPointer?: (args: { sessionId: string; taskId: string }) => boolean;
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
    context: PostApprovalRouteContext,
    routeOptions: {
      requireSucceededRun?: boolean;
      expectedApprovedAt?: number | null;
      expectedWorkflowRunId?: string | null;
    } = {}
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
      if (
        task.postApprovalSessionId &&
        (!this.deps.ownsRecordedPointer ||
          this.deps.ownsRecordedPointer({
            sessionId: task.postApprovalSessionId,
            taskId: task.id,
          }))
      ) {
        this.deps.cancelSpawnedWorker?.(task.postApprovalSessionId);
      }
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
              routeAgentName: selected?.agentName ?? '',
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
        requireSucceededRun: routeOptions.requireSucceededRun,
        expectedApprovedAt: routeOptions.expectedApprovedAt,
        expectedWorkflowRunId: routeOptions.expectedWorkflowRunId,
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
      { postApprovalSessionId: sessionId, postApprovalStartedAt: startedAt },
      {
        requireSucceededRun: routeOptions.requireSucceededRun,
      }
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
    if (
      staleReplacedSessionId !== null &&
      staleReplacedSessionId !== sessionId &&
      (!this.deps.ownsRecordedPointer ||
        this.deps.ownsRecordedPointer({
          sessionId: staleReplacedSessionId,
          taskId: task.id,
        }))
    ) {
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
