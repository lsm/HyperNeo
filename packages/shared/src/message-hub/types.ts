/**
 * MessageHub Types
 *
 * Type definitions for MessageHub API
 */

import type { HubMessage } from './protocol.ts';

// Re-export HubMessage for convenience
export type { HubMessage };

/**
 * Platform-agnostic timeout identifier
 * Cross-platform compatible type for setTimeout return values
 */
export type TimeoutId = ReturnType<typeof setTimeout>;

/**
 * Platform-agnostic interval identifier
 * Cross-platform compatible type for setInterval return values
 */
export type IntervalId = ReturnType<typeof setInterval>;

/**
 * Request handler function
 * Handles REQUEST messages and returns optional result
 * If handler returns void/undefined, auto-ACK is sent
 * If handler returns value, that becomes the response
 */
export type RequestHandler<TData = unknown, TResult = unknown> = (
  data: TData,
  context: CallContext
) => TResult | Promise<TResult> | void | Promise<void>;

/**
 * Channel event handler function
 * Handles channel-scoped EVENT messages
 */
export type ChannelEventHandler<TData = unknown> = (
  data: TData,
  context: EventContext & { channel?: string }
) => void | Promise<void>;

/**
 * Message handler for raw message inspection
 */
export type MessageHandler = (message: HubMessage, direction: 'in' | 'out') => void | Promise<void>;

/**
 * Connection state change handler
 */
export type ConnectionStateHandler = (state: ConnectionState, error?: Error) => void;

/**
 * Context provided to RPC handlers
 */
export interface CallContext {
  /**
   * Message ID
   */
  messageId: string;

  /**
   * Session ID
   */
  sessionId: string;

  /**
   * Method name
   */
  method: string;

  /**
   * Timestamp
   */
  timestamp: string;

  /**
   * Client ID — present for WebSocket-originated requests, undefined for in-process calls
   */
  clientId?: string;
}

/**
 * Context provided to event handlers
 */
export interface EventContext {
  /**
   * Message ID
   */
  messageId: string;

  /**
   * Session ID
   */
  sessionId: string;

  /**
   * Method/Event name
   */
  method: string;

  /**
   * Timestamp
   */
  timestamp: string;
}

/**
 * Connection state
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting'
  | 'failed';

/**
 * Options for query()
 */
export interface QueryOptions {
  /**
   * Query timeout in milliseconds
   * @default 10000
   */
  timeout?: number;

  /**
   * Optional channel identifier
   */
  channel?: string;
}

/**
 * Options for event operations with channel support
 */
export interface EventOptions {
  /**
   * Optional channel identifier
   */
  channel?: string;
}

/**
 * MessageHub configuration options
 */
export interface MessageHubOptions {
  /**
   * Default session ID for operations
   * @default "global"
   */
  defaultSessionId?: string;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Default RPC timeout in milliseconds
   * @default 10000
   */
  timeout?: number;

  /**
   * Auto-reconnect on disconnect
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Maximum reconnection attempts
   * @default 5
   */
  maxReconnectAttempts?: number;

  /**
   * Reconnection delay in milliseconds
   * @default 1000
   */
  reconnectDelay?: number;

  /**
   * Heartbeat/ping interval in milliseconds
   * Set to 0 to disable
   * @default 30000
   */
  pingInterval?: number;

  /**
   * Maximum number of pending RPC calls (backpressure)
   * @default 1000
   */
  maxPendingCalls?: number;

  /**
   * Maximum cache size for request deduplication
   * @default 500
   */
  maxCacheSize?: number;

  /**
   * Cache entry TTL in milliseconds
   * @default 60000 (1 minute)
   */
  cacheTTL?: number;

  /**
   * Maximum subscriptions per client (router-side)
   * @default 1000
   */
  maxSubscriptionsPerClient?: number;

  /**
   * Maximum event handler nesting depth (prevents infinite recursion)
   * @default 10
   */
  maxEventDepth?: number;

  /**
   * FIX P1.4: Stop on first event handler error (strict mode)
   * If false (default), all handlers execute and errors are collected
   * If true, stops on first handler error
   * @default false
   */
  stopOnEventHandlerError?: boolean;
}

/**
 * Result of broadcast operation
 */
export interface BroadcastResult {
  sent: number;
  failed: number;
  totalTargets: number;
}

/**
 * Transport interface for MessageHub
 *
 * Transports are pure I/O layers - they send/receive messages but don't route.
 * MessageHub is responsible for determining message recipients.
 */
export interface IMessageTransport {
  /**
   * Transport name
   */
  readonly name: string;

  /**
   * Initialize transport (connect)
   */
  initialize(): Promise<void>;

  /**
   * Send a message to a specific client (server-side transports only)
   * @returns true if sent successfully, false otherwise
   */
  sendToClient?(clientId: string, message: HubMessage): Promise<boolean>;

  /**
   * Broadcast a message to multiple clients (server-side transports only)
   * @returns statistics about delivery success/failure
   */
  broadcastToClients?(clientIds: string[], message: HubMessage): Promise<BroadcastResult>;

  /**
   * Send a message (client-side: to server, server-side: broadcast to all)
   * @deprecated Use sendToClient or broadcastToClients for server-side transports
   */
  send(message: HubMessage): Promise<void>;

  /**
   * Close transport
   */
  close(): Promise<void>;

  /**
   * Check if transport is ready
   */
  isReady(): boolean;

  /**
   * Get connection state
   */
  getState(): ConnectionState;

  /**
   * Register handler for incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): () => void;

  /**
   * Register handler for connection state changes
   */
  onConnectionChange(handler: ConnectionStateHandler): () => void;

  /**
   * Register handler for client disconnect events (server-side only)
   * Used for per-client cleanup
   */
  onClientDisconnect?(handler: (clientId: string) => void): () => void;
}

/**
 * Pending RPC call tracker
 * Generic type parameter TResult represents the expected return type of the RPC call
 */
export interface PendingCall<TResult = unknown> {
  /**
   * Promise resolve function
   */
  resolve: (data: TResult) => void;

  /**
   * Promise reject function
   */
  reject: (error: Error) => void;

  /**
   * Timeout timer
   */
  timer: TimeoutId;

  /**
   * Method name
   */
  method: string;

  /**
   * Session ID
   */
  sessionId: string;
}

/**
 * Type alias for router-level client subscription tracking
 * Maps method names to sets of client IDs
 */
export type MethodSubscribers = Map<string, Set<string>>;

/**
 * Type alias for router-level session subscription tracking
 * Maps session IDs to method subscriber maps
 */
export type RouterSubscriptions = Map<string, MethodSubscribers>;
