/**
 * InProcessTransport - In-process MessageHub transport for component communication
 *
 * Allows MessageHub to be used for in-process communication between components.
 * All operations are async (even if immediate) for consistency with network transports.
 *
 * DESIGN PRINCIPLES:
 * 1. Same API as network transports (WebSocket, stdio)
 * 2. Async everywhere - enables future distribution to cluster
 * 3. No serialization overhead for in-process (pass by reference)
 * 4. Supports multiple paired transports (bidirectional pipes)
 *
 * USAGE:
 * ```typescript
 * // Create a paired transport (like a bidirectional pipe)
 * const [clientTransport, serverTransport] = InProcessTransport.createPair();
 *
 * // Or create a bus for multiple participants
 * const bus = new InProcessTransportBus();
 * const transport1 = bus.createTransport('component-1');
 * const transport2 = bus.createTransport('component-2');
 * ```
 */

import type {
  IMessageTransport,
  ConnectionState,
  ConnectionStateHandler,
  BroadcastResult,
} from './types.ts';
import type { HubMessage } from './protocol.ts';
import { generateUUID } from '../utils.ts';

// Define UnsubscribeFn locally (removed from types.ts)
type UnsubscribeFn = () => void;

/**
 * Options for InProcessTransport
 */
export interface InProcessTransportOptions {
  /**
   * Transport name for debugging
   */
  name?: string;

  /**
   * Simulate network latency (ms) - useful for testing
   * @default 0
   */
  simulatedLatency?: number;

  /**
   * Whether to deep clone messages (simulates serialization)
   * Set to true to catch serialization issues early
   * @default false
   */
  cloneMessages?: boolean;
}

/**
 * InProcessTransport - Connects two MessageHub instances in-process
 *
 * Messages are delivered asynchronously via microtask queue (queueMicrotask)
 * to maintain consistent async behavior with network transports.
 */
export class InProcessTransport implements IMessageTransport {
  readonly name: string;

  private peer: InProcessTransport | null = null;
  private state: ConnectionState = 'disconnected';
  private messageHandlers = new Set<(message: HubMessage) => void>();
  private connectionHandlers = new Set<ConnectionStateHandler>();
  private clientDisconnectHandlers = new Set<(clientId: string) => void>();

  private readonly simulatedLatency: number;
  private readonly cloneMessages: boolean;

  // For server-side: track connected clients
  private connectedClients = new Map<string, InProcessTransport>();
  private clientId: string;

  constructor(options: InProcessTransportOptions = {}) {
    this.name = options.name || 'in-process';
    this.simulatedLatency = options.simulatedLatency || 0;
    this.cloneMessages = options.cloneMessages || false;
    this.clientId = generateUUID();
  }

  /**
   * Create a paired transport (bidirectional pipe)
   * Returns [clientSide, serverSide]
   */
  static createPair(
    options: InProcessTransportOptions = {}
  ): [InProcessTransport, InProcessTransport] {
    const client = new InProcessTransport({
      ...options,
      name: options.name ? `${options.name}-client` : 'in-process-client',
    });
    const server = new InProcessTransport({
      ...options,
      name: options.name ? `${options.name}-server` : 'in-process-server',
    });

    client.peer = server;
    server.peer = client;

    // Register client with server
    server.connectedClients.set(client.clientId, client);

    return [client, server];
  }

  /**
   * Initialize transport (connect)
   */
  async initialize(): Promise<void> {
    if (!this.peer) {
      throw new Error('InProcessTransport not paired. Use createPair() or InProcessTransportBus.');
    }

    this.setState('connected');

    // Also set peer as connected if not already
    if (this.peer.state !== 'connected') {
      this.peer.setState('connected');
    }
  }

  /**
   * Send a message to peer
   */
  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error('InProcessTransport not connected');
    }

    const msgToSend = this.cloneMessages ? structuredClone(message) : message;

    // Deliver asynchronously to maintain consistent behavior
    await this.deliverAsync(() => {
      this.peer!.receiveMessage(msgToSend);
    });
  }

  /**
   * Send message to specific client (server-side)
   */
  async sendToClient(clientId: string, message: HubMessage): Promise<boolean> {
    const client = this.connectedClients.get(clientId);
    if (!client || !client.isReady()) {
      return false;
    }

    const msgToSend = this.cloneMessages ? structuredClone(message) : message;

    await this.deliverAsync(() => {
      client.receiveMessage(msgToSend);
    });

    return true;
  }

  /**
   * Broadcast to multiple clients (server-side)
   */
  async broadcastToClients(clientIds: string[], message: HubMessage): Promise<BroadcastResult> {
    let sent = 0;
    let failed = 0;

    const msgToSend = this.cloneMessages ? structuredClone(message) : message;

    for (const clientId of clientIds) {
      const success = await this.sendToClient(clientId, msgToSend);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    return {
      sent,
      failed,
      totalTargets: clientIds.length,
    };
  }

  /**
   * Close transport
   */
  async close(): Promise<void> {
    if (this.peer) {
      // Notify peer of disconnect
      const peerId = this.clientId;
      this.peer.connectedClients.delete(peerId);

      // Notify peer's disconnect handlers
      for (const handler of this.peer.clientDisconnectHandlers) {
        try {
          handler(peerId);
        } catch {
          // Ignore handler errors during cleanup
        }
      }
    }

    this.setState('disconnected');
    this.peer = null;
    this.connectedClients.clear();
  }

  /**
   * Check if transport is ready
   */
  isReady(): boolean {
    return this.state === 'connected' && this.peer !== null;
  }

  /**
   * Get connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Register handler for incoming messages
   */
  onMessage(handler: (message: HubMessage) => void): UnsubscribeFn {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Register handler for connection state changes
   */
  onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * Register handler for client disconnect (server-side)
   */
  onClientDisconnect(handler: (clientId: string) => void): UnsubscribeFn {
    this.clientDisconnectHandlers.add(handler);
    return () => {
      this.clientDisconnectHandlers.delete(handler);
    };
  }

  /**
   * Get client ID (for server-side tracking)
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Get connected client count (server-side)
   */
  getClientCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Receive message from peer (internal)
   */
  private receiveMessage(message: HubMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        // Message handler error - silently continue
      }
    }
  }

  /**
   * Set connection state and notify handlers
   */
  private setState(state: ConnectionState, error?: Error): void {
    if (this.state === state) {
      return;
    }

    this.state = state;

    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch {
        // Connection handler error - silently continue
      }
    }
  }

  /**
   * Deliver message asynchronously
   * Uses queueMicrotask for minimal latency while maintaining async semantics
   */
  private async deliverAsync(fn: () => void): Promise<void> {
    if (this.simulatedLatency > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatency));
      fn();
    } else {
      // Use microtask for minimal latency but still async
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          fn();
          resolve();
        });
      });
    }
  }
}

/**
 * InProcessTransportBus - Multi-party in-process communication
 *
 * Allows multiple components to communicate via MessageHub using
 * a shared bus. Each component gets its own transport that can
 * send to any other component.
 *
 * USAGE:
 * ```typescript
 * const bus = new InProcessTransportBus();
 *
 * // Create transports for each component
 * const stateManager = bus.createTransport('state-manager');
 * const sessionManager = bus.createTransport('session-manager');
 * const agentSession = bus.createTransport('agent-session');
 *
 * // Messages can now be routed between any components
 * ```
 */
export class InProcessTransportBus {
  private transports = new Map<string, InProcessTransport>();
  private options: InProcessTransportOptions;

  constructor(options: InProcessTransportOptions = {}) {
    this.options = options;
  }

  /**
   * Create a transport for a component
   */
  createTransport(name: string): InProcessTransport {
    if (this.transports.has(name)) {
      throw new Error(`Transport '${name}' already exists`);
    }

    const transport = new BusConnectedTransport(this, {
      ...this.options,
      name,
    });

    this.transports.set(name, transport);

    return transport;
  }

  /**
   * Get a transport by name
   */
  getTransport(name: string): InProcessTransport | undefined {
    return this.transports.get(name);
  }

  /**
   * Remove a transport
   */
  removeTransport(name: string): void {
    const transport = this.transports.get(name);
    if (transport) {
      transport.close();
      this.transports.delete(name);
    }
  }

  /**
   * Broadcast to all transports
   */
  broadcast(message: HubMessage, excludeName?: string): void {
    for (const [name, transport] of this.transports) {
      if (name !== excludeName && transport.isReady()) {
        transport['receiveMessage'](message);
      }
    }
  }

  /**
   * Get all transport names
   */
  getTransportNames(): string[] {
    return Array.from(this.transports.keys());
  }

  /**
   * Close all transports
   */
  async close(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close();
    }
    this.transports.clear();
  }
}

/**
 * Transport connected to a bus (internal class)
 */
class BusConnectedTransport extends InProcessTransport {
  private bus: InProcessTransportBus;

  constructor(bus: InProcessTransportBus, options: InProcessTransportOptions) {
    super(options);
    this.bus = bus;
  }

  async initialize(): Promise<void> {
    // Bus transports are always ready
    this['setState']('connected');
  }

  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Transport not connected');
    }

    // Broadcast to all other transports on the bus
    this.bus.broadcast(message, this.name);
  }

  isReady(): boolean {
    return this['state'] === 'connected';
  }
}
