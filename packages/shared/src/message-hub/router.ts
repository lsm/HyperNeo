import { ChannelManager } from './channel-manager.ts';
import type { HubMessage } from './protocol.ts';
import { isEventMessage } from './protocol.ts';

export interface ClientConnection {
  id: string;
  send(data: string): void;
  isOpen(): boolean;
  canAccept?(): boolean;
  metadata?: Record<string, unknown>;
}

export interface RouterLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface MessageHubRouterOptions {
  logger?: RouterLogger;
  debug?: boolean;
  maxMessageSize?: number;
  maxSubscriptionsPerClient?: number;
}

export const DEFAULT_MAX_OUTBOUND_MESSAGE_SIZE = 40 * 1024 * 1024;

export const DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT = 128;

export type SendToClientResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unavailable' | 'serialization_failed' | 'message_too_large' | 'send_failed';
    };

export type SubscriptionCapacityResult =
  | { ok: true }
  | { ok: false; reason: 'too_many_subscriptions'; limit: number; current: number };

interface ClientInfo {
  clientId: string;
  connection: ClientConnection;
  connectedAt: number;
}

export interface RouteResult {
  sent: number;
  failed: number;
  totalSubscribers: number;
  sessionId: string;
  method: string;
}

export class MessageHubRouter {
  private clients: Map<string, ClientInfo> = new Map();
  private channelManager: ChannelManager = new ChannelManager();

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

  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch {
      const ancestors: unknown[] = [];
      return JSON.stringify(obj, function (_key, value) {
        if (typeof value !== 'object' || value === null) {
          return value;
        }

        if (value.constructor?.name === 'AgentSession') {
          return '[AgentSession]';
        }

        while (ancestors.length > 0 && ancestors.at(-1) !== this) {
          ancestors.pop();
        }

        if (ancestors.includes(value)) {
          return '[Circular]';
        }

        ancestors.push(value);
        return value;
      });
    }
  }

  registerConnection(connection: ClientConnection): string {
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
    this.channelManager.joinChannel(connection.id, 'global');
    this.log(`Client registered: ${connection.id}`);

    return connection.id;
  }

  unregisterConnection(clientId: string): void {
    const info = this.clients.get(clientId);
    if (!info) {
      return;
    }

    this.channelManager.removeClient(clientId);

    this.clientSubscriptionCounts.delete(clientId);

    this.clients.delete(clientId);
    this.log(`Client unregistered: ${info.clientId}`);
  }

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

    return this.routeEventToChannel(message);
  }

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

  broadcast(message: HubMessage): {
    sent: number;
    failed: number;
    skipped?: number;
  } {
    let json: string | null;
    try {
      json = this.serializeForSend(message);
      if (json === null) {
        return { sent: 0, failed: this.clients.size, skipped: 0 };
      }
    } catch (error) {
      this.logger.error(`[MessageHubRouter] Failed to serialize broadcast message:`, error);
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

  getClientById(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

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

  addClientSubscription(clientId: string): void {
    const next = (this.clientSubscriptionCounts.get(clientId) ?? 0) + 1;
    this.clientSubscriptionCounts.set(clientId, next);
  }

  releaseClientSubscription(clientId: string): void {
    const current = this.clientSubscriptionCounts.get(clientId);
    if (current === undefined) return;
    if (current <= 1) {
      this.clientSubscriptionCounts.delete(clientId);
    } else {
      this.clientSubscriptionCounts.set(clientId, current - 1);
    }
  }

  getClientSubscriptionCount(clientId: string): number {
    return this.clientSubscriptionCounts.get(clientId) ?? 0;
  }

  joinChannel(clientId: string, channel: string): void {
    const client = this.getClientById(clientId);
    if (!client) {
      this.logger.warn(`[MessageHubRouter] Cannot join channel - client not found: ${clientId}`);
      return;
    }
    this.channelManager.joinChannel(clientId, channel);
    this.log(`Client ${clientId} joined channel: ${channel}`);
  }

  leaveChannel(clientId: string, channel: string): void {
    this.channelManager.leaveChannel(clientId, channel);
    this.log(`Client ${clientId} left channel: ${channel}`);
  }

  routeEventToChannel(message: HubMessage): RouteResult {
    const channel = message.channel || 'global';
    const members = this.channelManager.getChannelMembers(channel);

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

  getChannelManager(): ChannelManager {
    return this.channelManager;
  }

  private log(_message: string, ..._args: unknown[]): void {
    // Debug logging disabled - only errors are logged
  }
}
