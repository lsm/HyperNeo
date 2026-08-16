/**
 * Connection Manager
 *
 * Manages the WebSocket connection lifecycle for MessageHub.
 * Provides both blocking and non-blocking connection access patterns.
 *
 * ## Usage Patterns:
 *
 * ### Non-blocking (preferred for UI):
 * ```typescript
 * const hub = connectionManager.getHubIfConnected();
 * if (!hub) {
 *   toast.error('Not connected');
 *   return;
 * }
 * await hub.call(...);
 * ```
 *
 * ### Blocking (for initialization):
 * ```typescript
 * const hub = await connectionManager.getHub();
 * ```
 *
 * ### Event-driven (for waiting):
 * ```typescript
 * await connectionManager.onConnected();
 * const hub = connectionManager.getHubOrThrow();
 * ```
 */

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

// Expose signals immediately when module loads (for E2E testing)
if (typeof window !== 'undefined') {
  (
    window as unknown as {
      currentSessionIdSignal?: typeof currentSessionIdSignal;
    }
  ).currentSessionIdSignal = currentSessionIdSignal;
  (window as unknown as { slashCommandsSignal?: typeof slashCommandsSignal }).slashCommandsSignal =
    slashCommandsSignal;
}

/**
 * Type for connection event handlers
 */
type ConnectionHandler = () => void;

/**
 * Get the daemon WebSocket base URL
 *
 * In development, use the Vite dev server's proxy (same origin).
 * In production, connect directly to daemon port.
 */
export function getDaemonWsUrl(
  loc: { hostname: string; port: string; protocol: string } | undefined = typeof window !==
  'undefined'
    ? window.location
    : undefined
): string {
  if (!loc) {
    // No window/location (SSR) — can't introspect origin.
    return 'ws://localhost:8283';
  }

  const hostname = loc.hostname;
  const port = loc.port;
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';

  // In unified server mode (CLI), daemon and web share the same port
  // The CLI runs daemon+web on the same port (default 9283, or custom via --port)
  // Always use same origin when running through the CLI
  if (port) {
    // Use same origin - the unified server handles both web and WebSocket
    return `${protocol}//${hostname}:${port}`;
  }

  // No explicit port: the page is on a default port (443 for https, 80 for
  // http). Use same origin so the WS uses the protocol's default port — the
  // unified server (or a TLS-terminating proxy such as `tailscale serve` on 443)
  // serves both the page and the WebSocket on that same port. Hardcoding 8283
  // here breaks any default-port deployment (e.g. HTTPS over 443): the page
  // loads but the socket connects to a port nothing is proxying.
  return `${protocol}//${hostname}`;
}

/**
 * ConnectionManager - manages MessageHub connection lifecycle
 *
 * Responsibilities:
 * - Lazy connection initialization
 * - Connection caching and reuse
 * - WebSocket transport configuration
 * - Connection state management
 * - Non-blocking connection access for UI responsiveness
 */
export class ConnectionManager {
  private messageHub: MessageHub | null = null;
  private transport: WebSocketClientTransport | null = null;
  private baseUrl: string;
  private connectionPromise: Promise<MessageHub> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;

  // FIX P5: Periodic state validation for proactive connection health monitoring
  private stateValidationInterval: ReturnType<typeof setInterval> | null = null;
  private readonly stateValidationPeriod: number = 60000; // 1 minute

  // Event-driven connection handlers
  private connectionHandlers: Set<ConnectionHandler> = new Set();

  // Flag to prevent premature 'connected' state during resume validation
  private _isResuming = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getDaemonWsUrl();
    this.setupVisibilityHandlers();
  }

  // ========================================
  // Non-Blocking Access Methods (NEW)
  // ========================================

  /**
   * Get the MessageHub instance if currently connected (NON-BLOCKING)
   *
   * Returns null immediately if not connected. Use this for UI handlers
   * that should not block on connection.
   *
   * @returns MessageHub if connected, null otherwise
   *
   * @example
   * ```typescript
   * const hub = connectionManager.getHubIfConnected();
   * if (!hub) {
   *   toast.error('Not connected to server');
   *   return;
   * }
   * await hub.call('session.create', data);
   * ```
   */
  getHubIfConnected(): MessageHub | null {
    if (this.messageHub && this.transport?.isReady()) {
      return this.messageHub;
    }
    return null;
  }

  /**
   * Get the MessageHub instance or throw immediately (NON-BLOCKING)
   *
   * Throws ConnectionNotReadyError if not connected. Use this when you
   * want to handle connection errors explicitly.
   *
   * @throws {ConnectionNotReadyError} If not connected
   * @returns MessageHub instance
   *
   * @example
   * ```typescript
   * try {
   *   const hub = connectionManager.getHubOrThrow();
   *   await hub.call('session.create', data);
   * } catch (err) {
   *   if (err instanceof ConnectionNotReadyError) {
   *     toast.error('Please wait for connection...');
   *   }
   * }
   * ```
   */
  getHubOrThrow(): MessageHub {
    const hub = this.getHubIfConnected();
    if (!hub) {
      throw new ConnectionNotReadyError('WebSocket not connected');
    }
    return hub;
  }

  /**
   * Wait for connection to be established (EVENT-DRIVEN)
   *
   * Returns a promise that resolves when connected. Does not block
   * with polling - uses event-driven approach.
   *
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   * @throws {ConnectionTimeoutError} If timeout exceeded
   *
   * @example
   * ```typescript
   * await connectionManager.onConnected(5000);
   * const hub = connectionManager.getHubOrThrow();
   * ```
   */
  onConnected(timeout: number = 10000): Promise<void> {
    // Already connected - resolve immediately
    if (this.isConnected()) {
      return Promise.resolve();
    }

    const { promise, resolve, reject } = createDeferred<void>();

    // Set up timeout
    const timer = setTimeout(() => {
      this.connectionHandlers.delete(handler);
      reject(new ConnectionTimeoutError(timeout));
    }, timeout);

    // Handler to call when connected
    const handler = () => {
      clearTimeout(timer);
      this.connectionHandlers.delete(handler);
      resolve();
    };

    // Register handler
    this.connectionHandlers.add(handler);

    return promise;
  }

  /**
   * Register a callback for when connection is established
   *
   * @param callback - Function to call when connected
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsub = connectionManager.onceConnected(() => {
   *   console.log('Connected!');
   * });
   * // Later: unsub() to cancel
   * ```
   */
  onceConnected(callback: ConnectionHandler): () => void {
    // Already connected - call immediately
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

  // ========================================
  // Blocking Access Methods (Existing)
  // ========================================

  /**
   * Get the MessageHub instance, creating connection if needed (BLOCKING)
   *
   * NOTE: This method can block for several seconds. For UI handlers,
   * prefer getHubIfConnected() or getHubOrThrow() instead.
   *
   * PHASE 3.3 FIX: Prevent race condition where multiple concurrent calls
   * could create duplicate connections
   */
  async getHub(): Promise<MessageHub> {
    // Return existing connected hub
    if (this.messageHub && this.transport?.isReady()) {
      return this.messageHub;
    }

    // If already connecting, wait for that
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Start new connection - assign immediately to prevent race
    this.connectionPromise = (async () => {
      try {
        const hub = await this.connect();
        return hub;
      } catch (error) {
        // On error, clear promise so next call can retry
        this.connectionPromise = null;
        throw error;
      }
    })();

    // Return the promise (no finally block to clear it)
    // connectionPromise stays set until disconnect() is called
    return this.connectionPromise;
  }

  /**
   * Connect to daemon WebSocket with MessageHub
   */
  private async connect(): Promise<MessageHub> {
    // Set initial connecting state
    connectionState.value = 'connecting';

    // Create MessageHub
    this.messageHub = new MessageHub({
      defaultSessionId: 'global',
      debug: false,
    });

    // Listen to connection state changes and update global state
    this.messageHub.onConnection((state, error) => {
      // During resume validation, don't report 'connected' until validation completes.
      // This prevents the UI from seeing a false-positive 'connected' state while
      // the health check and channel rejoin are still in progress.
      if (state === 'connected' && this._isResuming) {
        // Still notify handlers since the WebSocket IS connected, but don't
        // update connectionState (which drives isConnected in useMessageHub)
        this.notifyConnectionHandlers();
        return;
      }

      // Auth/session expiry detection — redirect to re-auth, don't loop retries
      if (state === 'error' && error && isAuthError(error)) {
        connectionState.value = 'error';
        // Stop transport and outbound queue before redirect to prevent
        // reconnect loop firing between href assignment and navigation
        stopAutoFlush();
        if (this.transport) {
          this.transport.close();
        }
        if (typeof window !== 'undefined') {
          window.location.href = '/settings?tab=providers&reason=session_expired';
        }
        return;
      }

      connectionState.value = state;

      // Notify connection handlers when connected
      if (state === 'connected') {
        reconnectAttemptCount.value = 0;
        this.notifyConnectionHandlers();
      }

      // Track reconnect attempts for UI progression
      if (state === 'reconnecting' || state === 'connecting') {
        if (this.transport) {
          reconnectAttemptCount.value = this.transport.getReconnectAttempts();
        }
      }
    });

    // Expose to window for testing
    if (typeof window !== 'undefined') {
      window.__messageHub = this.messageHub;
      window.appState = appState;
      window.__messageHubReady = false; // Will be set to true after connection
      window.connectionManager = this; // Expose for testing
      window.globalStore = globalStore; // Expose for testing
      window.sessionStore = sessionStore; // Expose for testing

      // Also expose signals for testing (static import for immediate availability)
      window.currentSessionIdSignal = currentSessionIdSignal;
      window.slashCommandsSignal = slashCommandsSignal;
    }

    // Create WebSocket transport with auto-reconnect
    this.transport = new WebSocketClientTransport({
      url: `${this.baseUrl}/ws`,
      autoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      pingInterval: 30000,
    });

    // Register transport
    this.messageHub.registerTransport(this.transport);

    // Initialize transport (establishes WebSocket connection)
    await this.transport.initialize();

    // Wait for connection to be established (event-driven, not polling)
    await this.waitForConnectionEventDriven(5000);

    // Join global room after connection is established
    this.messageHub.joinChannel('global');

    // FIX P5: Start periodic state validation
    this.startPeriodicStateValidation();

    // Start auto-flush for queued outbound actions
    startAutoFlush();

    // Mark ready for testing
    if (typeof window !== 'undefined' && window.__messageHub) {
      window.__messageHubReady = true;
    }

    return this.messageHub;
  }

  /**
   * Wait for WebSocket to be ready (EVENT-DRIVEN - replaces polling)
   */
  private waitForConnectionEventDriven(timeout: number): Promise<void> {
    // Already connected
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

  /**
   * Notify all registered connection handlers
   */
  private notifyConnectionHandlers(): void {
    // Copy to array to allow handlers to remove themselves
    const handlers = Array.from(this.connectionHandlers);
    for (const handler of handlers) {
      try {
        handler();
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    // FIX P5: Stop periodic state validation
    this.stopPeriodicStateValidation();

    // Stop outbound queue auto-flush
    stopAutoFlush();

    // Update connection state
    connectionState.value = 'disconnected';

    // Cleanup visibility handlers
    this.cleanupVisibilityHandlers();

    // Clear connection handlers
    this.connectionHandlers.clear();

    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }

    this.messageHub = null;
    this.connectionPromise = null; // Clear connection promise on disconnect
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.messageHub?.isConnected() || false;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): typeof connectionState.value {
    return connectionState.value;
  }

  /**
   * Setup page visibility handlers to detect Safari background tab issues
   * Safari pauses WebSocket activity when tab is backgrounded
   */
  private setupVisibilityHandlers(): void {
    if (typeof document === 'undefined') {
      return; // Not in browser environment
    }

    // Handle visibility changes (tab switch, minimize)
    this.visibilityHandler = () => {
      if (!document.hidden) {
        // IMPORTANT: Reset reconnect state when returning to page
        // This allows fresh reconnection attempts after being backgrounded
        if (this.transport) {
          this.transport.resetReconnectState();
        }
        this.validateConnectionOnResume();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.pageHideHandler = () => {
      // Page hiding - connection may become stale
    };
    document.addEventListener('pagehide', this.pageHideHandler);
  }

  /**
   * Validate connection when returning from background
   * Safari may have paused the WebSocket, so we need to check if it's still alive
   *
   * CRITICAL FIX: After successful health check, we MUST:
   * 1. Force re-establish subscriptions (they may be stale on server)
   * 2. Refresh all state channels (fetch latest state)
   *
   * This fixes the "sticky bug" where UI appears connected but doesn't
   * receive updates after returning from background.
   */
  private async validateConnectionOnResume(): Promise<void> {
    // Mark that we're in resume validation - this prevents connectionState from
    // reporting 'connected' until validation completes
    this._isResuming = true;
    // Synchronously flag every mounted chat recovering so the composer (and the
    // rewind/question/drop affordances) is disabled BEFORE the ≤3s health check
    // + channel joins — a send during that window could land before the
    // session channel / messages LiveQuery are restored. performRecovery (via
    // refreshAllSessionStores below) supersedes this mark and clears it on
    // success; forceReconnect clears it via the transport path. Mirrors the
    // transport-reconnect path's immediate onConnection('disconnected') mark.
    markAllSessionStoresRecovering();

    try {
      if (!this.messageHub || !this.transport) {
        // No connection exists - try to reconnect from scratch
        await this.reconnect();
        return;
      }

      try {
        // Send a lightweight health check with short timeout
        // If this fails, the connection is dead and needs reconnect
        await this.messageHub.request('system.health', {}, { timeout: 3000 });

        // CRITICAL FIX: Re-join channels on resume
        // Safari may pause WebSocket without closing it, causing server-side
        // channel memberships to expire while client thinks it's still connected.
        await this.messageHub.joinChannel('global');
        const activeSpaceId = spaceStore.spaceId.value;
        if (activeSpaceId) {
          await this.messageHub.joinChannel(`space:${activeSpaceId}`);
        }

        // CRITICAL: Refresh ALL state (session store, app state, and global state)
        // This ensures UI is in sync even if events were missed during background
        // FIX: Refresh every live SessionStore instance — the primary singleton AND
        // any simultaneously-mounted overlay instance — so each chat's status bar
        // shows the real agent state instead of a stale "Online".
        await Promise.all([
          refreshAllSessionStores(),
          appState.refreshAll(),
          globalStore.refresh(),
          spaceStore.refresh(),
        ]);
      } catch {
        // FIX: Use forceReconnect() instead of close()
        // close() sets closed=true which prevents auto-reconnect
        if (this.transport) {
          this.transport.forceReconnect();
        }
      }
    } finally {
      // Mark that resume validation is complete - now connectionState can update normally
      this._isResuming = false;
      // If connection was re-established during resume (e.g. reconnect path), update state now
      // since the 'connected' event was suppressed while _isResuming was true
      if (this.transport?.isReady()) {
        connectionState.value = 'connected';
        this.notifyConnectionHandlers();
      }
    }
  }

  /**
   * Start periodic state validation
   * FIX P5: Proactively detects and recovers from stale connections
   */
  private startPeriodicStateValidation(): void {
    if (this.stateValidationInterval) return;

    this.stateValidationInterval = setInterval(async () => {
      // Only validate if connected and page is visible
      if (this.isConnected() && !document.hidden) {
        await this.validateConnectionState();
      }
    }, this.stateValidationPeriod);
  }

  /**
   * Stop periodic state validation
   */
  private stopPeriodicStateValidation(): void {
    if (this.stateValidationInterval) {
      clearInterval(this.stateValidationInterval);
      this.stateValidationInterval = null;
    }
  }

  /**
   * Lightweight connection state validation
   * FIX P5: Uses health check to verify connection is alive
   */
  private async validateConnectionState(): Promise<boolean> {
    if (!this.messageHub || !this.transport) {
      return false;
    }

    try {
      // Quick health check with short timeout
      await this.messageHub.request('system.health', {}, { timeout: 3000 });
      return true;
    } catch {
      // Health check failed - trigger reconnect
      this.transport.forceReconnect();
      return false;
    }
  }

  /**
   * Manually trigger a reconnection attempt
   * Use this when user clicks "Reconnect" button or to recover from permanent failure
   */
  async reconnect(): Promise<void> {
    if (this.transport) {
      // Use forceReconnect even when the transport is closed (ws=null).
      // This preserves the existing MessageHub and its onConnection handlers
      // (e.g. LiveQuery re-subscriptions). The old path created a brand new
      // hub, discarding all registered handlers and breaking reconnect logic.
      // Note: forceReconnect() calls resetReconnectState() internally.
      this.transport.forceReconnect();
      return;
    }

    // No transport yet — create from scratch
    this.messageHub = null;
    this.connectionPromise = null;

    // Update UI state
    connectionState.value = 'connecting';

    // Attempt fresh connection
    try {
      await this.getHub();
    } catch {
      connectionState.value = 'failed';
    }
  }

  /**
   * Cleanup visibility handlers
   */
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

  /**
   * Simulate disconnection for testing purposes
   * This closes the WebSocket but allows auto-reconnect to work
   */
  simulateDisconnect(): void {
    if (this.transport) {
      // Use forceReconnect() instead of close() - close() sets closed=true which prevents reconnection
      this.transport.forceReconnect();
    }
  }

  /**
   * Simulate permanent disconnection for testing purposes
   * This closes the WebSocket and prevents auto-reconnect
   * Use this for testing UI states when disconnected
   */
  simulatePermanentDisconnect(): void {
    if (this.transport) {
      this.transport.close();
    }
    connectionState.value = 'disconnected';
  }
}

// Singleton instance
export const connectionManager = new ConnectionManager();
