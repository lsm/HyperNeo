declare function requestIdleCallback(
  tcallback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
  toptions?: { timeout?: number }
): number;

import type { IMessageTransport, ConnectionState, ConnectionStateHandler } from './types.ts';
import type { HubMessage } from './protocol.ts';
import { generateUUID } from '../utils.ts';
import { createLogger } from '../logger.ts';

type UnsubscribeFn = () => void;

const log = createLogger('hyperneo:transport:client');

export interface WebSocketClientTransportOptions {
  url: string;

  autoReconnect?: boolean;

  maxReconnectAttempts?: number;

  reconnectDelay?: number;

  pingInterval?: number;

  pongTimeout?: number;
}

export class WebSocketClientTransport implements IMessageTransport {
  readonly name = 'websocket-client';

  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly pingInterval: number;
  private readonly pongTimeout: number;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<ConnectionStateHandler> = new Set();

  private readonly maxOutboundMessageSize = 32 * 1024 * 1024;
  private readonly maxInboundMessageSize = 40 * 1024 * 1024;

  private lastPongTime: number = Date.now();
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private lastPingSentTime: number = 0;
  private backupHeartbeatScheduled: boolean = false;
  private readonly stallDetectionThreshold: number = 45000;

  constructor(options: WebSocketClientTransportOptions) {
    this.url = options.url;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.pingInterval = options.pingInterval ?? 30000;
    this.pongTimeout = options.pongTimeout ?? 45000;
  }

  async initialize(): Promise<void> {
    return this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.setState('connecting');

    return new Promise((resolve, reject) => {
      let connectResolved = false;

      try {
        this.ws = new WebSocket(this.url);
        const ws = this.ws;

        ws.onopen = () => {
          if (connectResolved) return;
          connectResolved = true;
          resolve();
          if (this.ws !== ws) return;
          log.info(`Connected to ${this.url}`);
          this.setState('connected');
          this.reconnectAttempts = 0;
          this.startPing();
        };

        ws.onmessage = (event) => {
          if (this.ws !== ws) return;
          this.handleMessage(event.data);
        };

        ws.onerror = (error) => {
          if (this.ws !== ws) return;
          log.error(`WebSocket error:`, error);
          this.setState('error', new Error('WebSocket error'));
        };

        ws.onclose = (event) => {
          if (!connectResolved) {
            connectResolved = true;
            reject(new Error(`WebSocket to ${this.url} closed before open (code=${event.code})`));
          }
          if (this.ws !== ws) return;
          log.info(`Disconnected (code=${event.code})`);
          this.setState('disconnected');
          this.stopPing();
          this.handleDisconnect();
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.setState('error', err);
        reject(err);
      }
    });
  }

  private handleDisconnect(): void {
    if (this.closed) {
      return;
    }

    if (!this.autoReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      this.setState('failed');
      return;
    }

    this.reconnectAttempts++;

    const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = Math.random() * baseDelay * 0.6 - baseDelay * 0.3;
    const delay = Math.max(100, baseDelay + jitter);

    log.debug(
      `Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        log.error(`Reconnection failed:`, error);
      });
    }, delay);
  }

  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error('WebSocket not connected');
    }

    try {
      const json = JSON.stringify(message);

      const messageSize = new TextEncoder().encode(json).length;
      if (messageSize > this.maxOutboundMessageSize) {
        throw new Error(
          `Message size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds maximum ${this.maxOutboundMessageSize / (1024 * 1024)}MB`
        );
      }

      this.ws!.send(json);
    } catch (error) {
      log.error(`Send failed:`, error);

      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this.setState('disconnected');
      }

      throw new Error(
        `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState('disconnected');
  }

  isReady(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  resetReconnectState(): void {
    this.closed = false;
    this.reconnectAttempts = 0;
    log.debug(`Reconnect state reset - ready for fresh connection attempt`);
  }

  forceReconnect(): void {
    log.debug(`Force reconnect initiated`);

    this.resetReconnectState();

    this.stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.handleDisconnect();
    if (this.state !== 'failed') {
      this.setState('reconnecting');
    }
  }

  onMessage(handler: (message: HubMessage) => void): UnsubscribeFn {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  private handleMessage(data: string): void {
    try {
      const messageSize = new TextEncoder().encode(data).length;
      if (messageSize > this.maxInboundMessageSize) {
        log.error(
          `Message rejected: size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds limit ${this.maxInboundMessageSize / (1024 * 1024)}MB`
        );
        return;
      }

      const message = JSON.parse(data) as HubMessage;

      if (message.type === 'PONG') {
        this.lastPongTime = Date.now();
      }

      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (error) {
          log.error(`Error in message handler:`, error);
        }
      }
    } catch (error) {
      log.error(`Failed to parse message:`, error);
    }
  }

  private setState(state: ConnectionState, error?: Error): void {
    if (this.state === state) {
      return;
    }

    this.state = state;

    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        log.error(`Error in connection handler:`, err);
      }
    }
  }

  private startPing(): void {
    if (this.pingInterval <= 0) {
      return;
    }

    this.stopPing();

    this.lastPongTime = Date.now();
    this.lastPingSentTime = Date.now();

    this.pingTimer = setInterval(() => {
      if (this.isReady()) {
        const timeSinceLastPong = Date.now() - this.lastPongTime;
        if (timeSinceLastPong > this.pongTimeout) {
          log.error(
            `PONG timeout exceeded (${Math.round(timeSinceLastPong / 1000)}s > ${this.pongTimeout / 1000}s). Connection appears stale.`
          );
          if (this.ws) {
            this.ws.close();
          }
          this.handleDisconnect();
          return;
        }

        this.sendPing();
      }
    }, this.pingInterval);

    this.scheduleBackupHeartbeat();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }

    this.backupHeartbeatScheduled = false;
  }

  private sendPing(): void {
    if (!this.isReady()) return;

    this.lastPingSentTime = Date.now();
    const pingMessage = {
      id: generateUUID(),
      type: 'PING' as const,
      method: 'heartbeat',
      sessionId: 'global',
      timestamp: new Date().toISOString(),
    };

    try {
      this.ws!.send(JSON.stringify(pingMessage));
    } catch (error) {
      log.error(`Failed to send PING:`, error);
      this.handleDisconnect();
    }
  }

  private isPingTimerStalled(): boolean {
    return Date.now() - this.lastPingSentTime > this.stallDetectionThreshold;
  }

  private scheduleBackupHeartbeat(): void {
    if (this.backupHeartbeatScheduled || typeof requestIdleCallback === 'undefined') {
      return;
    }

    this.backupHeartbeatScheduled = true;

    requestIdleCallback(
      () => {
        this.backupHeartbeatScheduled = false;

        if (!this.isReady()) return;

        if (this.isPingTimerStalled()) {
          log.debug('Main ping timer appears stalled, sending backup PING');
          this.sendPing();
        }

        if (this.isReady()) {
          this.scheduleBackupHeartbeat();
        }
      },
      { timeout: 15000 }
    );
  }
}
