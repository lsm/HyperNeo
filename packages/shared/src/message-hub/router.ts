/**
 * MessageHub Router
 *
 * Server-side router for handling session-based message routing
 * Routes messages by sessionId to appropriate handlers
 *
 * ARCHITECTURE:
 * - Pure routing layer - NO application logic
 * - O(1) client lookups with reverse index
 * - Memory leak prevention with empty Map cleanup
 * - Subscription key validation
 * - Duplicate registration prevention
 * - Observability with delivery stats
 * - Pluggable logger interface
 * - Transport-agnostic design (works with any connection type)
 * - Abstract ClientConnection interface
 * - Decoupled from WebSocket specifics
 */

import { ChannelManager } from './channel-manager.ts';
import type { HubMessage } from './protocol.ts';
import { isEventMessage } from './protocol.ts';

/**
 * Abstract connection interface
 * Allows router to work with any transport (WebSocket, HTTP/2, etc.)
 */
export interface ClientConnection {
  /** Unique connection identifier */
  id: string;
  /** Send data to the client */
  send(data: string): void;
  /** Check if connection is open and ready */
  isOpen(): boolean;
  /** FIX P0.6: Check if connection can accept messages (backpressure) */
  canAccept?(): boolean;
  /** Optional: Get connection metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Logger interface for dependency injection
 */
export interface RouterLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Router configuration options
 */
export interface MessageHubRouterOptions {
  logger?: RouterLogger;
  debug?: boolean;
  /** Maximum UTF-8 bytes allowed for one outbound wire message. */
  maxMessageSize?: number;
  /**
   * Maximum concurrent real-time subscriptions (e.g. live queries) a single
   * client may hold. Enforced router-side as an ingress fan-out guardrail: a
   * client that tries to subscribe beyond the cap is refused with a structured
   * `TOO_MANY_SUBSCRIPTIONS` error instead of silently accumulating handlers
   * and stalling (see task #899 / incident #2414).
   *
   * Tuned below observed fan-out (790 subscribes on one task page) so real
   * regressions trip loudly in dev, while leaving headroom for a busy tab.
   * @default 128
   */
  maxSubscriptionsPerClient?: number;
}

export const DEFAULT_MAX_OUTBOUND_MESSAGE_SIZE = 40 * 1024 * 1024;

/**
 * Default per-client subscription cap. ~6x below the 790-subscribe task-page
 * fan-out that motivated this guardrail (#2414), with headroom for a tab that
 * loads many sessions. Override via {@link MessageHubRouterOptions.maxSubscriptionsPerClient}.
 */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT = 128;

export type SendToClientResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unavailable' | 'serialization_failed' | 'message_too_large' | 'send_failed';
    };

/**
 * Result of a per-client subscription capacity check.
 *
 * `checkSubscriptionCapacity` is read-only: it never mutates the counter, so a
 * caller that decides not to track the subscription does not need to release.
 * Callers must pair a passing check with {@link MessageHubRouter.addClientSubscription}
 * once the subscription is actually tracked, and {@link MessageHubRouter.releaseClientSubscription}
 * when it is disposed.
 */
export type SubscriptionCapacityResult =
  | { ok: true }
  | { ok: false; reason: 'too_many_subscriptions'; limit: number; current: number };

/**
 * Client information
 */
interface ClientInfo {
  clientId: string;
  connection: ClientConnection;
  connectedAt: number;
}

/**
 * Route result with delivery statistics
 */
export interface RouteResult {
  sent: number;
  failed: number;
  totalSubscribers: number;
  sessionId: string;
  method: string;
}

/**
 * MessageHub Router for server-side
 *
 * Responsibilities:
 * - Route messages by sessionId
 * - Manage channel-based event routing
 * - Broadcast events to clients in channels
 */
export class MessageHubRouter {
  private clients: Map<string, ClientInfo> = new Map(); // Now keyed by clientId
  private channelManager: ChannelManager = new ChannelManager();

  /**
   * Per-client active subscription counts (ingress fan-out guardrail).
   * Mirrors the daemon's live-query handle map; maintained by callers via
   * {@link addClientSubscription} / {@link releaseClientSubscription} and reset on
   * disconnect via {@link unregisterConnection}.
   */
  private clientSubscriptionCounts: Map<string, number> = new Map();

  private logger: RouterLogger;
  private debug: boolean;
  private readonly maxMessageSize: number;
  private readonly maxSubscriptionsPerClient: number;

  constructor(options: MessageHubRouterOptions = {}) {
    this.logger = options.logger || console;
    this.debug = options.debug || false;
    this.maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_OUTBOUND_MESSAGE_SIZE;
    this.maxSubscriptionsPerClient =
      options.maxSubscriptionsPerClient ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT;
  }

  private byteLength(value: string): number {
    return new Blob([value]).size;
  }

  private serializeForSend(message: HubMessage): string | null {
    const json = this.safeStringify(message);
    const size = this.byteLength(json);
    if (size <= this.maxMessageSize) return json;

    this.logger.warn(
      `[MessageHubRouter] Refusing oversized outbound message ${message.method} (${size} bytes; limit ${this.maxMessageSize})`
    );
    return null;
  }

  /**
   * Safely stringify an object, handling circular references.
   *
   * Uses plain JSON.stringify first (which correctly serializes shared object
   * references). Only falls back to circular-reference handling when needed.
   *
   * The previous WeakSet-based approach incorrectly replaced shared (non-circular)
   * references with "[Circular]". For example, the same contextInfo object appears
   * in both sessionInfo.metadata.lastContextInfo and the top-level contextInfo
   * field — this is a shared reference, not circular, and must be serialized twice.
   */
  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch {
      // JSON.stringify throws on actual circular references or BigInt values.
      // Fall back to a replacer that strips only true circular references
      // by tracking the current ancestor chain (not all visited objects).
      const ancestors: unknown[] = [];
      return JSON.stringify(obj, function (_key, value) {
        if (typeof value !== 'object' || value === null) {
          return value;
        }

        // Handle specific types that may contain non-serializable data
        if (value.constructor?.name === 'AgentSession') {
          return '[AgentSession]';
        }

        // Pop ancestors that are no longer on the current path.
        // `this` is the holder object containing the current key.
        while (ancestors.length > 0 && ancestors.at(-1) !== this) {
          ancestors.pop();
        }

        // True circular reference: this object is an ancestor of itself
        if (ancestors.includes(value)) {
          return '[Circular]';
        }

        ancestors.push(value);
        return value;
      });
    }
  }

  /**
   * Register a client connection
   * Prevents duplicate registration
   */
  registerConnection(connection: ClientConnection): string {
    // Check for duplicate registration
    const existing = this.clients.get(connection.id);
    if (existing) {
      this.log(`Client already registered: ${existing.clientId}, returning existing ID`);
      return existing.clientId;
    }

    const info: ClientInfo = {
      clientId: connection.id,
      connection,
      connectedAt: Date.now(),
    };

    this.clients.set(connection.id, info);
    // Auto-join global channel
    this.channelManager.joinChannel(connection.id, 'global');
    this.log(`Client registered: ${connection.id}`);

    return connection.id;
  }

  /**
   * Unregister a client by clientId
   * Cleans up channel memberships
   */
  unregisterConnection(clientId: string): void {
    const info = this.clients.get(clientId);
    if (!info) {
      return;
    }

    // Clean up channel membership
    this.channelManager.removeClient(clientId);

    // Reset the subscription counter: the daemon disposes the client's handles
    // on disconnect, so any per-handle release that was missed is reconciled here.
    this.clientSubscriptionCounts.delete(clientId);

    this.clients.delete(clientId);
    this.log(`Client unregistered: ${info.clientId}`);
  }

  /**
   * Route an EVENT message to channel members (legacy method, delegates to routeEventToChannel)
   * Returns delivery statistics for observability
   */
  routeEvent(message: HubMessage): RouteResult {
    if (!isEventMessage(message)) {
      this.logger.warn(`[MessageHubRouter] Not an EVENT message:`, message);
      return {
        sent: 0,
        failed: 0,
        totalSubscribers: 0,
        sessionId: message.sessionId,
        method: message.method,
      };
    }

    // Delegate to channel-based routing
    return this.routeEventToChannel(message);
  }

  /**
   * Send a message to a specific client
   * FIX P2.1: Handle serialization errors and circular references
   */
  sendToClientDetailed(clientId: string, message: HubMessage): SendToClientResult {
    const client = this.getClientById(clientId);
    if (!client || !client.connection.isOpen()) {
      this.logger.warn(`[MessageHubRouter] Client unavailable: ${clientId}`);
      return { ok: false, reason: 'unavailable' };
    }

    let json: string | null;
    try {
      json = this.serializeForSend(message);
      if (json === null) return { ok: false, reason: 'message_too_large' };
    } catch (error) {
      this.logger.error(
        `[MessageHubRouter] Failed to serialize message for client ${clientId}:`,
        error
      );
      return { ok: false, reason: 'serialization_failed' };
    }

    try {
      client.connection.send(json);
      return { ok: true };
    } catch (error) {
      this.logger.error(`[MessageHubRouter] Failed to send to client ${clientId}:`, error);
      return { ok: false, reason: 'send_failed' };
    }
  }

  sendToClient(clientId: string, message: HubMessage): boolean {
    return this.sendToClientDetailed(clientId, message).ok;
  }

  /**
   * Broadcast a message to all clients
   * FIX P0.6: Check backpressure before sending to prevent server OOM
   * FIX P2.1: Handle serialization errors
   */
  broadcast(message: HubMessage): {
    sent: number;
    failed: number;
    skipped?: number;
  } {
    // FIX P2.1: Handle serialization errors with circular reference detection
    let json: string | null;
    try {
      json = this.serializeForSend(message);
      if (json === null) {
        return { sent: 0, failed: this.clients.size, skipped: 0 };
      }
    } catch (error) {
      this.logger.error(`[MessageHubRouter] Failed to serialize broadcast message:`, error);
      // Log message type for debugging
      const messageType = message?.type ?? 'unknown';
      const messageId = message?.id ?? 'unknown';
      this.logger.error(
        `[MessageHubRouter] Failed broadcast message details - type: ${messageType}, id: ${messageId}`
      );
      return { sent: 0, failed: this.clients.size, skipped: 0 };
    }

    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const client of this.clients.values()) {
      if (!client.connection.isOpen()) {
        failedCount++;
        continue;
      }

      // FIX P0.6: Check backpressure before sending
      if (client.connection.canAccept && !client.connection.canAccept()) {
        this.logger.warn(
          `Skipping broadcast to client ${client.clientId} - queue full (backpressure)`
        );
        skippedCount++;
        continue;
      }

      try {
        client.connection.send(json);
        sentCount++;
      } catch (error) {
        this.logger.error(`Failed to broadcast to client ${client.clientId}:`, error);
        failedCount++;
      }
    }

    this.log(
      `Broadcast message to ${sentCount} clients (${failedCount} failed, ${skippedCount} skipped)`
    );

    return { sent: sentCount, failed: failedCount, skipped: skippedCount };
  }

  /**
   * Get client info by clientId (O(1) lookup)
   */
  getClientById(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Get active client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get all connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  // -------------------------------------------------------------------------
  // Per-client subscription guardrail (ingress fan-out cap)
  // See task #899 / incident #2414: without this, opening a high-fan-out page
  // silently accumulated one handler per subscription and stalled the client.
  // -------------------------------------------------------------------------

  /**
   * Read-only capacity check. Returns `{ ok: false }` when the client is at the
   * cap, so the caller can refuse the subscribe with a structured
   * `TOO_MANY_SUBSCRIPTIONS` error BEFORE doing any work (no snapshot side
   * effects, no teardown of existing subscriptions). Does NOT mutate state.
   */
  checkSubscriptionCapacity(clientId: string): SubscriptionCapacityResult {
    const current = this.clientSubscriptionCounts.get(clientId) ?? 0;
    if (current >= this.maxSubscriptionsPerClient) {
      this.logger.warn(
        `[MessageHubRouter] Subscription cap exceeded for client ${clientId}: ` +
          `${current}/${this.maxSubscriptionsPerClient} active; refusing further subscribes`
      );
      return {
        ok: false,
        reason: 'too_many_subscriptions',
        limit: this.maxSubscriptionsPerClient,
        current,
      };
    }
    return { ok: true };
  }

  /**
   * Record one active subscription for a client. Call exactly once when the
   * subscription is actually tracked (after a passing {@link checkSubscriptionCapacity}).
   */
  addClientSubscription(clientId: string): void {
    const next = (this.clientSubscriptionCounts.get(clientId) ?? 0) + 1;
    this.clientSubscriptionCounts.set(clientId, next);
  }

  /**
   * Release one subscription slot for a client. Floors at zero so a stray
   * release (e.g. a handle disposed before it was tracked) cannot drive the
   * count negative and silently widen the cap.
   */
  releaseClientSubscription(clientId: string): void {
    const current = this.clientSubscriptionCounts.get(clientId);
    if (current === undefined) return;
    if (current <= 1) {
      this.clientSubscriptionCounts.delete(clientId);
    } else {
      this.clientSubscriptionCounts.set(clientId, current - 1);
    }
  }

  /**
   * Current active subscription count for a client (0 if none tracked).
   */
  getClientSubscriptionCount(clientId: string): number {
    return this.clientSubscriptionCounts.get(clientId) ?? 0;
  }

  /**
   * Join a client to a channel
   */
  joinChannel(clientId: string, channel: string): void {
    const client = this.getClientById(clientId);
    if (!client) {
      this.logger.warn(`[MessageHubRouter] Cannot join channel - client not found: ${clientId}`);
      return;
    }
    this.channelManager.joinChannel(clientId, channel);
    this.log(`Client ${clientId} joined channel: ${channel}`);
  }

  /**
   * Remove a client from a channel
   */
  leaveChannel(clientId: string, channel: string): void {
    this.channelManager.leaveChannel(clientId, channel);
    this.log(`Client ${clientId} left channel: ${channel}`);
  }

  /**
   * Route an EVENT message to all clients in the message's channel
   */
  routeEventToChannel(message: HubMessage): RouteResult {
    const channel = message.channel || 'global';
    const members = this.channelManager.getChannelMembers(channel);

    // Only include members of the specific channel (no global cross-pollution)
    const allRecipients = new Set(members);

    if (allRecipients.size === 0) {
      this.log(`No channel members for channel ${channel}, method ${message.method}`);
      return {
        sent: 0,
        failed: 0,
        totalSubscribers: 0,
        sessionId: message.sessionId,
        method: message.method,
      };
    }

    // Serialize once with circular reference handling
    let json: string | null;
    try {
      json = this.serializeForSend(message);
      if (json === null) {
        return {
          sent: 0,
          failed: allRecipients.size,
          totalSubscribers: allRecipients.size,
          sessionId: message.sessionId,
          method: message.method,
        };
      }
    } catch (error) {
      this.logger.error(`[MessageHubRouter] Failed to serialize channel event:`, error);
      return {
        sent: 0,
        failed: allRecipients.size,
        totalSubscribers: allRecipients.size,
        sessionId: message.sessionId,
        method: message.method,
      };
    }

    let sent = 0,
      failed = 0;
    for (const clientId of allRecipients) {
      const client = this.getClientById(clientId);
      if (client && client.connection.isOpen()) {
        try {
          client.connection.send(json);
          sent++;
        } catch (error) {
          this.logger.error(`Failed to send channel event to client ${clientId}:`, error);
          failed++;
        }
      } else {
        failed++;
      }
    }

    this.log(
      `Routed channel event ${channel}:${message.method} to ${sent}/${allRecipients.size} clients`
    );

    return {
      sent,
      failed,
      totalSubscribers: allRecipients.size,
      sessionId: message.sessionId,
      method: message.method,
    };
  }

  /**
   * Get the channel manager for inspection
   */
  getChannelManager(): ChannelManager {
    return this.channelManager;
  }

  /**
   * Debug logging - disabled, only errors are logged
   */
  private log(_message: string, ..._args: unknown[]): void {
    // Debug logging disabled - only errors are logged
  }
}
