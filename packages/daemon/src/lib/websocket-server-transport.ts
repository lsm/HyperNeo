import type { RuntimeSocket } from './runtime-server';
import { Logger } from './logger';
import type { HubMessage, IMessageTransport, ConnectionState } from '@hyperneo/shared';
import type { HubMessageWithMetadata } from '@hyperneo/shared/message-hub/protocol';
import type { MessageHubRouter, ClientConnection } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';

export interface WebSocketServerTransportOptions {
  name?: string;
  debug?: boolean;
  router: MessageHubRouter;
  maxQueueSize?: number;
  staleTimeout?: number;
  staleCheckInterval?: number;
}

export class WebSocketServerTransport implements IMessageTransport {
  private logger = new Logger('WebSocketServerTransport');
  readonly name: string;
  private router: MessageHubRouter;
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
  private clientDisconnectHandlers: Set<(clientId: string) => void> = new Set();
  private readonly maxQueueSize: number;

  private wsToClientId: Map<RuntimeSocket, string> = new Map();
  private clientIdToWs: Map<string, RuntimeSocket> = new Map();

  private clientQueues: Map<string, number> = new Map();

  private lastActivityTime: Map<string, number> = new Map();
  private readonly staleTimeout: number;
  private readonly staleCheckInterval: number;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebSocketServerTransportOptions) {
    this.name = options.name || 'websocket-server';
    this.router = options.router;
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.staleTimeout = options.staleTimeout || 120000;
    this.staleCheckInterval = options.staleCheckInterval || 30000;
  }

  async initialize(): Promise<void> {
    this.startStaleConnectionChecker();
  }

  private startStaleConnectionChecker(): void {
    if (this.staleCheckTimer) {
      return;
    }

    this.staleCheckTimer = setInterval(() => {
      this.checkStaleConnections();
    }, this.staleCheckInterval);
  }

  private stopStaleConnectionChecker(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private checkStaleConnections(): void {
    const now = Date.now();
    const staleClientIds: string[] = [];

    for (const [clientId, lastActivity] of this.lastActivityTime) {
      const timeSinceActivity = now - lastActivity;
      if (timeSinceActivity > this.staleTimeout) {
        staleClientIds.push(clientId);
      }
    }

    for (const clientId of staleClientIds) {
      const ws = this.clientIdToWs.get(clientId);
      if (ws) {
        try {
          ws.close(1000, 'Connection timed out due to inactivity');
        } catch (error) {
          this.logger.error(`[${this.name}] Error closing stale connection ${clientId}:`, error);
        }
      }
      this.unregisterClient(clientId);
    }
  }

  updateClientActivity(clientId: string): void {
    if (this.lastActivityTime.has(clientId)) {
      this.lastActivityTime.set(clientId, Date.now());
    }
  }

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

  async close(): Promise<void> {
    this.stopStaleConnectionChecker();

    const clientIds = Array.from(this.clientIdToWs.keys());
    for (const clientId of clientIds) {
      this.unregisterClient(clientId);
    }

    this.wsToClientId.clear();
    this.clientIdToWs.clear();
    this.lastActivityTime.clear();

    this.notifyConnectionHandlers('disconnected');
  }

  registerClient(ws: RuntimeSocket, connectionSessionId: string): string {
    const clientId = generateUUID();

    const connection: ClientConnection = {
      id: clientId,
      send: (data: string) => {
        const queueSize = this.clientQueues.get(clientId) || 0;
        if (queueSize >= this.maxQueueSize) {
          throw new Error(`Message queue full for client ${clientId} (max: ${this.maxQueueSize})`);
        }

        try {
          this.clientQueues.set(clientId, queueSize + 1);
          ws.send(data);
          this.clientQueues.set(clientId, queueSize);
        } catch (error) {
          this.clientQueues.set(clientId, queueSize);
          this.logger.error(`[${this.name}] Failed to send:`, error);
          throw error;
        }
      },
      isOpen: () => ws.readyState === 1,
      canAccept: () => {
        const queueSize = this.clientQueues.get(clientId) || 0;
        return queueSize < this.maxQueueSize;
      },
      metadata: {
        ws,
        connectionSessionId,
      },
    };

    this.router.registerConnection(connection);

    this.wsToClientId.set(ws, clientId);
    this.clientIdToWs.set(clientId, ws);

    this.lastActivityTime.set(clientId, Date.now());

    if (this.router.getClientCount() === 1) {
      this.notifyConnectionHandlers('connected');
    }

    return clientId;
  }

  unregisterClient(clientId: string): void {
    const ws = this.clientIdToWs.get(clientId);
    if (ws) {
      this.wsToClientId.delete(ws);
      this.clientIdToWs.delete(clientId);
    }

    this.clientQueues.delete(clientId);

    this.lastActivityTime.delete(clientId);

    this.router.unregisterConnection(clientId);

    for (const handler of this.clientDisconnectHandlers) {
      try {
        handler(clientId);
      } catch (error) {
        this.logger.error(`[${this.name}] Error in client disconnect handler:`, error);
      }
    }

    if (this.router.getClientCount() === 0) {
      this.notifyConnectionHandlers('disconnected');
    }
  }

  handleClientMessage(message: HubMessage, clientId?: string): void {
    if (clientId) {
      (message as HubMessageWithMetadata).clientId = clientId;
    }

    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.logger.error(`[${this.name}] Error in message handler:`, error);
      }
    }
  }

  async send(message: HubMessage): Promise<void> {
    if (message.type === 'EVENT') {
      this.logger.warn(
        `[${this.name}] EVENT message sent via deprecated path. ` +
          `MessageHub should route via Router.`
      );
      this.router.broadcast(message);
      return;
    }

    this.router.broadcast(message);
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  onClientDisconnect(handler: (clientId: string) => void): () => void {
    this.clientDisconnectHandlers.add(handler);
    return () => {
      this.clientDisconnectHandlers.delete(handler);
    };
  }

  getState(): ConnectionState {
    return this.router.getClientCount() > 0 ? 'connected' : 'disconnected';
  }

  isReady(): boolean {
    return this.router.getClientCount() > 0;
  }

  getClientCount(): number {
    return this.router.getClientCount();
  }

  getClient(clientId: string): unknown {
    return this.router.getClientById(clientId);
  }

  async broadcastToSession(sessionId: string, message: HubMessage): Promise<void> {
    const sessionMessage = { ...message, sessionId };
    await this.send(sessionMessage);
  }

  getRouter(): MessageHubRouter {
    return this.router;
  }

  canClientAccept(clientId: string): boolean {
    const queueSize = this.clientQueues.get(clientId) || 0;
    return queueSize < this.maxQueueSize;
  }

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
