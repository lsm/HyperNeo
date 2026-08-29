import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import { appState, connectionState, reconnectAttemptCount } from './state';
import { globalStore } from './global-store';
import {
  markAllSessionStoresRecovering,
  refreshAllSessionStores,
  sessionStore,
} from './session-store';
import { spaceStore } from './space-store';
import { ConnectionNotReadyError, ConnectionTimeoutError } from './errors';
import { createDeferred } from './timeout';
import { currentSessionIdSignal, slashCommandsSignal } from './signals';
import { isAuthError } from './user-error';
import { startAutoFlush, stopAutoFlush } from './outbound-queue';
import { startVoiceAudioOutboxFlush, stopVoiceAudioOutboxFlush } from './voice/voice-audio-outbox';
import {
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
} from './voice/voice-transcript-outbox';

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
    connectionState.value = 'connecting';

    this.messageHub = new MessageHub({
      defaultSessionId: 'global',
      debug: false,
    });

    this.messageHub.onConnection((state, error) => {
      if (state === 'connected' && this._isResuming) {
        this.notifyConnectionHandlers();
        return;
      }

      if (state === 'error' && error && isAuthError(error)) {
        connectionState.value = 'error';
        stopAutoFlush();
        stopVoiceAudioOutboxFlush();
        stopVoiceTranscriptOutboxFlush();
        if (this.transport) {
          this.transport.close();
        }
        if (
          typeof window !== 'undefined' &&
          !window.location.search.includes('reason=session_expired')
        ) {
          window.location.href = '/settings?tab=providers&reason=session_expired';
        }
        return;
      }

      connectionState.value = state;

      if (state === 'connected') {
        reconnectAttemptCount.value = 0;
        startAutoFlush();
        startVoiceAudioOutboxFlush();
        startVoiceTranscriptOutboxFlush();
        this.notifyConnectionHandlers();
      }

      if (state === 'reconnecting' || state === 'connecting') {
        if (this.transport) {
          reconnectAttemptCount.value = this.transport.getReconnectAttempts();
        }
      }
    });

    if (typeof window !== 'undefined') {
      window.__messageHub = this.messageHub;
      window.appState = appState;
      window.__messageHubReady = false;
      window.connectionManager = this;
      window.globalStore = globalStore;
      window.sessionStore = sessionStore;

      window.currentSessionIdSignal = currentSessionIdSignal;
      window.slashCommandsSignal = slashCommandsSignal;
    }

    this.transport = new WebSocketClientTransport({
      url: `${this.baseUrl}/ws`,
      autoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      pingInterval: 30000,
    });

    this.messageHub.registerTransport(this.transport);

    startVoiceAudioOutboxFlush();
    startVoiceTranscriptOutboxFlush();

    await this.transport.initialize();

    await this.waitForConnectionEventDriven(5000);

    this.messageHub.joinChannel('global');

    this.startPeriodicStateValidation();

    startAutoFlush();

    if (typeof window !== 'undefined' && window.__messageHub) {
      window.__messageHubReady = true;
    }

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

    stopAutoFlush();
    stopVoiceAudioOutboxFlush();
    stopVoiceTranscriptOutboxFlush();

    connectionState.value = 'disconnected';

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

  getConnectionState(): typeof connectionState.value {
    return connectionState.value;
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
        await this.messageHub.request('system.health', {}, { timeout: 3000 });

        await this.messageHub.joinChannel('global');
        const activeSpaceId = spaceStore.spaceId.value;
        if (activeSpaceId) {
          await this.messageHub.joinChannel(`space:${activeSpaceId}`);
        }

        await Promise.all([
          refreshAllSessionStores(),
          appState.refreshAll(),
          globalStore.refresh(),
          spaceStore.refresh(),
        ]);
      } catch {
        if (this.transport) {
          this.transport.forceReconnect();
        }
      }
    } finally {
      this._isResuming = false;
      if (this.transport?.isReady()) {
        connectionState.value = 'connected';
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

    connectionState.value = 'connecting';

    try {
      await this.getHub();
    } catch {
      connectionState.value = 'failed';
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
    connectionState.value = 'disconnected';
  }
}

export const connectionManager = new ConnectionManager();
