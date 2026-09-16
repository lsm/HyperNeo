import type { DaemonInternalEventMap, InternalEventPayload } from '../internal-event-bus.ts';
import type { ChannelRouterConfig } from './channel-router.ts';

interface WorkflowRunReopenedEvent {
  kind: 'workflow_run_reopened';
  spaceId: string;
  runId: string;
  fromStatus: 'done' | 'cancelled' | 'blocked';
  reason: string;
  by: string;
  timestamp: string;
}

export async function reopenRun(
  config: Pick<ChannelRouterConfig, 'workflowRunRepo' | 'internalEventBus'>,
  runId: string,
  fromStatus: 'done' | 'cancelled' | 'blocked',
  spaceId: string,
  reason: string,
  by: string
): Promise<void> {
  config.workflowRunRepo.transitionStatus(runId, 'in_progress');
  await safeNotify(config, {
    kind: 'workflow_run_reopened',
    spaceId,
    runId,
    fromStatus,
    reason,
    by,
    timestamp: new Date().toISOString(),
  });
}

async function safeNotify(
  config: Pick<ChannelRouterConfig, 'internalEventBus'>,
  event: WorkflowRunReopenedEvent
): Promise<void> {
  if (!config.internalEventBus) return;
  try {
    await config.internalEventBus.publish('space.workflowRun.reopened', {
      namespaceId: 'global',
      spaceId: event.spaceId,
      runId: event.runId,
      fromStatus: event.fromStatus,
      reason: event.reason,
      by: event.by,
      timestamp: event.timestamp,
    } satisfies DaemonInternalEventMap['space.workflowRun.reopened'] & InternalEventPayload);
  } catch {}
}
