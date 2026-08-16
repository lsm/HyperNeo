/**
 * AppMcpStore - Application-level MCP server registry with LiveQuery subscriptions
 *
 * ARCHITECTURE: LiveQuery supersedes mcp.registry.changed for frontend UI purposes
 * - Initial state: Fetched via LiveQuery snapshot on subscribe
 * - Updates: Real-time via liveQuery.delta events
 * - Reconnect: Re-subscribes with same subscriptionId on hub reconnection
 * - Teardown: Calls liveQuery.unsubscribe to clean up server-side subscription
 *
 * Signal (reactive state):
 * - appMcpServers: List of all application-level MCP servers
 */

import { signal } from '@preact/signals';
import type {
  AppMcpServer,
  LiveQueryDeltaEvent,
  LiveQueryErrorEvent,
  LiveQuerySnapshotEvent,
} from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('hyperneo:web:app-mcp-store');

const SUBSCRIPTION_ID = 'mcpServers-global';

class AppMcpStore {
  /** All application-level MCP servers */
  readonly appMcpServers = signal<AppMcpServer[]>([]);

  /** Loading state */
  readonly loading = signal<boolean>(false);

  /** Error state — set when subscribe() fails */
  readonly error = signal<string | null>(null);

  /** Cleanup functions registered during subscribe() */
  private cleanups: Array<() => void> = [];

  /**
   * Stale-event guard: set of currently active subscriptionIds.
   * Cleared immediately in unsubscribe() before handler teardown so that
   * any in-flight events (queued in the JS event loop between unsubscribe and
   * handler removal) are discarded rather than applied to the wrong state.
   */
  private activeSubscriptionIds = new Set<string>();

  /** Guard: true once subscribe() has been called and not yet torn down */
  private subscribed = false;

  /**
   * Subscribe to the global MCP server registry via LiveQuery.
   *
   * Idempotent: safe to call multiple times; subsequent calls are no-ops
   * until unsubscribe() is called.
   *
   * Re-throws errors so callers can handle failures (e.g., show a toast).
   */
  async subscribe(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    try {
      const hub = await connectionManager.getHub();

      // Guard: unsubscribe() was called before hub became available
      if (!this.subscribed) return;

      this.loading.value = true;
      this.activeSubscriptionIds.add(SUBSCRIPTION_ID);

      // --- Snapshot handler ---
      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return; // stale-event guard
        this.appMcpServers.value = event.rows as AppMcpServer[];
        this.error.value = null;
        this.loading.value = false;
      });
      this.cleanups.push(unsubSnapshot);
      this.cleanups.push(() => this.activeSubscriptionIds.delete(SUBSCRIPTION_ID));

      // --- Delta handler ---
      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return; // stale-event guard
        let current = this.appMcpServers.value;
        if (event.removed?.length) {
          const removedIds = new Set((event.removed as AppMcpServer[]).map((r) => r.id));
          current = current.filter((s) => !removedIds.has(s.id));
        }
        if (event.updated?.length) {
          const updatedMap = new Map((event.updated as AppMcpServer[]).map((u) => [u.id, u]));
          current = current.map((s) => updatedMap.get(s.id) ?? s);
        }
        if (event.added?.length) {
          current = [...current, ...(event.added as AppMcpServer[])];
        }
        this.appMcpServers.value = current;
      });
      this.cleanups.push(unsubDelta);

      const unsubError = hub.onEvent<LiveQueryErrorEvent>('liveQuery.error', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
        if (event.phase === 'snapshot') {
          this.error.value = event.message;
          this.loading.value = false;
          return;
        }
        this.loading.value = true;
        hub
          .request('liveQuery.subscribe', {
            queryName: 'mcpServers.global',
            params: [],
            subscriptionId: SUBSCRIPTION_ID,
          })
          .catch((err) => {
            this.error.value = err instanceof Error ? err.message : 'MCP registry is too large';
            this.loading.value = false;
          });
      });
      this.cleanups.push(unsubError);

      // --- Reconnect handler ---
      // Re-subscribe with the same subscriptionId so we get a fresh snapshot
      // after the WebSocket reconnects.
      const unsubReconnect = hub.onConnection((state) => {
        if (state !== 'connected') return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
        this.loading.value = true;
        hub
          .request('liveQuery.subscribe', {
            queryName: 'mcpServers.global',
            params: [],
            subscriptionId: SUBSCRIPTION_ID,
          })
          .catch((err) => {
            logger.warn('AppMcpStore LiveQuery re-subscribe failed:', err);
            this.loading.value = false;
          });
      });
      this.cleanups.push(unsubReconnect);

      // --- Subscribe to the named query ---
      await hub.request('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });

      // Guard: abort if unsubscribed while the subscribe request was in flight
      if (!this.subscribed) {
        this.teardownCleanly();
        return;
      }
    } catch (err) {
      this.subscribed = false;
      this.teardownCleanly();
      this.error.value = err instanceof Error ? err.message : 'Failed to subscribe to MCP registry';
      logger.error('Failed to subscribe AppMcpStore LiveQuery:', err);
      throw err;
    }
  }

  /**
   * Run all cleanup functions and reset state — used after subscribe() races
   * with unsubscribe().
   */
  private teardownCleanly(): void {
    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.cleanups = [];
    this.loading.value = false;
    this.error.value = null;
  }

  /**
   * Unsubscribe and reset state.
   *
   * Calls liveQuery.unsubscribe so the server cleans up the subscription.
   * Safe to call even if subscribe() was never called.
   */
  unsubscribe(): void {
    if (!this.subscribed) {
      // Still reset error signal even if we were never subscribed
      // (e.g., subscribe() failed and set this.subscribed = false in its catch block)
      this.error.value = null;
      return;
    }
    this.subscribed = false;

    // Stale-event guard: clear activeSubscriptionIds immediately so any events
    // already queued in the JS event loop are discarded before handlers are removed.
    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);

    this.teardownCleanly();

    // Tell the server to dispose the subscription.
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.request('liveQuery.unsubscribe', { subscriptionId: SUBSCRIPTION_ID }).catch(() => {});
    }

    this.appMcpServers.value = [];
  }
}

/** Singleton store instance */
export const appMcpStore = new AppMcpStore();
