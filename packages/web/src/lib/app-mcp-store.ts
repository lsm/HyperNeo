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
  readonly appMcpServers = signal<AppMcpServer[]>([]);

  readonly loading = signal<boolean>(false);

  readonly error = signal<string | null>(null);

  private cleanups: Array<() => void> = [];

  private activeSubscriptionIds = new Set<string>();

  private subscribed = false;

  async subscribe(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    try {
      const hub = await connectionManager.getHub();

      if (!this.subscribed) return;

      this.loading.value = true;
      this.activeSubscriptionIds.add(SUBSCRIPTION_ID);

      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
        this.appMcpServers.value = event.rows as AppMcpServer[];
        this.error.value = null;
        this.loading.value = false;
      });
      this.cleanups.push(unsubSnapshot);
      this.cleanups.push(() => this.activeSubscriptionIds.delete(SUBSCRIPTION_ID));

      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
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

      await hub.request('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });

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

  private teardownCleanly(): void {
    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {}
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

    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);

    this.teardownCleanly();

    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.request('liveQuery.unsubscribe', { subscriptionId: SUBSCRIPTION_ID }).catch(() => {});
    }

    this.appMcpServers.value = [];
  }
}

export const appMcpStore = new AppMcpStore();
