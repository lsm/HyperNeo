/**
 * External Event Bus — shared types
 *
 * Source-agnostic types for external events that flow through the daemon's
 * external-event subsystem. GitHub is one source among many — the same shapes
 * are reused for future Slack / Jira / CI integrations. Source-specific
 * concerns (HMAC, repo configuration, polling) live in extension modules; the
 * core bus only sees `ExternalEvent`s.
 *
 * See docs/plans/design-external-event-bus-for-space-workflow-nodes.md.
 */

import type { MessageHub } from '@hyperneo/shared/message-hub/message-hub.ts';
import type { ExternalEventPublisher } from './external-event-service';

/**
 * A normalized external event on the bus.
 *
 * `dedupeKey` is the stable source-level identity used by `ExternalEventStore`
 * to recognize the same external event across webhook + polling observations.
 * It must be stable across observations of the same external event from any
 * channel and unique within `(spaceId, source)`.
 *
 * Source-specific metadata (PR number, repo owner, branch, etc.) lives in the
 * opaque `payload` object. The event pipeline is intentionally agnostic to
 * task-system concerns — task matching is the responsibility of subscribers.
 */
export interface ExternalEvent {
  /** Unique event ID (UUID) assigned by the extension for this publication. */
  id: string;
  /** Space this event belongs to. Required to prevent cross-space delivery. */
  spaceId: string;
  /** Fully qualified topic: 'github/owner/repo/resource/entityId.action'. */
  topic: string;
  /** Timestamp when the event occurred at the source (epoch ms). */
  occurredAt: number;
  /** Timestamp when the event was accepted by the extension (epoch ms). */
  ingestedAt: number;
  /** Source extension identifier (e.g. 'github'). */
  source: string;
  /** Optional source-native event id / delivery id for diagnostics. */
  sourceEventId?: string;
  /** Human-readable summary for agent consumption. */
  summary: string;
  /** External URL (e.g. GitHub PR link). */
  externalUrl?: string;
  /** Structured source payload — extension-specific, not constrained. */
  payload: Record<string, unknown>;
  /**
   * Stable source-level identity used by bus dedup. Must be stable across
   * webhook and polling observations of the same external event.
   */
  dedupeKey: string;
}

/**
 * Lifecycle states for the source event row in `space_external_events`.
 *
 * Retryable: `published` — source duplicates re-emit so delivery can retry.
 *
 * Terminal: `delivered`, `failed`, `ignored` — source duplicates are
 * short-circuited.
 */
export type ExternalEventState = 'published' | 'delivered' | 'failed' | 'ignored';

export const TERMINAL_EVENT_STATES: ReadonlySet<ExternalEventState> = new Set<ExternalEventState>([
  'delivered',
  'failed',
  'ignored',
]);

/**
 * Lifecycle states for a per-subscription delivery row in
 * `space_external_event_deliveries`.
 *
 * `pending`: registered, not yet attempted or attempt may retry.
 *   - `failureReason === null`: owned by an in-process dispatch path
 *     (pending queue, in-flight, or rate-limit digest). The activation
 *     flush intentionally skips these to avoid duplicate dispatch;
 *     requeuePersistedPendingDeliveries recovers them across a crash.
 *   - `failureReason !== null`: explicitly retryable (e.g.
 *     `node_execution_not_active`); eligible for the activation flush.
 * `delivered` (terminal): command-bus injection succeeded.
 * `failed` (terminal): retry budget exhausted, scope mismatch, node cancellation, etc.
 */
export type ExternalEventDeliveryState = 'pending' | 'delivered' | 'failed';

export const TERMINAL_DELIVERY_STATES: ReadonlySet<ExternalEventDeliveryState> =
  new Set<ExternalEventDeliveryState>(['delivered', 'failed']);

/**
 * Stored event row, including current state. Useful for diagnostics and tests.
 */
export interface ExternalEventRecord {
  event: ExternalEvent;
  state: ExternalEventState;
  createdAt: number;
  updatedAt: number;
}

/**
 * Stored delivery row. The `(eventId, deliveryKey)` pair is the row's primary key.
 */
export interface ExternalEventDeliveryRecord {
  eventId: string;
  deliveryKey: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  state: ExternalEventDeliveryState;
  failureReason: string | null;
  deliveredAt: number | null;
  updatedAt: number;
}

export interface ExternalEventDeliveryLogFilters {
  spaceId: string;
  status?: ExternalEventDeliveryState;
  /** When set, restrict to source events from this external-event source. */
  source?: string;
  eventId?: string;
  agentName?: string;
  limit?: number;
  offset?: number;
}

export interface ExternalEventDeliveryLogRecord extends ExternalEventDeliveryRecord {
  event: ExternalEvent;
  eventState: ExternalEventState;
  eventCreatedAt: number;
  eventUpdatedAt: number;
}

/**
 * Result of a `store()` call.
 *
 * - `duplicate=false` — first observation of this `(spaceId, source, dedupeKey)`.
 *   The returned `event` is the caller's input (with the caller-supplied id).
 * - `duplicate=true, terminal=true` — already terminal; caller should short-circuit.
 *   The returned `event` carries the *original* event id (so callers refer to the
 *   canonical row, not the duplicate they just submitted).
 * - `duplicate=true, terminal=false` — retryable duplicate; caller may re-emit.
 *   The returned `event` carries the *original* event id.
 */
export interface StoreResult {
  event: ExternalEvent;
  duplicate: boolean;
  terminal: boolean;
}

/**
 * Target identity of a delivery, captured at expected-delivery registration time.
 */
export interface DeliveryTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface DeliveryFailure {
  /** Whether the failure is terminal (`true`) or transient (`false`, retryable). */
  terminal: boolean;
  /** Free-form failure reason for diagnostics (logged + persisted). */
  reason: string;
}

export interface ExternalEventExtensionConfig {
  source: string;
  globallyEnabled: boolean;
  capabilities: {
    webhooks?: boolean;
    polling?: boolean;
    rpcConfig?: boolean;
  };
  secretsRef?: string;
  settings?: Record<string, unknown>;
}

export interface SpaceExternalEventSourceConfig {
  spaceId: string;
  source: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface ExternalEventExtensionContext {
  /** Publish a normalized event into the shared external-event subsystem. */
  publisher: ExternalEventPublisher;
  /** Read global extension config, secrets references, and per-space config. */
  config: ExternalEventExtensionConfigStore;
  /** Notify core services that source configuration changed for a space. */
  onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }): void;
}

export interface ExternalEventExtensionConfigStore {
  getGlobalConfig(source: string): Promise<ExternalEventExtensionConfig>;
  getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig | null>;
  listEnabledSpaces(source: string): Promise<SpaceExternalEventSourceConfig[]>;
  setGlobalConfig(source: string, config: ExternalEventExtensionConfig): Promise<void>;
  setSpaceConfig(
    spaceId: string,
    source: string,
    config: SpaceExternalEventSourceConfig
  ): Promise<void>;
}

/** Interface that event source extensions must implement. */
export interface ExternalEventExtension {
  /** Source identifier used in topic namespace: '{source}/...'. */
  readonly sourceId: string;

  /** Start the extension. Called once when the source is globally enabled. */
  start(context: ExternalEventExtensionContext): Promise<void>;

  /** Stop the extension. Called at daemon shutdown or when globally disabled. */
  stop(): Promise<void>;
}

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  handle(req: Request, context: ExternalEventExtensionContext): Promise<Response>;
}

export interface HttpExternalEventExtension extends ExternalEventExtension {
  readonly routes: readonly Route[];
}

export interface RpcExternalEventExtension extends ExternalEventExtension {
  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void;
}
