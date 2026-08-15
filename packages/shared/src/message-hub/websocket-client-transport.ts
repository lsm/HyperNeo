/**
 * WebSocket Client Transport for MessageHub
 *
 * Client-side WebSocket transport without sessionId in URL
 */

// FIX P1: Type declaration for requestIdleCallback (browser API not in standard DOM types)
declare function requestIdleCallback(
  tcallback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
  toptions?: { timeout?: number }
): number;

import type { IMessageTransport, ConnectionState, ConnectionStateHandler } from './types.ts';
import type { HubMessage } from './protocol.ts';
import { generateUUID } from '../utils.ts';
import { createLogger } from '../logger.ts';

// Define UnsubscribeFn locally (removed from types.ts)
type UnsubscribeFn = () => void;

// Create logger for WebSocket transport (uses unified log levels)
const log = createLogger('hyperneo:transport:client');

export interface WebSocketClientTransportOptions {
  /**
   * WebSocket URL (no sessionId in path!)
   */
  url: string;

  /**
   * Auto-reconnect on disconnect
   */
  autoReconnect?: boolean;

  /**
   * Maximum reconnection attempts
   */
  maxReconnectAttempts?: number;

  /**
   * Base reconnection delay in milliseconds
   */
  reconnectDelay?: number;

  /**
   * Heartbeat/ping interval in milliseconds
   */
  pingInterval?: number;

  /**
   * PONG timeout in milliseconds (time to wait for PONG response before considering connection stale)
   * FIX P4: Made configurable, reduced default from 60000 to 45000
   */
  pongTimeout?: number;
}

/**
 * WebSocket client transport for MessageHub
 */
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

  // Keep requests below the response budget while accepting all valid server frames.
  private readonly maxOutboundMessageSize = 32 * 1024 * 1024;
  private readonly maxInboundMessageSize = 40 * 1024 * 1024;

  // FIX P1.2: PONG timeout detection (stale connection detection)
  private lastPongTime: number = Date.now();
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // FIX P1: Backup heartbeat tracking (for background tab throttling detection)
  private lastPingSentTime: number = 0;
  private backupHeartbeatScheduled: boolean = false;
  private readonly stallDetectionThreshold: number = 45000; // 1.5x ping interval

  constructor(options: WebSocketClientTransportOptions) {
    this.url = options.url;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.pingInterval = options.pingInterval ?? 30000;
    this.pongTimeout = options.pongTimeout ?? 45000; // FIX P4: Reduced from 60000 to 45000
  }

  /**
   * Initialize transport (connect)
   */
  async initialize(): Promise<void> {
    return this.connect();
  }

  /**
   * Connect to WebSocket
   */
  private async connect(): Promise<void> {
    // Prevent connection after close() has been called
    if (this.closed) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.setState('connecting');

    return new Promise((resolve, reject) => {
      // Track whether this connect attempt ever succeeded. If the socket
      // closes or errors before `onopen`, reject so the caller (e.g.
      // transport.initialize()) doesn't hang forever waiting for an open
      // that will never arrive. Without this, a refused/unauthorized WS
      // upgrade surfaces as a silent 30s+ timeout instead of an error.
      let connectResolved = false;

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          if (connectResolved) return;
          connectResolved = true;
          log.info(`Connected to ${this.url}`);
          this.setState('connected');
          this.reconnectAttempts = 0;
          this.startPing();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          log.error(`WebSocket error:`, error);
          this.setState('error', new Error('WebSocket error'));
        };

        this.ws.onclose = (event) => {
          log.info(`Disconnected (code=${event.code})`);
          this.setState('disconnected');
          this.stopPing();
          // If the initial connection never opened, reject the connect()
          // promise so callers awaiting initialize() see the failure rather
          // than hanging. Then let handleDisconnect schedule a reconnect.
          if (!connectResolved) {
            connectResolved = true;
            reject(new Error(`WebSocket to ${this.url} closed before open (code=${event.code})`));
          }
          this.handleDisconnect();
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.setState('error', err);
        reject(err);
      }
    });
  }

  /**
   * Handle disconnect
   *
   * FIX P1.2: Add jitter to prevent thundering herd on reconnect
   */
  private handleDisconnect(): void {
    // Prevent reconnection after close() has been called
    if (this.closed) {
      return;
    }

    if (!this.autoReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      // Emit 'failed' state to notify UI that reconnection has permanently failed
      this.setState('failed');
      return;
    }

    this.reconnectAttempts++;

    // FIX P1.2: Add exponential backoff + jitter (±30%) to prevent thundering herd
    const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = Math.random() * baseDelay * 0.6 - baseDelay * 0.3; // ±30%
    const delay = Math.max(100, baseDelay + jitter); // Minimum 100ms

    log.debug(
      `Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        log.error(`Reconnection failed:`, error);
      });
    }, delay);
  }

  /**
   * Send a message
   * FIX P0.5: Wrap send in try-catch to handle race condition where
   * WebSocket closes between isReady() check and send() call
   * FIX P1.1: Validate message size before sending (DoS prevention)
   */
  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error('WebSocket not connected');
    }

    try {
      const json = JSON.stringify(message);

      // FIX P1.1: Validate message size before sending
      const messageSize = new TextEncoder().encode(json).length;
      if (messageSize > this.maxOutboundMessageSize) {
        throw new Error(
          `Message size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds maximum ${this.maxOutboundMessageSize / (1024 * 1024)}MB`
        );
      }

      this.ws!.send(json);
    } catch (error) {
      log.error(`Send failed:`, error);

      // Update state if WebSocket closed
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this.setState('disconnected');
      }

      throw new Error(
        `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Close transport
   */
  async close(): Promise<void> {
    // Set closed flag to prevent reconnection
    this.closed = true;

    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState('disconnected');
  }

  /**
   * Check if transport is ready
   */
  isReady(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get current reconnect attempt count (for UI status progression)
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Reset reconnection state to allow fresh reconnection attempts
   * Used when user manually triggers reconnect or returns from background
   */
  resetReconnectState(): void {
    this.closed = false;
    this.reconnectAttempts = 0;
    log.debug(`Reconnect state reset - ready for fresh connection attempt`);
  }

  /**
   * Force close and trigger reconnection
   * Unlike close(), this does NOT set closed=true, allowing auto-reconnect
   */
  forceReconnect(): void {
    log.debug(`Force reconnect initiated`);

    // Reset state to allow reconnection
    this.resetReconnectState();

    // Stop ping timer
    this.stopPing();

    // Close current WebSocket if exists
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Trigger handleDisconnect which will start reconnection
    // IMPORTANT: handleDisconnect increments reconnectAttempts before
    // we emit 'reconnecting' so listeners read the correct count.
    this.handleDisconnect();
    // Only set reconnecting if handleDisconnect didn't set 'failed'
    // (won't happen after resetReconnectState since attempts=0)
    if (this.state !== 'failed') {
      this.setState('reconnecting');
    }
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
   * Handle incoming message
   * FIX P1.1: Validate message size before parsing (DoS prevention)
   * FIX P1.2: Track PONG responses to detect stale connections
   */
  private handleMessage(data: string): void {
    try {
      // FIX P1.1: Validate message size before parsing
      const messageSize = new TextEncoder().encode(data).length;
      if (messageSize > this.maxInboundMessageSize) {
        log.error(
          `Message rejected: size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds limit ${this.maxInboundMessageSize / (1024 * 1024)}MB`
        );
        return;
      }

      const message = JSON.parse(data) as HubMessage;

      // FIX P1.2: Track PONG responses for connection health
      if (message.type === 'PONG') {
        this.lastPongTime = Date.now();
      }

      // Notify all handlers
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

  /**
   * Set connection state
   */
  private setState(state: ConnectionState, error?: Error): void {
    if (this.state === state) {
      return;
    }

    this.state = state;

    // Notify all handlers
    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch (err) {
        log.error(`Error in connection handler:`, err);
      }
    }
  }

  /**
   * Start ping/heartbeat
   *
   * FIX P1.1: Send real PING messages to detect half-open connections
   * FIX P1.2: Check for PONG timeout to detect stale connections
   * FIX P1: Track lastPingSentTime and schedule backup heartbeat
   */
  private startPing(): void {
    if (this.pingInterval <= 0) {
      return;
    }

    this.stopPing();

    // FIX P1.2: Reset lastPongTime when starting ping
    this.lastPongTime = Date.now();
    // FIX P1: Track when we last sent a ping for stall detection
    this.lastPingSentTime = Date.now();

    this.pingTimer = setInterval(() => {
      if (this.isReady()) {
        // FIX P1.2: Check if PONG timeout exceeded
        const timeSinceLastPong = Date.now() - this.lastPongTime;
        if (timeSinceLastPong > this.pongTimeout) {
          log.error(
            `PONG timeout exceeded (${Math.round(timeSinceLastPong / 1000)}s > ${this.pongTimeout / 1000}s). Connection appears stale.`
          );
          // Force disconnect and reconnect
          if (this.ws) {
            this.ws.close();
          }
          this.handleDisconnect();
          return;
        }

        // FIX P1: Use extracted sendPing method
        this.sendPing();
      }
    }, this.pingInterval);

    // FIX P1: Schedule backup heartbeat for background tab throttling detection
    this.scheduleBackupHeartbeat();
  }

  /**
   * Stop ping/heartbeat
   * FIX P1.2: Clear PONG timeout timer
   * FIX P1: Reset backup heartbeat flag
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }

    // FIX P1: Reset backup heartbeat state
    this.backupHeartbeatScheduled = false;
  }

  /**
   * Send PING message to server
   * FIX P1: Extracted for reuse by main timer and backup heartbeat
   */
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

  /**
   * Check if main ping timer appears stalled (background tab throttling)
   * FIX P1: Helper for backup heartbeat
   */
  private isPingTimerStalled(): boolean {
    return Date.now() - this.lastPingSentTime > this.stallDetectionThreshold;
  }

  /**
   * Schedule backup heartbeat check using requestIdleCallback
   * FIX P1: This is less susceptible to background tab throttling
   */
  private scheduleBackupHeartbeat(): void {
    if (this.backupHeartbeatScheduled || typeof requestIdleCallback === 'undefined') {
      return;
    }

    this.backupHeartbeatScheduled = true;

    requestIdleCallback(
      () => {
        this.backupHeartbeatScheduled = false;

        if (!this.isReady()) return;

        // Check if main timer is stalled
        if (this.isPingTimerStalled()) {
          log.debug('Main ping timer appears stalled, sending backup PING');
          this.sendPing();
        }

        // Schedule next backup check
        if (this.isReady()) {
          this.scheduleBackupHeartbeat();
        }
      },
      { timeout: 15000 }
    ); // 15s max wait
  }
}
