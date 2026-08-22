import { signal, type Signal, batch } from '@preact/signals';
import type { MessageHub } from '@hyperneo/shared';

type UnsubscribeFn = () => void;

export interface StateChannelOptions<T> {
  sessionId?: string;

  enableDeltas?: boolean;

  mergeDelta?: (current: T, delta: unknown) => T;

  refreshInterval?: number;

  debug?: boolean;

  optimisticTimeout?: number;

  nonBlocking?: boolean;

  useOptimisticSubscriptions?: boolean;
}

interface OptimisticUpdate<T> {
  id: string;
  original: T;
  optimistic: T;
  timestamp: number;
  timeout: ReturnType<typeof setTimeout>;
}

export class StateChannel<T> {
  private state = signal<T | null>(null);
  private loading = signal<boolean>(false);
  private error = signal<Error | null>(null);
  private lastSync = signal<number>(0);

  private subscriptions: UnsubscribeFn[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private optimisticUpdates = new Map<string, OptimisticUpdate<T>>();

  constructor(
    private hub: MessageHub,
    private channelName: string,
    private options: StateChannelOptions<T> = {}
  ) {
    this.options = {
      sessionId: 'global',
      enableDeltas: true,
      refreshInterval: 0,
      debug: false,
      optimisticTimeout: 5000,
      nonBlocking: false,
      useOptimisticSubscriptions: false,
      ...options,
    };
  }

  async start(): Promise<void> {
    this.log(
      `Starting channel: ${this.channelName} (nonBlocking: ${this.options.nonBlocking}, optimistic: ${this.options.useOptimisticSubscriptions})`
    );

    try {
      await this.fetchSnapshot();

      if (this.options.useOptimisticSubscriptions) {
        this.setupOptimisticSubscriptions();
      } else if (this.options.nonBlocking) {
        this.setupSubscriptions().catch(() => {});
      } else {
        await this.setupSubscriptions();
      }

      if (this.options.refreshInterval && this.options.refreshInterval > 0) {
        this.setupAutoRefresh();
      }

      this.setupReconnectionHandler();

      this.log(`Channel started: ${this.channelName}`);
    } catch (err) {
      this.error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.subscriptions.map((unsub) => unsub()));
    this.subscriptions = [];

    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.optimisticUpdates.forEach((update) => {
      clearTimeout(update.timeout);
    });
    this.optimisticUpdates.clear();
  }

  get value(): T | null {
    return this.state.value;
  }

  get $(): Signal<T | null> {
    return this.state;
  }

  get isLoading(): Signal<boolean> {
    return this.loading;
  }

  get hasError(): Signal<Error | null> {
    return this.error;
  }

  get lastSyncTime(): Signal<number> {
    return this.lastSync;
  }

  isStale(maxAge: number = 60000): boolean {
    return Date.now() - this.lastSync.value > maxAge;
  }

  async refresh(): Promise<void> {
    this.log(`Refreshing channel: ${this.channelName}`);
    await this.fetchSnapshot();
  }

  updateOptimistic(id: string, updater: (current: T) => T, confirmed?: Promise<void>): void {
    if (!this.state.value) {
      return;
    }

    const original = this.state.value;
    const optimistic = updater(original);

    this.log(`Optimistic update: ${id}`, { original, optimistic });

    this.state.value = optimistic;

    if (confirmed) {
      let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        this.log(`Optimistic update timeout: ${id}, reverting`);
        this.revertOptimistic(id);
        timeoutId = null;
      }, this.options.optimisticTimeout);

      this.optimisticUpdates.set(id, {
        id,
        original,
        optimistic,
        timestamp: Date.now(),
        timeout: timeoutId,
      });

      confirmed
        .then(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          this.log(`Optimistic update confirmed: ${id}`);
          this.commitOptimistic(id);
        })
        .catch((err) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          this.log(`Optimistic update failed: ${id}`, err);
          this.revertOptimistic(id);
        });
    } else {
      const timeout = setTimeout(() => {
        this.log(`Optimistic update timeout: ${id}, reverting`);
        this.revertOptimistic(id);
      }, this.options.optimisticTimeout);

      this.optimisticUpdates.set(id, {
        id,
        original,
        optimistic,
        timestamp: Date.now(),
        timeout,
      });
    }
  }

  private commitOptimistic(id: string): void {
    const update = this.optimisticUpdates.get(id);
    if (update) {
      clearTimeout(update.timeout);
      this.optimisticUpdates.delete(id);
    }
  }

  private revertOptimistic(id: string): void {
    const update = this.optimisticUpdates.get(id);
    if (update) {
      clearTimeout(update.timeout);
      this.state.value = update.original;
      this.optimisticUpdates.delete(id);
    }
  }

  private async fetchSnapshot(since?: number): Promise<void> {
    this.loading.value = true;
    this.error.value = null;

    try {
      const callData =
        this.options.sessionId !== 'global'
          ? since !== undefined
            ? { sessionId: this.options.sessionId, since }
            : { sessionId: this.options.sessionId }
          : since !== undefined
            ? { since }
            : {};

      const snapshot = await this.hub.request<T>(this.channelName, callData);

      if (since !== undefined && since > 0) {
        this.mergeSnapshot(snapshot);
      } else {
        this.state.value = snapshot;
      }

      if (snapshot && typeof snapshot === 'object' && 'timestamp' in snapshot) {
        this.lastSync.value = (snapshot as { timestamp: number }).timestamp;
      } else {
        this.lastSync.value = Date.now();
      }

      this.log(`Snapshot fetched: ${this.channelName}`, snapshot);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.error.value = error;
      this.log(`Snapshot fetch failed: ${this.channelName}`, error);
      throw error;
    } finally {
      this.loading.value = false;
    }
  }

  private mergeSnapshot(snapshot: T): void {
    const current = this.state.value;

    if (
      current &&
      typeof current === 'object' &&
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'sdkMessages' in current &&
      'sdkMessages' in snapshot
    ) {
      const currentMessages = (current as Record<string, unknown>).sdkMessages;
      const snapshotMessages = (snapshot as Record<string, unknown>).sdkMessages;

      if (Array.isArray(currentMessages) && Array.isArray(snapshotMessages)) {
        const merged = this.mergeSdkMessages(
          currentMessages as Array<Record<string, unknown>>,
          snapshotMessages as Array<Record<string, unknown>>
        );
        this.state.value = {
          ...(snapshot as object),
          sdkMessages: merged,
        } as T;
        return;
      }
    }

    this.state.value = snapshot;
  }

  private mergeSdkMessages(
    existing: Array<Record<string, unknown>>,
    incoming: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();

    for (const msg of existing) {
      const id = msg.uuid as string;
      if (id) {
        map.set(id, msg);
      }
    }

    for (const msg of incoming) {
      const id = msg.uuid as string;
      if (id) {
        map.set(id, msg);
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      const timeA = (a.timestamp as number) || 0;
      const timeB = (b.timestamp as number) || 0;
      return timeA - timeB;
    });
  }

  private async setupSubscriptions(): Promise<void> {
    const unsubFull = this.hub.onEvent<T>(this.channelName, (data) => {
      this.log(`Full update received: ${this.channelName}`, data);
      batch(() => {
        this.state.value = data;
        this.lastSync.value = Date.now();
        this.error.value = null;
      });
    });
    this.subscriptions.push(unsubFull);

    if (this.options.enableDeltas && this.options.mergeDelta) {
      const deltaChannel = `${this.channelName}.delta`;
      this.log(`Subscribing to delta channel: ${deltaChannel}`);

      const unsubDelta = this.hub.onEvent<unknown>(deltaChannel, (delta) => {
        this.log(`Delta update received: ${this.channelName}`, delta);

        if (this.state.value && this.options.mergeDelta) {
          batch(() => {
            this.state.value = this.options.mergeDelta!(this.state.value!, delta);
            this.lastSync.value = Date.now();
            this.error.value = null;
          });
        }
      });
      this.subscriptions.push(unsubDelta);
    }

    this.log(`Subscriptions setup complete: ${this.subscriptions.length} subscriptions`);
  }

  private setupOptimisticSubscriptions(): void {
    const fullUpdateSub = this.hub.onEvent<T>(this.channelName, (data) => {
      this.log(`Full update received: ${this.channelName}`, data);
      batch(() => {
        this.state.value = data;
        this.lastSync.value = Date.now();
        this.error.value = null;
      });
    });

    this.subscriptions.push(fullUpdateSub);

    if (this.options.enableDeltas && this.options.mergeDelta) {
      const deltaChannel = `${this.channelName}.delta`;
      this.log(`Subscribing (optimistic) to delta channel: ${deltaChannel}`);

      const deltaUpdateSub = this.hub.onEvent<unknown>(deltaChannel, (delta) => {
        this.log(`Delta update received: ${this.channelName}`, delta);

        if (this.state.value && this.options.mergeDelta) {
          batch(() => {
            this.state.value = this.options.mergeDelta!(this.state.value!, delta);
            this.lastSync.value = Date.now();
            this.error.value = null;
          });
        } else {
        }
      });

      this.subscriptions.push(deltaUpdateSub);
    }

    this.log(`Optimistic subscriptions setup complete`);
  }

  private setupAutoRefresh(): void {
    if (!this.options.refreshInterval) return;

    this.refreshTimer = setInterval(() => {
      if (this.isStale(this.options.refreshInterval!)) {
        this.log(`Auto-refreshing stale channel: ${this.channelName}`);
        this.refresh().catch(() => {});
      }
    }, this.options.refreshInterval);
  }

  private setupReconnectionHandler(): void {
    const reconnectSub = this.hub.onConnection((state) => {
      if (state === 'connected') {
        this.log(`Reconnected, performing hybrid refresh: ${this.channelName}`);
        this.hybridRefresh().catch(() => {});
      } else if (state === 'disconnected' || state === 'error') {
        this.error.value = new Error(`Connection ${state}`);
      }
    });

    this.subscriptions.push(reconnectSub);
  }

  private async hybridRefresh(): Promise<void> {
    this.log(`Reconnected, fetching full snapshot`);

    try {
      await this.fetchSnapshot();
      this.log(`Full sync completed`);
    } catch (err) {
      this.log(`Full sync failed`, err);
      throw err;
    }
  }

  private log(_message: string, ..._args: unknown[]): void {}
}

export const DeltaMergers = {
  array: <T extends { id: string }>(
    current: T[],
    delta: {
      added?: T[];
      updated?: T[];
      removed?: string[];
    }
  ): T[] => {
    let result = [...current];

    if (delta.removed) {
      result = result.filter((item) => !delta.removed!.includes(item.id));
    }

    if (delta.updated) {
      delta.updated.forEach((updated) => {
        const index = result.findIndex((item) => item.id === updated.id);
        if (index !== -1) {
          result[index] = updated;
        }
      });
    }

    if (delta.added) {
      result.unshift(...delta.added);
    }

    return result;
  },

  object: <T extends Record<string, unknown>>(current: T, delta: Partial<T>): T => {
    return { ...current, ...delta };
  },

  append: <T>(current: T[], delta: { added?: T[] }): T[] => {
    if (delta.added) {
      return [...current, ...delta.added];
    }
    return current;
  },
};
