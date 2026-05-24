/**
 * Server-Side WebSocket Transport for MessageHub
 *
 * PHASE 3 ARCHITECTURE (FIXED):
 * - Pure I/O layer - handles WebSocket send/receive only
 * - Uses Router for CLIENT MANAGEMENT (register connections, subscriptions)
 * - NO ROUTING LOGIC - MessageHub handles routing, Transport handles I/O
 * - Provides sendToClient() for targeted sends (called by MessageHub via Router)
 */

import type { ServerWebSocket } from 'bun';
import { Logger } from './logger';
import type { HubMessage, IMessageTransport, ConnectionState } from '@neokai/shared';
import type { HubMessageWithMetadata } from '@neokai/shared/message-hub/protocol';
import type { MessageHubRouter, ClientConnection } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';

export interface WebSocketServerTransportOptions {
  name?: string;
  debug?: boolean;
  router: MessageHubRouter; // For client management only, not routing
  maxQueueSize?: number; // Backpressure: max queued messages per client
  /**
   * Stale connection timeout in ms (default: 120000 = 2 minutes)
   * Connections without ping activity for this duration will be closed
   */
  staleTimeout?: number;
  /**
   * Interval for checking stale connections in ms (default: 30000 = 30 seconds)
   */
  staleCheckInterval?: number;
}

/**
 * Server-Side WebSocket Transport - Pure I/O Layer
 *
 * Responsibilities:
 * - Create ClientConnection wrappers for Bun WebSockets
 * - Forward incoming messages to MessageHub handlers
 * - Delegate all routing to MessageHubRouter
 */
export class WebSocketServerTransport implements IMessageTransport {
  private logger = new Logger('WebSocketServerTransport');
  readonly name: string;
  private router: MessageHubRouter;
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
  private clientDisconnectHandlers: Set<(clientId: string) => void> = new Set();
  private readonly maxQueueSize: number;

  // FIX P2.2: Bidirectional mapping for O(1) lookups
  private wsToClientId: Map<ServerWebSocket<unknown>, string> = new Map();
  private clientIdToWs: Map<string, ServerWebSocket<unknown>> = new Map();

  // Backpressure: track pending messages per client
  private clientQueues: Map<string, number> = new Map();

  // Stale connection detection
  private lastActivityTime: Map<string, number> = new Map();
  private readonly staleTimeout: number;
  private readonly staleCheckInterval: number;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebSocketServerTransportOptions) {
    this.name = options.name || 'websocket-server';
    this.router = options.router;
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.staleTimeout = options.staleTimeout || 120000; // 2 minutes default
    this.staleCheckInterval = options.staleCheckInterval || 30000; // 30 seconds default
  }

  /**
   * Initialize transport and start stale connection checker
   */
  async initialize(): Promise<void> {
    this.startStaleConnectionChecker();
  }

  /**
   * Start periodic stale connection checker
   */
  private startStaleConnectionChecker(): void {
    if (this.staleCheckTimer) {
      return; // Already running
    }

    this.staleCheckTimer = setInterval(() => {
      this.checkStaleConnections();
    }, this.staleCheckInterval);
  }

  /**
   * Stop stale connection checker
   */
  private stopStaleConnectionChecker(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  /**
   * Check for and close stale connections
   */
  private checkStaleConnections(): void {
    const now = Date.now();
    const staleClientIds: string[] = [];

    for (const [clientId, lastActivity] of this.lastActivityTime) {
      const timeSinceActivity = now - lastActivity;
      if (timeSinceActivity > this.staleTimeout) {
        staleClientIds.push(clientId);
      }
    }

    // Close stale connections
    for (const clientId of staleClientIds) {
      const ws = this.clientIdToWs.get(clientId);
      if (ws) {
        try {
          ws.close(1000, 'Connection timed out due to inactivity');
        } catch (error) {
          this.logger.error(`[${this.name}] Error closing stale connection ${clientId}:`, error);
        }
      }
      // Cleanup will happen in the close handler
      this.unregisterClient(clientId);
    }
  }

  /**
   * Update last activity time for a client (call on ping/any message)
   */
  updateClientActivity(clientId: string): void {
    if (this.lastActivityTime.has(clientId)) {
      this.lastActivityTime.set(clientId, Date.now());
    }
  }

  /**
   * Re-verify channel membership for a client (self-healing)
   * Ensures client is in expected channels, re-joins if missing
   * This recovers from stale connection cleanup removing clients from channels
   *
   * @param clientId The client to verify
   * @param expectedChannels Channels the client should be in
   */
  verifyChannelMembership(clientId: string, expectedChannels: string[]): void {
    const router = this.getRouter();
    if (!router) {
      this.logger.debug(`Cannot verify channels - no router available`);
      return;
    }

    const channelManager = router.getChannelManager();
    let rejoined = 0;

    for (const channel of expectedChannels) {
      if (!channelManager.isInChannel(clientId, channel)) {
        this.logger.debug(`[Self-healing] Re-joining client ${clientId} to channel ${channel}`);
        router.joinChannel(clientId, channel);
        rejoined++;
      }
    }

    if (rejoined > 0) {
      this.logger.info(`[Self-healing] Restored ${rejoined} channel(s) for client ${clientId}`);
    }
  }

  /**
   * Close transport and cleanup all connections
   * FIX P2.2: Clear both bidirectional maps
   */
  async close(): Promise<void> {
    // Stop stale connection checker
    this.stopStaleConnectionChecker();

    // Unregister all clients
    const clientIds = Array.from(this.clientIdToWs.keys());
    for (const clientId of clientIds) {
      this.unregisterClient(clientId);
    }

    // FIX P2.2: Clear both mappings
    this.wsToClientId.clear();
    this.clientIdToWs.clear();
    this.lastActivityTime.clear();

    // Notify connection handlers
    this.notifyConnectionHandlers('disconnected');
  }

  /**
   * Register a WebSocket client
   * Creates a ClientConnection and registers with router
   * @param ws Bun ServerWebSocket with any data type
   * @param connectionSessionId Initial session ID for the connection
   */
  registerClient(ws: ServerWebSocket<unknown>, connectionSessionId: string): string {
    // Generate client ID first (no mutation needed)
    const clientId = generateUUID();

    // Create connection wrapper with ID already set
    const connection: ClientConnection = {
      id: clientId,
      send: (data: string) => {
        // Backpressure check
        const queueSize = this.clientQueues.get(clientId) || 0;
        if (queueSize >= this.maxQueueSize) {
          throw new Error(`Message queue full for client ${clientId} (max: ${this.maxQueueSize})`);
        }

        try {
          this.clientQueues.set(clientId, queueSize + 1);
          ws.send(data);
          // Decrement after successful send
          this.clientQueues.set(clientId, queueSize);
        } catch (error) {
          this.clientQueues.set(clientId, queueSize); // Revert on error
          this.logger.error(`[${this.name}] Failed to send:`, error);
          throw error;
        }
      },
      isOpen: () => ws.readyState === 1, // Bun WebSocket OPEN state
      // FIX P0.6: Add canAccept() for backpressure checking
      canAccept: () => {
        const queueSize = this.clientQueues.get(clientId) || 0;
        return queueSize < this.maxQueueSize;
      },
      metadata: {
        ws,
        connectionSessionId,
      },
    };

    // Register with router
    this.router.registerConnection(connection);

    // FIX P2.2: Track bidirectional mapping for O(1) cleanup
    this.wsToClientId.set(ws, clientId);
    this.clientIdToWs.set(clientId, ws);

    // Initialize activity time for stale connection detection
    this.lastActivityTime.set(clientId, Date.now());

    // Notify connection handlers
    if (this.router.getClientCount() === 1) {
      this.notifyConnectionHandlers('connected');
    }

    return clientId;
  }

  /**
   * Unregister a WebSocket client
   * FIX P2.2: O(1) lookup using bidirectional mapping
   */
  unregisterClient(clientId: string): void {
    // FIX P2.2: O(1) reverse lookup instead of O(n) iteration
    const ws = this.clientIdToWs.get(clientId);
    if (ws) {
      this.wsToClientId.delete(ws);
      this.clientIdToWs.delete(clientId);
    }

    // Clean up queue tracking
    this.clientQueues.delete(clientId);

    // Clean up activity tracking
    this.lastActivityTime.delete(clientId);

    // Unregister from router
    this.router.unregisterConnection(clientId);

    // Notify client disconnect handlers (for per-client cleanup)
    for (const handler of this.clientDisconnectHandlers) {
      try {
        handler(clientId);
      } catch (error) {
        this.logger.error(`[${this.name}] Error in client disconnect handler:`, error);
      }
    }

    // Notify connection handlers if no clients left
    if (this.router.getClientCount() === 0) {
      this.notifyConnectionHandlers('disconnected');
    }
  }

  /**
   * Handle incoming message from a WebSocket client
   * Adds clientId to message for subscription tracking
   */
  handleClientMessage(message: HubMessage, clientId?: string): void {
    // Add clientId to message metadata for SUBSCRIBE/UNSUBSCRIBE handling
    // MessageHub needs this to track which client subscribed
    if (clientId) {
      (message as HubMessageWithMetadata).clientId = clientId;
    }

    // Notify all message handlers (MessageHub will process)
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.logger.error(`[${this.name}] Error in message handler:`, error);
      }
    }
  }

  /**
   * Send message (deprecated - MessageHub now handles routing)
   *
   * @deprecated MessageHub now routes EVENT messages via Router directly.
   * This method is kept for backwards compatibility and non-EVENT messages.
   *
   * New architecture flow:
   * - MessageHub.sendMessage() checks if Router is registered
   * - If yes: MessageHub → Router.routeEvent() → ClientConnection.send()
   * - If no: MessageHub → Transport.send() (this method)
   */
  async send(message: HubMessage): Promise<void> {
    // For EVENT messages: MessageHub should have routed via Router already
    // If we get here, it means no router registered (shouldn't happen server-side)
    if (message.type === 'EVENT') {
      this.logger.warn(
        `[${this.name}] EVENT message sent via deprecated path. ` +
          `MessageHub should route via Router.`
      );
      // Fallback: broadcast to all clients
      this.router.broadcast(message);
      return;
    }

    // For non-EVENT messages (CALL, RESULT, ERROR): broadcast
    this.router.broadcast(message);
  }

  /**
   * Subscribe to incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to connection state changes
   */
  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to client disconnect events (for per-client cleanup)
   */
  onClientDisconnect(handler: (clientId: string) => void): () => void {
    this.clientDisconnectHandlers.add(handler);
    return () => {
      this.clientDisconnectHandlers.delete(handler);
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.router.getClientCount() > 0 ? 'connected' : 'disconnected';
  }

  /**
   * Check if ready to send messages
   */
  isReady(): boolean {
    return this.router.getClientCount() > 0;
  }

  /**
   * Get number of connected clients (delegates to router)
   */
  getClientCount(): number {
    return this.router.getClientCount();
  }

  /**
   * Get client by ID (delegates to router)
   */
  getClient(clientId: string): unknown {
    return this.router.getClientById(clientId);
  }

  /**
   * Broadcast to all clients in a session
   * Uses router's routing logic
   */
  async broadcastToSession(sessionId: string, message: HubMessage): Promise<void> {
    const sessionMessage = { ...message, sessionId };
    await this.send(sessionMessage);
  }

  /**
   * Get the router instance
   */
  getRouter(): MessageHubRouter {
    return this.router;
  }

  /**
   * FIX P0.6: Check if client can accept messages (backpressure check)
   * Returns true if client queue is not full
   */
  canClientAccept(clientId: string): boolean {
    const queueSize = this.clientQueues.get(clientId) || 0;
    return queueSize < this.maxQueueSize;
  }

  /**
   * Get current queue size for a client
   */
  getClientQueueSize(clientId: string): number {
    return this.clientQueues.get(clientId) || 0;
  }

  private notifyConnectionHandlers(state: ConnectionState, error?: Error): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        this.logger.error(`[${this.name}] Error in connection handler:`, err);
      }
    }
  }
}
