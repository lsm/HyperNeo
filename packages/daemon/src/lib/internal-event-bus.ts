/**
 * InternalEventBus — Semantic daemon messaging primitive (v1)
 *
 * First-class facade for typed internal events with explicit await-vs-fire-and-forget
 * semantics. Daemon/domain code publishes and subscribes through this facade.
 *
 * Semantics
 * ---------
 * • `publish(...)`  – awaits every local internal handler and returns/throws
 *   structured handler failures.  Use when the caller must know whether all
 *   subscribers succeeded.
 * • `publishAsync(...)` – explicit fire-and-forget.  Returns immediately;
 *   handler failures are silently swallowed.
 *
 * Design constraints (v1)
 * -----------------------
 * • Wraps existing lower-level infrastructure where practical — the registry is
 *   kept in-process and does not migrate existing callers.
 * • No persistence / no replay.
 * • Subscriber names are required for diagnostics.
 *
 * Future direction
 * ----------------
 * See docs/plans/internal-event-command-query-architecture.md for the full
 * internal-event / command / query architecture plan.
 */

import type { GlobalSettings } from '@hyperneo/shared';
import type { ExternalEventPublishedPayload } from './external-events/external-event-service';

export interface HandlerFailure {
  /** Subscriber name that registered the failing handler. */
  subscriberName: string;

  /** Event name being handled when the failure occurred. */
  event: string;

  /** The raw Error (or Error-like) thrown by the handler. */
  error: Error;
}

export interface PublishResult {
  /** Number of handlers that completed successfully. */
  delivered: number;

  /** Structured failures from handlers that threw or rejected. */
  failures: HandlerFailure[];
}

/**
 * Thrown by `publish(...)` when one or more handlers fail.
 * The `result` field contains the full breakdown so callers can decide
 * whether to abort, partially retry, or continue.
 */
export class InternalEventBusPublishError extends Error {
  constructor(
    public readonly event: string,
    public readonly result: PublishResult
  ) {
    super(
      `Publish of '${event}' failed with ${result.failures.length} handler failure(s) ` +
        `(${result.delivered} succeeded)`
    );
    this.name = 'InternalEventBusPublishError';
  }
}

/**
 * Generic constraint for event-map entries.
 * All events must be plain objects so we can safely read `sessionId` for
 * scoped routing.
 */
export interface InternalEventPayload {
  /** Session-scoped routing key. Use `'global'` for app-wide events. */
  sessionId?: string;
  /** Namespace-scoped routing key used by newer space/runtime events. */
  namespaceId?: string;

  [key: string]: unknown;
}

/**
 * Subscription options.
 */
export interface SubscribeOptions {
  /**
   * Human-readable subscriber identifier used in diagnostics and
   * `HandlerFailure.subscriberName`.  Required.
   */
  subscriberName: string;

  /**
   * When provided, the handler only receives events whose payload carries
   * the matching `sessionId`/`namespaceId`.  Omit for a global subscription.
   */
  sessionId?: string;
  namespaceId?: string;
}

export type InternalEventHandler<TPayload> = (data: TPayload) => void | Promise<void>;

interface RegisteredHandler {
  subscriberName: string;
  handler: (data: unknown) => void | Promise<void>;
}

const GLOBAL_SESSION_KEY = '__global__';

/**
 * InternalEventBus
 *
 * @template TEventMap — map of dot-separated event names to payload shapes.
 */
export class InternalEventBus<TEventMap extends object = Record<string, InternalEventPayload>> {
  // event → sessionId → handlers
  private handlers = new Map<string, Map<string, Set<RegisteredHandler>>>();

  /**
   * Subscribe to an event.
   *
   * @param event     — typed event name
   * @param handler   — callback invoked when the event is published
   * @param options   — must include `subscriberName`; optional `sessionId` filter
   * @returns unsubscribe function
   */
  subscribe<K extends keyof TEventMap & string>(
    event: K,
    handler: InternalEventHandler<TEventMap[K] & InternalEventPayload>,
    options: SubscribeOptions
  ): () => void {
    const eventKey = event;
    const sessionKey = options.sessionId ?? options.namespaceId ?? GLOBAL_SESSION_KEY;

    if ((options.sessionId ?? options.namespaceId) === GLOBAL_SESSION_KEY) {
      throw new Error(
        `'${GLOBAL_SESSION_KEY}' is a reserved session key and cannot be used as an explicit sessionId`
      );
    }

    if (!options.subscriberName || options.subscriberName.trim().length === 0) {
      throw new Error('InternalEventBus.subscribe requires a non-empty subscriberName');
    }

    let sessionMap = this.handlers.get(eventKey);
    if (!sessionMap) {
      sessionMap = new Map();
      this.handlers.set(eventKey, sessionMap);
    }

    let handlerSet = sessionMap.get(sessionKey);
    if (!handlerSet) {
      handlerSet = new Set();
      sessionMap.set(sessionKey, handlerSet);
    }

    const registered: RegisteredHandler = {
      subscriberName: options.subscriberName,
      handler: handler as (data: unknown) => void | Promise<void>,
    };

    handlerSet.add(registered);

    return () => {
      const map = this.handlers.get(eventKey);
      if (!map) return;
      const set = map.get(sessionKey);
      if (!set) return;
      set.delete(registered);
      if (set.size === 0) map.delete(sessionKey);
      if (map.size === 0) this.handlers.delete(eventKey);
    };
  }

  /**
   * Publish an event and **await** every local internal handler.
   *
   * All matching handlers are executed concurrently.  If any handler throws,
   * the error is captured in a structured `HandlerFailure`, every other
   * handler still runs, and the method finally throws
   * `InternalEventBusPublishError` containing the full `PublishResult`.
   *
   * When **all** handlers succeed the returned `PublishResult` contains
   * `failures: []` and is never thrown.
   */
  async publish<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K] & InternalEventPayload
  ): Promise<PublishResult> {
    const eventKey = event;
    const sessionMap = this.handlers.get(eventKey);

    if (!sessionMap || sessionMap.size === 0) {
      return { delivered: 0, failures: [] };
    }

    const sessionId = data.sessionId ?? data.namespaceId ?? GLOBAL_SESSION_KEY;
    const failures: HandlerFailure[] = [];
    let delivered = 0;

    const targets: RegisteredHandler[] = [];

    // Session-scoped handlers
    const scoped = sessionMap.get(sessionId);
    if (scoped) {
      for (const h of scoped) targets.push(h);
    }

    // Global handlers — only add when sessionId is not the global sentinel
    // to prevent double-delivery of the same handler set.
    if (sessionId !== GLOBAL_SESSION_KEY) {
      const global = sessionMap.get(GLOBAL_SESSION_KEY);
      if (global) {
        for (const h of global) targets.push(h);
      }
    }

    if (targets.length === 0) {
      return { delivered: 0, failures: [] };
    }

    // Run every handler concurrently; collect failures individually.
    await Promise.all(
      targets.map(async (registered) => {
        try {
          await registered.handler(data);
          delivered++;
        } catch (raw) {
          const error = raw instanceof Error ? raw : new Error(String(raw));
          failures.push({
            subscriberName: registered.subscriberName,
            event: eventKey,
            error,
          });
        }
      })
    );

    const result: PublishResult = { delivered, failures };

    if (failures.length > 0) {
      throw new InternalEventBusPublishError(eventKey, result);
    }

    return result;
  }

  /**
   * Fire-and-forget publish.
   *
   * Schedules handlers asynchronously but returns immediately.
   * Handler failures are silently swallowed; they are never thrown
   * and the caller cannot await them.
   */
  publishAsync<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K] & InternalEventPayload
  ): void {
    // Defer to the next microtask so that synchronous handlers do not
    // run on the caller's stack and `publishAsync` truly returns
    // immediately.
    queueMicrotask(() => {
      this.publish(event, data).catch(() => {
        // Swallow — publishAsync is explicit fire-and-forget.
      });
    });
  }

  /**
   * Remove every handler for the given event (all sessions).
   */
  off<K extends keyof TEventMap & string>(event: K): void {
    this.handlers.delete(event);
  }

  /**
   * Remove all handlers for every event.
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Return the total number of registered handlers for an event
   * across all session scopes.
   */
  getHandlerCount<K extends keyof TEventMap & string>(event: K): number {
    const sessionMap = this.handlers.get(event);
    if (!sessionMap) return 0;
    let total = 0;
    for (const set of sessionMap.values()) {
      total += set.size;
    }
    return total;
  }

  /**
   * Return the number of registered handlers for a specific session scope.
   */
  getHandlerCountForSession<K extends keyof TEventMap & string>(
    event: K,
    sessionId: string
  ): number {
    const sessionMap = this.handlers.get(event);
    if (!sessionMap) return 0;
    return sessionMap.get(sessionId)?.size ?? 0;
  }

  /**
   * Return the number of registered handlers for a specific namespace scope.
   */
  getHandlerCountForNamespace<K extends keyof TEventMap & string>(
    event: K,
    namespaceId: string
  ): number {
    return this.getHandlerCountForSession(event, namespaceId);
  }
}

/**
 * Convenience factory that produces an InternalEventBus typed with the
 * caller's event map.
 *
 * This is the entry point most daemon code should use:
 *
 *   import { createInternalEventBus } from '@hyperneo/daemon/lib/internal-event-bus';
 *   const bus = createInternalEventBus<MyEventMap>();
 */
export function createInternalEventBus<
  TEventMap extends object = Record<string, InternalEventPayload>,
>(): InternalEventBus<TEventMap> {
  return new InternalEventBus<TEventMap>();
}

// ---------------------------------------------------------------------------
// Event contracts — canonical payloads for InternalEventBus events.
// Keep each domain's events in a separate interface and intersect them here.
//
// Naming convention: dot-separated, lower camelCase per segment, fact/state-
// change wording. See docs/plans/internal-event-command-query-architecture.md.
// ---------------------------------------------------------------------------

/**
 * Payload for `settings.updated` — emitted when global settings are updated
 * via `settings.global.update`, `settings.global.save`, or after a successful
 * `.mcp.json` import refresh. Subscribers (e.g. StateProjectionService) re-broadcast
 * the latest settings to clients on the global settings channel.
 *
 * Always carries `sessionId: 'global'` — settings are application-wide.
 */
export interface SettingsUpdatedEvent {
  sessionId?: string;
  namespaceId?: string;
  settings: GlobalSettings;
}

/**
 * Settings domain events.
 */
export interface SettingsEvents {
  'settings.updated': SettingsUpdatedEvent;
}

/**
 * External event domain events.
 */
export interface ExternalEventEvents {
  'externalEvent.published': ExternalEventPublishedPayload;
}

/**
 * Session domain events.
 * These events drive StateProjectionService cache updates.
 */
export interface SessionEvents {
  'sdk.toolUse.created': {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    timestamp: number;
  };
  'sdk.toolUse.consumed': {
    sessionId: string;
    toolUseId: string;
    timestamp: number;
  };
  'session.created': { sessionId: string; session: import('@hyperneo/shared').Session };
  'session.updated': {
    sessionId: string;
    source?: string;
    session?: Partial<import('@hyperneo/shared').Session>;
    processingState?: import('@hyperneo/shared').AgentProcessingState;
  };
  'session.deleted': { sessionId: string };
  'commands.updated': { sessionId: string; commands: string[] };
  'session.error': { sessionId: string; error: string; details?: unknown };
  'session.errorClear': { sessionId: string };
  /**
   * A session has paused after rate/usage-limit exhaustion with no fallback
   * left (chain exhausted). Listeners (e.g. the Space runtime) surface a paused
   * task status with a resume-at timestamp. Emitted by RateLimitWatchdog.
   */
  'session.rate_limit_pause': {
    sessionId: string;
    /** 'rate_limit' (transient) or 'usage_limit' (daily/weekly cap). */
    kind: 'rate_limit' | 'usage_limit';
    /** Epoch-ms when the limit is expected to reset, if known. */
    resetAt?: number;
    /** Short reason string (the cooldown decision reason). */
    reason: string;
  };
  /**
   * A previously rate-limited session has resumed (cooldown fired, user
   * cancelled/retried, or the API call succeeded). Listeners clear any paused
   * task status. Emitted by RateLimitWatchdog.
   */
  'session.rate_limit_resume': { sessionId: string };
}

/**
 * API connection events.
 */
export interface ApiConnectionEvents {
  'api.connection': { sessionId: string } & import('@hyperneo/shared').ApiConnectionState;
}

// ---------------------------------------------------------------------------
// Space runtime events — migrated from NotificationSink to InternalEventBus in M6.
// Naming: dot-separated, lower camelCase per segment, fact/state-change wording.
// ---------------------------------------------------------------------------

/** A task has transitioned to `blocked` and requires judgment. */
export interface SpaceTaskBlockedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  reason: string;
  timestamp: string;
}

/**
 * A task has been unblocked and is resuming.
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. Will be wired when the runtime adds an unblock path.
 */
export interface SpaceTaskUnblockedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  reason: string;
  timestamp: string;
}

/**
 * A task has reached a terminal state (completed, failed, or cancelled).
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. The runtime currently emits `workflowRun.completed`
 * for terminal runs rather than per-task completion events.
 */
export interface SpaceTaskCompletedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  status: 'done' | 'cancelled' | 'blocked';
  timestamp: string;
}

/**
 * A task has failed with an unrecoverable error.
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. Task failures are currently surfaced via
 * `space.task.blocked` with the failure reason.
 */
export interface SpaceTaskFailedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  reason: string;
  timestamp: string;
}

/** A Task Agent session crashed unexpectedly. */
export interface SpaceAgentCrashedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  timestamp: string;
}

/**
 * A crashed agent has been recovered (e.g. after retry).
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. Recovery is currently silent; agents are retried
 * without emitting a dedicated recovery event.
 */
export interface SpaceAgentRecoveredEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  timestamp: string;
}

/** A workflow execution attempt has finished. */
export interface SpaceWorkflowRunCompletedEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  status: 'done' | 'cancelled' | 'blocked';
  summary?: string;
  timestamp: string;
}

/** A workflow run has failed with an unrecoverable error. */
export interface SpaceWorkflowRunFailedEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  reason: string;
  timestamp: string;
}

/** A workflow run has transitioned to `blocked`. */
export interface SpaceWorkflowRunBlockedEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  reason: string;
  timestamp: string;
}

/** A finished or waiting workflow run has been reopened back to `in_progress`. */
export interface SpaceWorkflowRunReopenedEvent {
  sessionId?: string;
  namespaceId?: string;
  spaceId: string;
  runId: string;
  fromStatus: 'done' | 'cancelled' | 'blocked';
  reason: string;
  by: string;
  timestamp: string;
}

/**
 * A cyclic channel between two agents has tripped the rate-based dead-loop
 * detector — too many messages within a short rolling window. The send that
 * would have exceeded the threshold was blocked. Emitted so the human sees the
 * block in the UI rather than the send failing silently.
 */
export interface SpaceWorkflowRunDeadLoopEvent {
  sessionId?: string;
  namespaceId?: string;
  spaceId: string;
  runId: string;
  /** Sending agent name. */
  fromAgent: string;
  /** Receiving agent name (or node name for fan-out). */
  toTarget: string;
  /** Index of the cyclic channel in the workflow's `channels` array. */
  channelIndex: number;
  /** Traversals recorded within the rolling window at the time of the trip. */
  recentCount: number;
  /** Max traversals permitted within the window (the threshold that was met). */
  threshold: number;
  /** Window length in milliseconds. */
  windowMs: number;
  reason: string;
  timestamp: string;
}

/** A blocked execution is being automatically retried by the runtime. */
export interface SpaceWorkflowRunRetryEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  runId: string;
  originalReason: string;
  attemptNumber: number;
  maxAttempts: number;
  timestamp: string;
}

/** A blocked workflow run has exhausted automatic retries and needs attention. */
export interface SpaceWorkflowRunNeedsAttentionEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  taskId: string;
  reason: string;
  retriesExhausted: number;
  timestamp: string;
}

/** A task has paused at a completion action that requires approval. */
export interface SpaceTaskAwaitingApprovalEvent {
  sessionId: string;
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
}

/** A task has been running longer than the configured timeout threshold. */
export interface SpaceTaskTimeoutEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  elapsedMs: number;
  timestamp: string;
}

/**
 * Space domain events — migrated from NotificationSink to InternalEventBus in M6.
 */
export interface SpaceEvents {
  'space.task.blocked': SpaceTaskBlockedEvent;
  'space.task.unblocked': SpaceTaskUnblockedEvent;
  'space.task.completed': SpaceTaskCompletedEvent;
  'space.task.failed': SpaceTaskFailedEvent;
  'space.agent.crashed': SpaceAgentCrashedEvent;
  'space.agent.recovered': SpaceAgentRecoveredEvent;
  'space.workflowRun.completed': SpaceWorkflowRunCompletedEvent;
  'space.workflowRun.failed': SpaceWorkflowRunFailedEvent;
  'space.workflowRun.blocked': SpaceWorkflowRunBlockedEvent;
  'space.workflowRun.reopened': SpaceWorkflowRunReopenedEvent;
  'space.workflowRun.deadLoop': SpaceWorkflowRunDeadLoopEvent;
  'space.workflowRun.retry': SpaceWorkflowRunRetryEvent;
  'space.workflowRun.needsAttention': SpaceWorkflowRunNeedsAttentionEvent;
  'space.task.awaitingApproval': SpaceTaskAwaitingApprovalEvent;
  'space.task.timeout': SpaceTaskTimeoutEvent;
}

/**
 * Canonical daemon internal event map.
 *
 * Each domain should own its slice; this type is the intersection of all
 * domain event maps so the bus can be typed with the full surface.
 *
 * This map is the canonical event surface for daemon application/domain code.
 * The permissive payload entry keeps the remaining long-tail event names routable
 * through InternalEventBus while narrower domain slices document payloads for
 * active subscribers.
 */
type InternalEventBusPayload = { sessionId?: string; namespaceId?: string } & Record<
  string,
  unknown
>;

interface AgentControlEvents {
  'model.switchRequest': { sessionId: string; model: string; provider: string };
  'model.switched': { sessionId: string; success: boolean; model: string; error?: string };
  'agent.interruptRequest': { sessionId: string };
  'agent.interrupted': { sessionId: string };
  'agent.resetRequest': { sessionId: string; restartQuery?: boolean };
  'agent.reset': { sessionId: string; success: boolean; error?: string };
  'message.persisted': {
    sessionId: string;
    messageId: string;
    messageContent: string | import('@hyperneo/shared').MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
    sendStatus: 'deferred' | 'enqueued' | 'consumed';
    deliveryMode: import('@hyperneo/shared').MessageDeliveryMode;
    skipQueryStart?: boolean;
  };
  'query.trigger': { sessionId: string };
  'context.updated': { sessionId: string; contextInfo: import('@hyperneo/shared').ContextInfo };
}

interface ClientForwardingEvents {
  'auth.changed': {
    sessionId: string;
    method: import('@hyperneo/shared').AuthMethod;
    isAuthenticated: boolean;
  };
  'space.created': { sessionId: string; spaceId: string; space: import('@hyperneo/shared').Space };
  'space.updated': {
    sessionId: string;
    spaceId: string;
    space?: Partial<import('@hyperneo/shared').Space>;
  };
  'space.archived': { sessionId: string; spaceId: string; space: import('@hyperneo/shared').Space };
  'space.deleted': { sessionId: string; spaceId: string };
  'space.task.created': {
    sessionId: string;
    spaceId: string;
    taskId: string;
    task: import('@hyperneo/shared').SpaceTask;
  };
  'space.task.updated': {
    sessionId: string;
    spaceId: string;
    taskId: string;
    task: import('@hyperneo/shared').SpaceTask;
    archiveSource?: 'user' | 'system_reconcile';
  };
  'space.schedule.updated': {
    sessionId: string;
    spaceId: string;
    scheduleId: string;
    schedule: import('@hyperneo/shared').TaskSchedule;
  };
  'space.workflowRun.created': {
    sessionId: string;
    spaceId: string;
    runId: string;
    run: import('@hyperneo/shared').SpaceWorkflowRun;
  };
  'space.workflowRun.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    run?: Partial<import('@hyperneo/shared').SpaceWorkflowRun>;
  };
  'space.hookState.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    hookId: string;
    hookState: import('@hyperneo/shared').WorkflowHookStateSnapshot;
  };
  'spaceAgent.created': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceWorkerAgent;
  };
  'spaceAgent.updated': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceWorkerAgent;
  };
  'spaceAgent.deleted': { sessionId: string; spaceId: string; agentId: string };
  'spaceLongHorizonAgent.created': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceLongHorizonAgent;
  };
  'spaceLongHorizonAgent.updated': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceLongHorizonAgent;
  };
  'spaceLongHorizonAgent.deleted': { sessionId: string; spaceId: string; agentId: string };
  'spaceWorkflow.created': {
    sessionId: string;
    spaceId: string;
    workflow: import('@hyperneo/shared').SpaceWorkflow;
  };
  'spaceWorkflow.updated': {
    sessionId: string;
    spaceId: string;
    workflow: import('@hyperneo/shared').SpaceWorkflow;
  };
  'spaceWorkflow.deleted': { sessionId: string; spaceId: string; workflowId: string };
  'providers.changed': { sessionId: string };
}

/**
 * Full-surface event map for daemon application code.
 *
 * The permissive index signature keeps long-tail event names routable through
 * InternalEventBus while narrower domain slices document typed payloads for active
 * subscribers.
 */
export type DaemonInternalEventMap = Record<string, InternalEventBusPayload> &
  AgentControlEvents &
  ClientForwardingEvents &
  SettingsEvents &
  ExternalEventEvents &
  SessionEvents &
  ApiConnectionEvents &
  SpaceEvents;

/**
 * Convenience factory typed with the canonical daemon internal event map.
 * Prefer this over the bare `createInternalEventBus` factory inside daemon
 * application/domain code so all migrated events share one typed surface.
 */
export function createDaemonInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return new InternalEventBus<DaemonInternalEventMap>();
}
