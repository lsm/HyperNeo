import {
  DEAD_LOOP_THRESHOLD,
  DEAD_LOOP_WINDOW_MS,
} from '../../storage/repositories/channel-cycle-repository.ts';
import type { DaemonInternalEventMap, InternalEventPayload } from '../internal-event-bus.ts';
import type { ChannelRouterConfig } from './channel-router.ts';

export function isDeadLoopReached(
  config: Pick<ChannelRouterConfig, 'channelCycleRepo'>,
  runId: string,
  channelIndex: number
): boolean {
  if (!config.channelCycleRepo) return false;
  return config.channelCycleRepo.isDeadLoopReached(runId, channelIndex);
}

export function deadLoopReason(fromRole: string, toTarget: string): string {
  const windowMin = Math.round(DEAD_LOOP_WINDOW_MS / 60000);
  return (
    `Cyclic channel from "${fromRole}" to "${toTarget}" is in a dead loop: ` +
    `${DEAD_LOOP_THRESHOLD} message round-trips within ${windowMin} minute(s). ` +
    `Spread the exchange out or break the loop.`
  );
}

export async function notifyDeadLoop(
  config: Pick<ChannelRouterConfig, 'internalEventBus'>,
  deadLoopNotifiedAt: Map<string, number>,
  spaceId: string,
  runId: string,
  fromRole: string,
  toTarget: string,
  channelIndex: number,
  recentCount: number
): Promise<void> {
  if (!config.internalEventBus) return;
  const key = `${runId}:${channelIndex}`;
  const now = Date.now();
  const last = deadLoopNotifiedAt.get(key);
  if (last !== undefined && now - last < DEAD_LOOP_WINDOW_MS) return;
  try {
    await config.internalEventBus.publish('space.workflowRun.deadLoop', {
      namespaceId: 'global',
      spaceId,
      runId,
      fromAgent: fromRole,
      toTarget,
      channelIndex,
      recentCount,
      threshold: DEAD_LOOP_THRESHOLD,
      windowMs: DEAD_LOOP_WINDOW_MS,
      reason: deadLoopReason(fromRole, toTarget),
      timestamp: new Date(now).toISOString(),
    } satisfies DaemonInternalEventMap['space.workflowRun.deadLoop'] & InternalEventPayload);
    deadLoopNotifiedAt.set(key, now);
  } catch {}
}
