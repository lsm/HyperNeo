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

import type { HubMessage } from './protocol.ts';
import { isEventMessage } from './protocol.ts';
import { ChannelManager } from './channel-manager.ts';

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
}

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

  private logger: RouterLogger;
  private debug: boolean;

  constructor(options: MessageHubRouterOptions = {}) {
    this.logger = options.logger || console;
    this.debug = options.debug || false;
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
  sendToClient(clientId: string, message: HubMessage): boolean {
    const client = this.getClientById(clientId);
    if (!client) {
      this.logger.warn(`[MessageHubRouter] Client not found: ${clientId}`);
      return false;
    }

    if (!client.connection.isOpen()) {
      this.logger.warn(`[MessageHubRouter] Client not ready: ${clientId}`);
      return false;
    }

    // FIX P2.1: Handle serialization errors with circular reference detection
    let json: string;
    try {
      json = this.safeStringify(message);
    } catch (error) {
      this.logger.error(
        `[MessageHubRouter] Failed to serialize message for client ${clientId}:`,
        error
      );
      // Log message type for debugging
      const messageType = message?.type ?? 'unknown';
      const messageId = message?.id ?? 'unknown';
      this.logger.error(
        `[MessageHubRouter] Failed message details - type: ${messageType}, id: ${messageId}`
      );
      return false;
    }

    try {
      client.connection.send(json);
      return true;
    } catch (error) {
      this.logger.error(`[MessageHubRouter] Failed to send to client ${clientId}:`, error);
      return false;
    }
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
    let json: string;
    try {
      json = this.safeStringify(message);
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
    let json: string;
    try {
      json = this.safeStringify(message);
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
