import type { RuntimeSocket } from './runtime-server/index.ts';
import { Logger, emitStructuredLogEvent } from './logger.ts';
import { onDeviceRevoked, type UpgradeIdentity } from './pairing/upgrade-auth.ts';
import type { HubMessage, IMessageTransport, ConnectionState } from '@hyperneo/shared';
import type { HubMessageWithMetadata } from '@hyperneo/shared/message-hub/protocol';
import type { MessageHubRouter, ClientConnection } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';

export interface WebSocketServerTransportOptions {
  name?: string;
  debug?: boolean;
  router: MessageHubRouter;
  maxQueueSize?: number;
  maxQueueBytes?: number;
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
  private readonly maxQueueBytes: number;

  private wsToClientId: Map<RuntimeSocket, string> = new Map();
  private clientIdToWs: Map<string, RuntimeSocket> = new Map();
  private readonly stopRevocations = onDeviceRevoked((deviceId) => this.closeDevice(deviceId));

  private clientQueues = new Map<string, { drain(): void; size(): number }>();

  private lastActivityTime: Map<string, number> = new Map();
  private readonly staleTimeout: number;
  private readonly staleCheckInterval: number;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebSocketServerTransportOptions) {
    this.name = options.name || 'websocket-server';
    this.router = options.router;
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.maxQueueBytes = options.maxQueueBytes ?? 32 * 1024 * 1024;
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
    this.stopRevocations();

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
    const pending: { data: string; bytes: number }[] = [];
    let queuedBytes = 0;
    let blocked = false;
    let failed = false;
    let windowStart = Date.now();
    let messages = 0;
    let bytes = 0;

    const diagnose = (reason: string, data: string, messageBytes: number) => {
      let envelope: Partial<HubMessage> = {};
      try {
        envelope = JSON.parse(data);
      } catch {}
      const seconds = Math.max(1, (Date.now() - windowStart) / 1000);
      emitStructuredLogEvent({
        level: reason === 'backpressure' || reason === 'socket_closing' ? 'info' : 'warn',
        source: 'logger',
        module: 'hyperneo:daemon:websocket',
        args: ['client.websocket.pressure'],
        metadata: {
          clientId,
          reason,
          type: envelope?.type,
          method: envelope?.method,
          messageBytes,
          bufferedBytes: ws.getBufferedAmount?.() ?? null,
          queuedBytes,
          queuedMessages: pending.length,
          readyState: ws.readyState,
          messagesPerSecond: messages / seconds,
          bytesPerSecond: bytes / seconds,
        },
      });
    };
    const fail = (reason: string, data: string, size: number) => {
      diagnose(reason, data, size);
      failed = true;
      pending.length = 0;
      queuedBytes = 0;
      ws.close(1011, 'Message dropped; reconnect to resync');
      throw new Error(`Message dropped for client ${clientId}; ${reason}`);
    };
    const write = (data: string, size: number) => {
      const sent = ws.send(data);
      if (sent === 0) {
        if (ws.readyState !== 1) {
          diagnose('socket_closing', data, size);
          failed = true;
          pending.length = 0;
          queuedBytes = 0;
          return;
        }
        fail('runtime_overflow', data, size);
      }
      if (sent === -1) {
        blocked = true;
        diagnose('backpressure', data, size);
      }
    };
    this.clientQueues.set(clientId, {
      size: () => pending.length,
      drain: () => {
        blocked = false;
        try {
          while (pending.length && !blocked && !failed && ws.readyState === 1) {
            const item = pending.shift()!;
            queuedBytes -= item.bytes;
            write(item.data, item.bytes);
          }
        } catch (error) {
          this.logger.error('Failed to drain client queue:', error);
        }
      },
    });

    const connection: ClientConnection = {
      id: clientId,
      send: (data: string) => {
        if (failed || ws.readyState !== 1) return;
        const size = new Blob([data]).size;
        if (Date.now() - windowStart >= 1000) {
          windowStart = Date.now();
          messages = 0;
          bytes = 0;
        }
        messages++;
        bytes += size;
        if (!blocked) return write(data, size);
        if (pending.length >= this.maxQueueSize || queuedBytes + size > this.maxQueueBytes)
          return fail('queue_overflow', data, size);
        pending.push({ data, bytes: size });
        queuedBytes += size;
      },
      isOpen: () => !failed && ws.readyState === 1,
      canAccept: () => true,
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

  handleDrain(ws: RuntimeSocket): void {
    const clientId = this.wsToClientId.get(ws);
    if (clientId) this.clientQueues.get(clientId)?.drain();
  }

  closeDevice(deviceId: string): void {
    for (const ws of this.clientIdToWs.values())
      if ((ws.data as { device?: UpgradeIdentity | null })?.device?.deviceId === deviceId)
        ws.close(1008, 'Device revoked');
  }

  deviceOf(clientId: string): UpgradeIdentity | null {
    const data = this.clientIdToWs.get(clientId)?.data as { device?: UpgradeIdentity | null };
    return data?.device ?? null;
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
    return this.getClientQueueSize(clientId) < this.maxQueueSize;
  }

  getClientQueueSize(clientId: string): number {
    return this.clientQueues.get(clientId)?.size() ?? 0;
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
