import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SpaceWorkflowManager } from '../workflows/workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import type { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository.ts';
import type { SpaceTaskManager } from '../tasks/task-manager.ts';
import { getWorkflowRunExecutionStatusLabel } from '@hyperneo/shared';
import type { WorkflowRunStatus } from '@hyperneo/shared';
import {
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  hasPendingRetryableHookAction,
  triggerRetryableHookAction,
} from '../hooks/hook-engine.ts';
import { Logger } from '../logger.ts';

const log = new Logger('space-workflow-run-handlers');

function workflowRunAttemptLabel(status: WorkflowRunStatus): string {
  return getWorkflowRunExecutionStatusLabel(status).toLowerCase();
}

export type SpaceWorkflowRunTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceWorkflowRunHandlers(
  messageHub: MessageHub,
  spaceWorkflowManager: SpaceWorkflowManager,
  workflowRunRepo: SpaceWorkflowRunRepository,
  taskManagerFactory: SpaceWorkflowRunTaskManagerFactory,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  artifactRepo: WorkflowRunArtifactRepository,
  hookStateRepo: WorkflowHookStateRepository,
  isQueuedRetryOwner: (runId: string, sessionId: string) => boolean = () => true,
  isQueuedRetryRestorePending: (sessionId: string) => boolean = () => true
): void {
  messageHub.onRequest('spaceWorkflowRun.listArtifacts', async (data) => {
    const params = data as {
      runId: string;
      nodeId?: string;
      artifactType?: string;
    };
    if (!params.runId) throw new Error('runId is required');
    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);
    const artifacts = artifactRepo.listByRun(params.runId, {
      nodeId: params.nodeId,
      artifactType: params.artifactType,
    });
    return { artifacts };
  });

  messageHub.onRequest('spaceWorkflowRun.listHookStates', async (data) => {
    const params = data as { runId: string };
    if (!params.runId) throw new Error('runId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const workflow = spaceWorkflowManager.getWorkflowForRun(run);
    const hookStates = hookStateRepo.listByRun(params.runId);

    return {
      hookStates,
      hooks: workflow?.hooks ?? [],
    };
  });

  messageHub.onRequest('spaceWorkflowRun.approveHook', async (data) => {
    const params = data as {
      runId: string;
      hookId: string;
      approved: boolean;
      reason?: string;
    };

    if (!params.runId) throw new Error('runId is required');
    if (!params.hookId) throw new Error('hookId is required');
    if (params.approved === undefined || params.approved === null) {
      throw new Error('approved is required');
    }

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
      throw new Error(
        `Cannot modify hook on a ${workflowRunAttemptLabel(run.status)} workflow run`
      );
    }

    const existing = hookStateRepo.get(params.runId, params.hookId);
    const baseVersion = existing?.version ?? 0;
    const baseLocalState = existing?.localState ?? {};

    const rejectionReason = params.reason?.trim() || 'Rejected by human';
    const updateResult = hookStateRepo.update(params.runId, params.hookId, {
      expectedVersion: baseVersion,
      localState: {
        ...baseLocalState,
        humanApproved: params.approved,
        humanApprovedAt: Date.now(),
        humanRejectionReason: params.approved ? undefined : rejectionReason,
      },
      lastResult: params.approved
        ? {
            type: 'allow',
            message: 'Approved by human',
          }
        : {
            type: 'block',
            reason: rejectionReason,
            message: 'Rejected by human',
          },
      retryCount: 0,
      nextRetryAt: null,
    });

    if (!updateResult) {
      throw new Error('Hook state update failed due to version conflict');
    }

    internalEventBus
      .publish('space.hookState.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        runId: params.runId,
        hookId: params.hookId,
        hookState: updateResult,
      })
      .catch((err) => {
        log.warn('Failed to emit space.hookState.updated:', err);
      });

    return { hookState: updateResult };
  });

  messageHub.onRequest('spaceWorkflowRun.retryHook', async (data) => {
    const params = data as { runId: string; hookId: string };

    if (!params.runId) throw new Error('runId is required');
    if (!params.hookId) throw new Error('hookId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
      throw new Error(`Cannot retry hook on a ${workflowRunAttemptLabel(run.status)} workflow run`);
    }

    const existing = hookStateRepo.get(params.runId, params.hookId);
    const baseVersion = existing?.version ?? 0;
    const queuedAction = existing?.localState?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    const queuedActionKey =
      queuedAction && typeof queuedAction === 'object'
        ? (queuedAction as Record<string, unknown>).actionKey
        : undefined;
    const queuedActionMeta =
      queuedAction && typeof queuedAction === 'object'
        ? (queuedAction as Record<string, unknown>).meta
        : undefined;
    const queuedActionSessionId =
      queuedActionMeta && typeof queuedActionMeta === 'object'
        ? (queuedActionMeta as Record<string, unknown>).sessionId
        : undefined;
    const queuedRetryOwnerCurrent =
      typeof queuedActionSessionId !== 'string' ||
      (isQueuedRetryOwner(run.id, queuedActionSessionId) &&
        isQueuedRetryRestorePending(queuedActionSessionId));
    if (
      typeof queuedActionKey === 'string' &&
      !hasPendingRetryableHookAction(queuedActionKey) &&
      queuedRetryOwnerCurrent
    ) {
      throw new Error(
        'Queued hook retry runtime is not ready; wait for restoration or the current retry to finish'
      );
    }
    const updateResult = hookStateRepo.update(params.runId, params.hookId, {
      expectedVersion: baseVersion,
      localState: {
        ...existing?.localState,
        [QUEUED_RETRYABLE_ACTION_STATE_KEY]: null,
      },
      lastResult: {
        type: 'allow',
        message: 'Retry requested by human',
      },
      retryCount: 0,
      nextRetryAt: null,
    });

    if (!updateResult) {
      throw new Error('Hook state update failed due to version conflict');
    }

    if (typeof queuedActionKey === 'string') {
      triggerRetryableHookAction(queuedActionKey);
    }

    internalEventBus
      .publish('space.hookState.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        runId: params.runId,
        hookId: params.hookId,
        hookState: updateResult,
      })
      .catch((err) => {
        log.warn('Failed to emit space.hookState.updated:', err);
      });

    return { hookState: updateResult };
  });
}
