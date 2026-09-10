import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import type { ConnectionState } from './state';
import { markAllSessionStoresRecovering } from './session-store';
import { ConnectionNotReadyError, ConnectionTimeoutError } from './errors';
import { createDeferred } from './timeout';
import { currentSessionIdSignal, slashCommandsSignal } from './signals';
import { runConnectionEvent } from './connection-event-pipeline';
import { runConnectionResume } from './connection-resume-pipeline';
import { createDefaultConnectionResumeEffects } from './connection-resume-adapter';
import { createDefaultConnectionEventEffects } from './connection-event-adapter';
import { createDefaultConnectionLifecycleEffects } from './connection-lifecycle-adapter';

if (typeof window !== 'undefined') {
  (
    window as unknown as {
      currentSessionIdSignal?: typeof currentSessionIdSignal;
    }
  ).currentSessionIdSignal = currentSessionIdSignal;
  (window as unknown as { slashCommandsSignal?: typeof slashCommandsSignal }).slashCommandsSignal =
    slashCommandsSignal;
}

type ConnectionHandler = () => void;

export function getDaemonWsUrl(
  loc: { hostname: string; port: string; protocol: string } | undefined = typeof window !==
  'undefined'
    ? window.location
    : undefined
): string {
  if (!loc) {
    return 'ws://localhost:8283';
  }

  const hostname = loc.hostname;
  const port = loc.port;
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';

  if (port) {
    return `${protocol}//${hostname}:${port}`;
  }

  return `${protocol}//${hostname}`;
}

export class ConnectionManager {
  private readonly lifecycleEffects = createDefaultConnectionLifecycleEffects();
  private messageHub: MessageHub | null = null;
  private transport: WebSocketClientTransport | null = null;
  private baseUrl: string;
  private connectionPromise: Promise<MessageHub> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;

  private stateValidationInterval: ReturnType<typeof setInterval> | null = null;
  private readonly stateValidationPeriod: number = 60000;

  private connectionHandlers: Set<ConnectionHandler> = new Set();

  private _isResuming = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getDaemonWsUrl();
    this.setupVisibilityHandlers();
  }

  getHubIfConnected(): MessageHub | null {
    if (this.messageHub && this.transport?.isReady()) {
      return this.messageHub;
    }
    return null;
  }

  getHubOrThrow(): MessageHub {
    const hub = this.getHubIfConnected();
    if (!hub) {
      throw new ConnectionNotReadyError('WebSocket not connected');
    }
    return hub;
  }

  onConnected(timeout: number = 10000): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }

    const { promise, resolve, reject } = createDeferred<void>();

    const timer = setTimeout(() => {
      this.connectionHandlers.delete(handler);
      reject(new ConnectionTimeoutError(timeout));
    }, timeout);

    const handler = () => {
      clearTimeout(timer);
      this.connectionHandlers.delete(handler);
      resolve();
    };

    this.connectionHandlers.add(handler);

    return promise;
  }

  onceConnected(callback: ConnectionHandler): () => void {
    if (this.isConnected()) {
      callback();
      return () => {};
    }

    const handler = () => {
      this.connectionHandlers.delete(handler);
      callback();
    };

    this.connectionHandlers.add(handler);

    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  async getHub(): Promise<MessageHub> {
    if (this.messageHub && this.transport?.isReady()) {
      return this.messageHub;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = (async () => {
      try {
        const hub = await this.connect();
        return hub;
      } catch (error) {
        this.connectionPromise = null;
        throw error;
      }
    })();

    return this.connectionPromise;
  }

  private async connect(): Promise<MessageHub> {
    this.lifecycleEffects.setState('connecting');

    this.messageHub = new MessageHub({
      defaultSessionId: 'global',
      debug: false,
    });

    const eventEffects = createDefaultConnectionEventEffects({
      closeTransport: () => {
        this.transport?.close();
      },
      notifyConnected: () => this.notifyConnectionHandlers(),
      getReconnectAttempts: () => this.transport?.getReconnectAttempts(),
    });
    this.messageHub.onConnection((state, error) => {
      runConnectionEvent(eventEffects, state, error, this._isResuming);
    });

    this.lifecycleEffects.exposeHub(this.messageHub, this);

    this.transport = new WebSocketClientTransport({
      url: `${this.baseUrl}/ws`,
      autoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      pingInterval: 30000,
    });

    this.messageHub.registerTransport(this.transport);

    this.lifecycleEffects.startAudio();
    this.lifecycleEffects.startTranscripts();

    await this.transport.initialize();

    await this.waitForConnectionEventDriven(5000);

    this.messageHub.joinChannel('global');

    this.startPeriodicStateValidation();

    this.lifecycleEffects.startActions();

    this.lifecycleEffects.markHubReady();

    return this.messageHub;
  }

  private waitForConnectionEventDriven(timeout: number): Promise<void> {
    if (this.messageHub?.isConnected()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new ConnectionTimeoutError(timeout, 'WebSocket connection timeout'));
      }, timeout);

      const unsub = this.messageHub!.onConnection((state) => {
        if (state === 'connected') {
          clearTimeout(timer);
          unsub();
          resolve();
        } else if (state === 'error') {
          clearTimeout(timer);
          unsub();
          reject(new ConnectionNotReadyError('WebSocket connection error'));
        }
      });
    });
  }

  private notifyConnectionHandlers(): void {
    const handlers = Array.from(this.connectionHandlers);
    for (const handler of handlers) {
      try {
        handler();
      } catch {}
    }
  }

  async disconnect(): Promise<void> {
    this.stopPeriodicStateValidation();

    this.lifecycleEffects.stopActions();
    this.lifecycleEffects.stopAudio();
    this.lifecycleEffects.stopTranscripts();

    this.lifecycleEffects.setState('disconnected');

    this.cleanupVisibilityHandlers();

    this.connectionHandlers.clear();

    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }

    this.messageHub = null;
    this.connectionPromise = null;
  }

  isConnected(): boolean {
    return this.messageHub?.isConnected() || false;
  }

  getConnectionState(): ConnectionState {
    return this.lifecycleEffects.getState();
  }

  private setupVisibilityHandlers(): void {
    if (typeof document === 'undefined') {
      return;
    }

    this.visibilityHandler = () => {
      if (!document.hidden) {
        if (this.transport) {
          this.transport.resetReconnectState();
        }
        this.validateConnectionOnResume();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.pageHideHandler = () => {};
    document.addEventListener('pagehide', this.pageHideHandler);
  }

  private async validateConnectionOnResume(): Promise<void> {
    this._isResuming = true;
    markAllSessionStoresRecovering();

    try {
      if (!this.messageHub || !this.transport) {
        await this.reconnect();
        return;
      }

      try {
        await runConnectionResume(
          createDefaultConnectionResumeEffects({
            checkHealth: () => this.messageHub!.request('system.health', {}, { timeout: 3000 }),
            joinChannel: (channel) => this.messageHub!.joinChannel(channel),
          })
        );
      } catch {
        if (this.transport) {
          this.transport.forceReconnect();
        }
      }
    } finally {
      this._isResuming = false;
      if (this.transport?.isReady()) {
        this.lifecycleEffects.setState('connected');
        this.notifyConnectionHandlers();
      }
    }
  }

  private startPeriodicStateValidation(): void {
    if (this.stateValidationInterval) return;

    this.stateValidationInterval = setInterval(async () => {
      if (this.isConnected() && !document.hidden) {
        await this.validateConnectionState();
      }
    }, this.stateValidationPeriod);
  }

  private stopPeriodicStateValidation(): void {
    if (this.stateValidationInterval) {
      clearInterval(this.stateValidationInterval);
      this.stateValidationInterval = null;
    }
  }

  private async validateConnectionState(): Promise<boolean> {
    if (!this.messageHub || !this.transport) {
      return false;
    }

    try {
      await this.messageHub.request('system.health', {}, { timeout: 3000 });
      return true;
    } catch {
      this.transport.forceReconnect();
      return false;
    }
  }

  async reconnect(): Promise<void> {
    if (this.transport) {
      this.transport.forceReconnect();
      return;
    }

    this.messageHub = null;
    this.connectionPromise = null;

    this.lifecycleEffects.setState('connecting');

    try {
      await this.getHub();
    } catch {
      this.lifecycleEffects.setState('failed');
    }
  }

  private cleanupVisibilityHandlers(): void {
    if (typeof document === 'undefined') {
      return;
    }

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.pageHideHandler) {
      document.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
  }

  simulateDisconnect(): void {
    if (this.transport) {
      this.transport.forceReconnect();
    }
  }

  simulatePermanentDisconnect(): void {
    if (this.transport) {
      this.transport.close();
    }
    this.lifecycleEffects.setState('disconnected');
  }
}

export const connectionManager = new ConnectionManager();
