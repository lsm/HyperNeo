/**
 * GlobalStore - Unified global state management
 *
 * Manages application-wide state that's not session-specific:
 * - Sessions list (all sessions) via LiveQuery
 * - System state (auth, config, health, API connection)
 * - Global settings
 *
 * Signals (reactive state):
 * - sessions: All sessions list (reactive via LiveQuery)
 * - systemState: Unified system state
 * - settings: Global settings
 *
 * Computed accessors (derived state):
 * - authStatus, healthStatus, sessionCount, recentSessions
 */

import { signal, computed } from '@preact/signals';
import type { Session, AuthStatus, HealthStatus, SystemState, SettingsState } from '@neokai/shared';
import type { LiveQueryDeltaEvent, LiveQuerySnapshotEvent } from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';
import type { GlobalSettings } from '@neokai/shared/types/settings';
import { connectionManager } from './connection-manager';

const SESSIONS_SUBSCRIPTION_ID = 'sessions-list';

export class GlobalStore {
  // ========================================
  // Core Signals
  // ========================================

  /** All sessions */
  readonly sessions = signal<Session[]>([]);

  /** Total session count (from server, includes archived) */
  readonly sessionsTotalCount = signal<number>(0);

  /** Count of archived sessions in the database (from server metadata) */
  readonly archivedSessionCount = signal<number>(0);

  /**
   * Whether there are any archived sessions in the database.
   * Derived from archivedSessionCount (sent by server in live-query metadata)
   * OR the fallback totalCount > visible-count comparison for backward compat.
   */
  readonly hasArchivedSessions = computed<boolean>(
    () =>
      this.archivedSessionCount.value > 0 ||
      this.sessionsTotalCount.value > this.sessions.value.length
  );

  /** Unified system state (auth + config + health + API connection) */
  readonly systemState = signal<SystemState | null>(null);

  /** Global settings */
  readonly settings = signal<GlobalSettings | null>(null);

  // ========================================
  // Computed Accessors
  // ========================================

  /** Authentication status */
  readonly authStatus = computed<AuthStatus | null>(() => this.systemState.value?.auth || null);

  /** Health status */
  readonly healthStatus = computed<HealthStatus | null>(
    () => this.systemState.value?.health || null
  );

  /** Total session count */
  readonly sessionCount = computed<number>(() => this.sessions.value.length);

  /** Recent sessions (last 5) */
  readonly recentSessions = computed<Session[]>(() => {
    return [...this.sessions.value]
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
      .slice(0, 5);
  });

  /** Active sessions only */
  readonly activeSessions = computed<Session[]>(() => {
    return this.sessions.value.filter((s) => s.status === 'active');
  });

  /** API connection status */
  readonly apiConnectionStatus = computed<'connected' | 'degraded' | 'disconnected'>(
    () => this.systemState.value?.apiConnection?.status || 'connected'
  );

  // ========================================
  // Private State
  // ========================================

  /** Subscription cleanup functions */
  private cleanupFunctions: Array<() => void> = [];

  /** Whether already initialized */
  private initialized = false;

  // ========================================
  // Initialization
  // ========================================

  /**
   * Initialize global store with subscriptions
   * Called once on app startup
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const hub = await connectionManager.getHub();

      // Subscribe to sessions via LiveQuery (reactive, replaces state channels)
      this.subscribeSessions(hub);

      // Subscribe to system state changes
      const unsubSystem = hub.onEvent<SystemState>(STATE_CHANNELS.GLOBAL_SYSTEM, (state) => {
        this.systemState.value = state;
      });
      this.cleanupFunctions.push(unsubSystem);

      // Subscribe to settings changes
      const unsubSettings = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, (state) => {
        this.settings.value = state.settings || null;
      });
      this.cleanupFunctions.push(unsubSettings);

      this.initialized = true;
    } catch {
      // Initialization failed - state will be empty
    }
  }

  /**
   * Subscribe to sessions via LiveQuery.
   *
   * Uses the `sessions.list` named query which filters out internal room/space
   * sessions server-side. The showArchived param controls whether archived
   * sessions are included. totalCount metadata provides the total count
   * regardless of the filter.
   */
  private subscribeSessions(hub: Awaited<ReturnType<typeof connectionManager.getHub>>): void {
    const getParams = (): number[] => {
      const showArchived = this.settings.value?.showArchived ?? false;
      return [showArchived ? 1 : 0];
    };

    const doSubscribe = (): void => {
      hub
        .request('liveQuery.subscribe', {
          queryName: 'sessions.list',
          params: getParams(),
          subscriptionId: SESSIONS_SUBSCRIPTION_ID,
        })
        .catch(() => {});
    };

    // Snapshot: full replacement of sessions list
    const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== SESSIONS_SUBSCRIPTION_ID) return;
      this.sessions.value = (event.rows as Session[]) ?? [];
      if (event.metadata?.totalCount != null) {
        this.sessionsTotalCount.value = event.metadata.totalCount as number;
      }
      if (event.metadata?.archivedCount != null) {
        this.archivedSessionCount.value = event.metadata.archivedCount as number;
      }
    });
    this.cleanupFunctions.push(unsubSnapshot);

    // Delta: incremental added/updated/removed
    const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== SESSIONS_SUBSCRIPTION_ID) return;
      this.applySessionsDelta(event);
      if (event.metadata?.totalCount != null) {
        this.sessionsTotalCount.value = event.metadata.totalCount as number;
      }
      if (event.metadata?.archivedCount != null) {
        this.archivedSessionCount.value = event.metadata.archivedCount as number;
      }
    });
    this.cleanupFunctions.push(unsubDelta);

    // Re-subscribe on reconnect
    const unsubReconnect = hub.onConnection((state) => {
      if (state !== 'connected') return;
      doSubscribe();
    });
    this.cleanupFunctions.push(unsubReconnect);

    // Re-subscribe when showArchived setting changes
    let prevShowArchived = this.settings.value?.showArchived ?? false;
    this.cleanupFunctions.push(() => {
      // no-op cleanup needed (the effect below uses settings signal directly)
    });
    const checkSetting = (): void => {
      const current = this.settings.value?.showArchived ?? false;
      if (current !== prevShowArchived) {
        prevShowArchived = current;
        doSubscribe();
      }
    };

    // Poll setting changes — settings signal updates trigger this check
    // We use a micro-task to check after settings settle
    const unsubSettings = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, () => {
      queueMicrotask(checkSetting);
    });
    this.cleanupFunctions.push(unsubSettings);

    // Fire initial subscribe
    doSubscribe();
  }

  /**
   * Apply LiveQuery delta updates to sessions list.
   */
  private applySessionsDelta(event: LiveQueryDeltaEvent): void {
    const next = new Map(this.sessions.value.map((s) => [s.id, s]));

    for (const row of (event.removed ?? []) as Session[]) next.delete(row.id);
    for (const row of (event.updated ?? []) as Session[]) next.set(row.id, row);
    for (const row of (event.added ?? []) as Session[]) next.set(row.id, row);

    this.sessions.value = [...next.values()];
  }

  /**
   * Refresh all global state from server
   * Called after reconnection to sync missed updates
   *
   * CRITICAL: This fetches the latest snapshot from the server to ensure
   * the UI is in sync after WebSocket reconnection or Safari background tab resume.
   */
  async refresh(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const hub = await connectionManager.getHub();

    // Re-subscribe to sessions LiveQuery to get fresh snapshot
    const showArchived = this.settings.value?.showArchived ?? false;
    hub
      .request('liveQuery.subscribe', {
        queryName: 'sessions.list',
        params: [showArchived ? 1 : 0],
        subscriptionId: SESSIONS_SUBSCRIPTION_ID,
      })
      .catch(() => {});

    // Fetch fresh system + settings state
    const snapshot = await hub.request<{
      system: SystemState;
      settings: SettingsState;
    }>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

    if (snapshot) {
      this.systemState.value = snapshot.system || null;
      this.settings.value = snapshot.settings?.settings || null;
    }

    // State refreshed after reconnection
  }

  /**
   * Cleanup subscriptions
   * Called on app shutdown
   */
  destroy(): void {
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub
        .request('liveQuery.unsubscribe', {
          subscriptionId: SESSIONS_SUBSCRIPTION_ID,
        })
        .catch(() => {});
    }

    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.cleanupFunctions = [];
    this.initialized = false;
  }

  // ========================================
  // Session Helpers
  // ========================================

  /**
   * Get session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.value.find((s) => s.id === sessionId);
  }

  /**
   * Update a session in the list (local optimistic update)
   */
  updateSession(sessionId: string, updates: Partial<Session>): void {
    this.sessions.value = this.sessions.value.map((s) =>
      s.id === sessionId ? { ...s, ...updates } : s
    );
  }

  /**
   * Remove a session from the list (local optimistic update)
   */
  removeSession(sessionId: string): void {
    this.sessions.value = this.sessions.value.filter((s) => s.id !== sessionId);
  }

  /**
   * Add a session to the list (local optimistic update)
   */
  addSession(session: Session): void {
    this.sessions.value = [...this.sessions.value, session];
  }
}

/** Singleton global store instance */
export const globalStore = new GlobalStore();
