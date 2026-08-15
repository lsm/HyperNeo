/**
 * SpaceMcpStore — per-space MCP enablement state with LiveQuery subscriptions.
 *
 * Subscribes to the `mcpEnablement.bySpace` named query which returns one row
 * per registry entry with the per-space override already applied. This drives
 * the space settings MCP panel without a separate RPC/polling loop.
 *
 * Signal: `entries` — Map<serverId, SpaceMcpEntry>
 *
 * Resolves the effective enabled state server-side (the SQL's COALESCE) so the
 * UI can render straight from the Map without re-computing overrides + globals.
 */

import { signal } from '@preact/signals';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent, SpaceMcpEntry } from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('hyperneo:web:space-mcp-store');

class SpaceMcpStore {
  /** Per-space registry entries keyed by serverId, with resolved `enabled` state. */
  readonly entries = signal<Map<string, SpaceMcpEntry>>(new Map());

  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  private spaceId: string | null = null;
  private cleanups: Array<() => void> = [];
  private activeSubscriptionIds = new Set<string>();
  private subscribed = false;

  /**
   * Subscribe to the per-space MCP LiveQuery. Idempotent per spaceId;
   * switching spaces automatically tears down the old subscription.
   */
  async subscribe(spaceId: string): Promise<void> {
    if (this.subscribed && this.spaceId === spaceId) return;

    if (this.subscribed && this.spaceId !== spaceId) {
      this.unsubscribe();
    }

    this.spaceId = spaceId;
    this.subscribed = true;

    const subscriptionId = `spaceMcp-${spaceId}`;

    try {
      const hub = await connectionManager.getHub();

      if (!this.subscribed) return;

      this.loading.value = true;
      this.activeSubscriptionIds.add(subscriptionId);

      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== subscriptionId) return;
        if (!this.activeSubscriptionIds.has(subscriptionId)) return;
        const newMap = new Map<string, SpaceMcpEntry>();
        for (const row of event.rows as SpaceMcpEntry[]) {
          newMap.set(row.serverId, row);
        }
        this.entries.value = newMap;
        this.loading.value = false;
      });
      this.cleanups.push(unsubSnapshot);
      this.cleanups.push(() => this.activeSubscriptionIds.delete(subscriptionId));

      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== subscriptionId) return;
        if (!this.activeSubscriptionIds.has(subscriptionId)) return;
        const current = new Map(this.entries.value);

        if (event.removed?.length) {
          for (const row of event.removed as SpaceMcpEntry[]) {
            current.delete(row.serverId);
          }
        }
        if (event.updated?.length) {
          for (const row of event.updated as SpaceMcpEntry[]) {
            current.set(row.serverId, row);
          }
        }
        if (event.added?.length) {
          for (const row of event.added as SpaceMcpEntry[]) {
            current.set(row.serverId, row);
          }
        }
        this.entries.value = current;
      });
      this.cleanups.push(unsubDelta);

      const unsubReconnect = hub.onConnection((state) => {
        if (state !== 'connected') return;
        if (!this.activeSubscriptionIds.has(subscriptionId)) return;
        this.loading.value = true;
        hub
          .request('liveQuery.subscribe', {
            queryName: 'mcpEnablement.bySpace',
            params: [spaceId],
            subscriptionId,
          })
          .catch((err) => {
            logger.warn('SpaceMcpStore LiveQuery re-subscribe failed:', err);
            this.loading.value = false;
          });
      });
      this.cleanups.push(unsubReconnect);

      await hub.request('liveQuery.subscribe', {
        queryName: 'mcpEnablement.bySpace',
        params: [spaceId],
        subscriptionId,
      });

      if (!this.subscribed) {
        this.teardownCleanly();
        return;
      }
    } catch (err) {
      this.subscribed = false;
      this.spaceId = null;
      this.teardownCleanly();
      this.error.value =
        err instanceof Error ? err.message : 'Failed to subscribe to space MCP enablement';
      logger.error('Failed to subscribe SpaceMcpStore LiveQuery:', err);
      throw err;
    }
  }

  private teardownCleanly(): void {
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

  unsubscribe(): void {
    if (!this.subscribed) {
      this.error.value = null;
      return;
    }
    this.subscribed = false;

    const subscriptionId = this.spaceId ? `spaceMcp-${this.spaceId}` : null;
    if (subscriptionId) {
      this.activeSubscriptionIds.delete(subscriptionId);
    }

    this.teardownCleanly();

    if (subscriptionId) {
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
      }
    }

    this.entries.value = new Map();
    this.spaceId = null;
  }
}

/**
 * Singleton store. Supports one active space at a time; re-calling subscribe()
 * with a different spaceId swaps the subscription automatically.
 */
export const spaceMcpStore = new SpaceMcpStore();
