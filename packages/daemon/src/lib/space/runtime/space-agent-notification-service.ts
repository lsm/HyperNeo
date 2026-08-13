/**
 * SpaceAgentNotificationService — InternalEventBus subscriber for Space runtime events.
 *
 * Listens to selected `SpaceEvents` on the `InternalEventBus` and formats them
 * into structured `[TASK_EVENT]` messages for injection into the Space Agent
 * session.
 *
 * ## Subscribed events
 *
 * All events emitted by `SpaceRuntime` and `ChannelRouter` that require agent
 * notification flow through here. Events that do not require agent notification
 * (e.g. internal bookkeeping) are silently ignored.
 */

import type { SpaceAutonomyLevel } from '@hyperneo/shared/types/space';
import type { InternalEventBus, DaemonInternalEventMap } from '../../internal-event-bus';
import { Logger } from '../../logger';
import type { SessionFactory } from './types';

const log = new Logger('space-agent-notification-service');

export interface SpaceAgentNotificationServiceConfig {
  /** The InternalEventBus to subscribe to. */
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  /** The SessionFactory used to inject messages into sessions. */
  sessionFactory: SessionFactory;
  /**
   * The session ID of the Space Agent's global session (e.g. the `spaces:global`
   * session that receives coordination notifications).
   */
  sessionId: string;
  /**
   * The space ID this service is scoped to. Only events whose `spaceId` matches
   * this value are processed; events for other spaces are silently ignored.
   * This prevents cross-space notification leakage when multiple spaces are active.
   */
  spaceId: string;
  /**
   * The autonomy level for this space. Included in every notification message
   * so the agent has context for how much it can act without human approval.
   *
   * Defaults to `1` (most supervised) if not provided.
   */
  autonomyLevel?: SpaceAutonomyLevel;
}

/**
 * Production subscriber that turns Space runtime domain events into agent-facing
 * messages and injects them into the Space Agent session.
 */
export class SpaceAgentNotificationService {
  private readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  private readonly sessionFactory: SessionFactory;
  private readonly sessionId: string;
  private readonly spaceId: string;
  private readonly autonomyLevel: SpaceAutonomyLevel;
  private unsubscribers: Array<() => void> = [];

  constructor(config: SpaceAgentNotificationServiceConfig) {
    this.internalEventBus = config.internalEventBus;
    this.sessionFactory = config.sessionFactory;
    this.sessionId = config.sessionId;
    this.spaceId = config.spaceId;
    this.autonomyLevel = config.autonomyLevel ?? 1;
  }

  /**
   * Subscribe to all Space runtime events that require agent notification.
   *
   * Call this once after construction. The returned unsubscribe function
   * tears down all subscriptions.
   *
   * Safe to call multiple times — any existing subscriptions are torn down
   * before the new set is registered.
   */
  subscribe(): () => void {
    // Tear down any existing subscriptions to prevent leaks on re-init.
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [
      this.internalEventBus.subscribe(
        'space.task.blocked',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatTaskBlocked(event, this.autonomyLevel));
        },
        { subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.task.blocked` }
      ),
      this.internalEventBus.subscribe(
        'space.workflowRun.blocked',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatWorkflowRunBlocked(event, this.autonomyLevel));
        },
        {
          subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.workflowRun.blocked`,
        }
      ),
      this.internalEventBus.subscribe(
        'space.task.timeout',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatTaskTimeout(event, this.autonomyLevel));
        },
        { subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.task.timeout` }
      ),
      this.internalEventBus.subscribe(
        'space.workflowRun.reopened',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatWorkflowRunReopened(event, this.autonomyLevel));
        },
        {
          subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.workflowRun.reopened`,
        }
      ),
      this.internalEventBus.subscribe(
        'space.workflowRun.deadLoop',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatWorkflowRunDeadLoop(event, this.autonomyLevel));
        },
        {
          subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.workflowRun.deadLoop`,
        }
      ),
      this.internalEventBus.subscribe(
        'space.agent.crashed',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatAgentCrash(event, this.autonomyLevel));
        },
        { subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.agent.crashed` }
      ),
      this.internalEventBus.subscribe(
        'space.workflowRun.retry',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatTaskRetry(event, this.autonomyLevel));
        },
        { subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.workflowRun.retry` }
      ),
      this.internalEventBus.subscribe(
        'space.workflowRun.needsAttention',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatWorkflowRunNeedsAttention(event, this.autonomyLevel));
        },
        {
          subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.workflowRun.needsAttention`,
        }
      ),
      this.internalEventBus.subscribe(
        'space.task.awaitingApproval',
        (event) => {
          if (event.spaceId !== this.spaceId) return;
          void this.notify(formatTaskAwaitingApproval(event, this.autonomyLevel));
        },
        {
          subscriberName: `SpaceAgentNotificationService:${this.spaceId}:space.task.awaitingApproval`,
        }
      ),
    ];

    return () => {
      for (const unsub of this.unsubscribers) {
        unsub();
      }
      this.unsubscribers = [];
    };
  }

  private async notify(message: string): Promise<void> {
    try {
      await this.sessionFactory.injectMessage(this.sessionId, message, {
        deliveryMode: 'defer',
        origin: 'system',
      });
    } catch (err) {
      // Session not found or unavailable — log warning, do not propagate.
      // The notification service must not fail the caller's event handler.
      log.warn(
        `[SpaceAgentNotificationService] Failed to inject notification into session ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------------------

function formatTaskBlocked(
  event: {
    spaceId: string;
    taskId: string;
    reason: string;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const humanReadable = `Task ${event.taskId} in space ${event.spaceId} is blocked: ${event.reason}`;
  const payload = {
    kind: 'task_blocked',
    spaceId: event.spaceId,
    taskId: event.taskId,
    reason: event.reason,
    timestamp: event.timestamp,
    autonomyLevel,
  };
  return buildMessage('task_blocked', humanReadable, payload);
}

function formatWorkflowRunBlocked(
  event: {
    spaceId: string;
    runId: string;
    reason: string;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const humanReadable = `Workflow run ${event.runId} in space ${event.spaceId} is blocked: ${event.reason}`;
  const payload = {
    kind: 'workflow_run_blocked',
    spaceId: event.spaceId,
    runId: event.runId,
    reason: event.reason,
    timestamp: event.timestamp,
    autonomyLevel,
  };
  return buildMessage('workflow_run_blocked', humanReadable, payload);
}

function formatTaskTimeout(
  event: {
    spaceId: string;
    taskId: string;
    elapsedMs: number;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const elapsedMin = Math.round(event.elapsedMs / 60000);
  const humanReadable = `Task ${event.taskId} in space ${event.spaceId} has been running for ${elapsedMin} minute(s) and may be stuck.`;
  const payload = {
    kind: 'task_timeout',
    spaceId: event.spaceId,
    taskId: event.taskId,
    elapsedMs: event.elapsedMs,
    timestamp: event.timestamp,
    autonomyLevel,
  };
  return buildMessage('task_timeout', humanReadable, payload);
}

function formatWorkflowRunReopened(
  event: {
    spaceId: string;
    runId: string;
    fromStatus: 'done' | 'cancelled' | 'blocked';
    reason: string;
    by: string;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const humanReadable =
    `Workflow run ${event.runId} in space ${event.spaceId} was reopened from '${event.fromStatus}' ` +
    `back to 'in_progress' (by: ${event.by}). Reason: ${event.reason}. ` +
    `A previously-finished task is active again; completion actions will not re-fire.`;
  const payload = {
    kind: 'workflow_run_reopened',
    spaceId: event.spaceId,
    runId: event.runId,
    fromStatus: event.fromStatus,
    reason: event.reason,
    by: event.by,
    timestamp: event.timestamp,
    autonomyLevel,
  };
  return buildMessage('workflow_run_reopened', humanReadable, payload);
}

function formatWorkflowRunDeadLoop(
  event: {
    spaceId: string;
    runId: string;
    fromAgent: string;
    toTarget: string;
    channelIndex: number;
    recentCount: number;
    threshold: number;
    windowMs: number;
    reason: string;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const windowMin = Math.round(event.windowMs / 60000);
  const humanReadable =
    `Dead loop detected in workflow run ${event.runId} (space ${event.spaceId}): ` +
    `agent "${event.fromAgent}" → "${event.toTarget}" sent ${event.recentCount} message round-trips ` +
    `within ${windowMin} minute(s) (threshold ${event.threshold}), so the next send was blocked. ` +
    `This looks like a runaway agent-to-agent ping-pong, not normal collaboration. ` +
    `Investigate the two agents and break the loop.`;
  const payload = {
    kind: 'workflow_dead_loop',
    spaceId: event.spaceId,
    runId: event.runId,
    fromAgent: event.fromAgent,
    toTarget: event.toTarget,
    channelIndex: event.channelIndex,
    recentCount: event.recentCount,
    threshold: event.threshold,
    windowMs: event.windowMs,
    reason: event.reason,
    timestamp: event.timestamp,
    autonomyLevel,
  };
  return buildMessage('workflow_dead_loop', humanReadable, payload);
}

function formatAgentCrash(
  event: {
    spaceId: string;
    taskId: string;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const humanReadable =
    `Task ${event.taskId} in space ${event.spaceId} encountered an agent crash. ` +
    `The task has been marked as blocked. ` +
    `Please investigate and retry the task when ready.`;
  const payload = {
    kind: 'agent_crash',
    spaceId: event.spaceId,
    taskId: event.taskId,
    failureReason: 'agentCrash',
    timestamp: event.timestamp,
    autonomyLevel,
  };
  return buildMessage('agent_crash', humanReadable, payload);
}

function formatTaskRetry(
  event: {
    spaceId: string;
    taskId: string;
    runId: string;
    originalReason: string;
    attemptNumber: number;
    maxAttempts: number;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const humanReadable =
    `Task ${event.taskId} in space ${event.spaceId} was blocked (reason: ${event.originalReason}). ` +
    `The runtime is automatically retrying (attempt ${event.attemptNumber}/${event.maxAttempts}). ` +
    `The blocked node execution has been reset to pending and will be re-spawned.`;
  return buildMessage('task_retry', humanReadable, {
    kind: 'task_retry',
    spaceId: event.spaceId,
    taskId: event.taskId,
    runId: event.runId,
    originalReason: event.originalReason,
    attemptNumber: event.attemptNumber,
    maxAttempts: event.maxAttempts,
    timestamp: event.timestamp,
    autonomyLevel,
  });
}

function formatWorkflowRunNeedsAttention(
  event: {
    spaceId: string;
    runId: string;
    taskId: string;
    reason: string;
    retriesExhausted: number;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const humanReadable =
    `Workflow run ${event.runId} in space ${event.spaceId} needs attention. ` +
    `The runtime exhausted ${event.retriesExhausted} automatic retry attempt(s). ` +
    `Reason: ${event.reason}. ` +
    `Please investigate and take action: retry with updated instructions, reassign, cancel, or escalate to the human.`;
  return buildMessage('workflow_run_needs_attention', humanReadable, {
    kind: 'workflow_run_needs_attention',
    spaceId: event.spaceId,
    runId: event.runId,
    taskId: event.taskId,
    reason: event.reason,
    retriesExhausted: event.retriesExhausted,
    timestamp: event.timestamp,
    autonomyLevel,
  });
}

function formatTaskAwaitingApproval(
  event: {
    spaceId: string;
    taskId: string;
    actionId: string;
    actionName: string;
    actionDescription?: string;
    actionType: 'script' | 'instruction' | 'mcp_call';
    requiredLevel: number;
    spaceLevel: number;
    autonomyLevel: number;
    timestamp: string;
  },
  autonomyLevel: SpaceAutonomyLevel
): string {
  const descPart = event.actionDescription ? ` — ${event.actionDescription}` : '';
  const humanReadable =
    `Task ${event.taskId} in space ${event.spaceId} is awaiting approval for completion action ` +
    `'${event.actionName}' (type: ${event.actionType})${descPart}. ` +
    `Requires autonomy ${event.requiredLevel}, space is at ${event.spaceLevel}. ` +
    `Review the action and approve or reject to resume the task.`;
  const payload: Record<string, unknown> = {
    kind: 'task_awaiting_approval',
    spaceId: event.spaceId,
    taskId: event.taskId,
    actionId: event.actionId,
    actionName: event.actionName,
    actionType: event.actionType,
    requiredLevel: event.requiredLevel,
    spaceLevel: event.spaceLevel,
    timestamp: event.timestamp,
    autonomyLevel,
  };
  if (event.actionDescription !== undefined) {
    payload['actionDescription'] = event.actionDescription;
  }
  return buildMessage('task_awaiting_approval', humanReadable, payload);
}

function buildMessage(
  kind: string,
  humanReadable: string,
  payload: Record<string, unknown>
): string {
  return [
    `[TASK_EVENT] ${kind}`,
    '',
    humanReadable,
    '',
    `Autonomy level: ${payload['autonomyLevel']}`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}
