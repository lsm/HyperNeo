import { signal, computed } from '@preact/signals';
import type {
  Session,
  AuthStatus,
  HealthStatus,
  SystemState,
  SettingsState,
  CredentialStoreStatus,
} from '@hyperneo/shared';
import type { LiveQueryDeltaEvent, LiveQuerySnapshotEvent } from '@hyperneo/shared';
import { STATE_CHANNELS } from '@hyperneo/shared';
import type { GlobalSettings } from '@hyperneo/shared/types/settings';
import { connectionManager } from './connection-manager';

const SESSIONS_SUBSCRIPTION_ID = 'sessions-list';

export class GlobalStore {
  readonly sessions = signal<Session[]>([]);

  readonly sessionsTotalCount = signal<number>(0);

  readonly archivedSessionCount = signal<number>(0);

  readonly hasArchivedSessions = computed<boolean>(
    () =>
      this.archivedSessionCount.value > 0 ||
      this.sessionsTotalCount.value > this.sessions.value.length
  );

  readonly systemState = signal<SystemState | null>(null);

  readonly settings = signal<GlobalSettings | null>(null);

  readonly authStatus = computed<AuthStatus | null>(() => this.systemState.value?.auth || null);

  readonly healthStatus = computed<HealthStatus | null>(
    () => this.systemState.value?.health || null
  );

  readonly sessionCount = computed<number>(() => this.sessions.value.length);

  readonly recentSessions = computed<Session[]>(() => {
    return [...this.sessions.value]
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
      .slice(0, 5);
  });

  readonly activeSessions = computed<Session[]>(() => {
    return this.sessions.value.filter((s) => s.status === 'active');
  });

  readonly apiConnectionStatus = computed<'connected' | 'degraded' | 'disconnected'>(
    () => this.systemState.value?.apiConnection?.status || 'connected'
  );

  readonly credentialStoreStatus = computed<CredentialStoreStatus | null>(
    () => this.systemState.value?.credentialStore || null
  );

  private cleanupFunctions: Array<() => void> = [];

  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const hub = await connectionManager.getHub();

      this.subscribeSessions(hub);

      const unsubSystem = hub.onEvent<SystemState>(STATE_CHANNELS.GLOBAL_SYSTEM, (state) => {
        this.systemState.value = state;
      });
      this.cleanupFunctions.push(unsubSystem);

      const unsubSettings = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, (state) => {
        this.settings.value = state.settings || null;
      });
      this.cleanupFunctions.push(unsubSettings);

      this.initialized = true;

      const snapshot = await hub.request<{
        system: SystemState;
        settings: SettingsState;
      }>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});
      if (snapshot) {
        this.systemState.value = snapshot.system || null;
        this.settings.value = snapshot.settings?.settings || null;
      }
    } catch {}
  }

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

    const unsubReconnect = hub.onConnection((state) => {
      if (state !== 'connected') return;
      doSubscribe();
    });
    this.cleanupFunctions.push(unsubReconnect);

    let prevShowArchived = this.settings.value?.showArchived ?? false;
    this.cleanupFunctions.push(() => {});
    const checkSetting = (): void => {
      const current = this.settings.value?.showArchived ?? false;
      if (current !== prevShowArchived) {
        prevShowArchived = current;
        doSubscribe();
      }
    };

    const unsubSettings = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, () => {
      queueMicrotask(checkSetting);
    });
    this.cleanupFunctions.push(unsubSettings);

    doSubscribe();
  }

  private applySessionsDelta(event: LiveQueryDeltaEvent): void {
    const next = new Map(this.sessions.value.map((s) => [s.id, s]));

    for (const row of (event.removed ?? []) as Session[]) next.delete(row.id);
    for (const row of (event.updated ?? []) as Session[]) next.set(row.id, row);
    for (const row of (event.added ?? []) as Session[]) next.set(row.id, row);

    this.sessions.value = [...next.values()];
  }

  async refresh(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const hub = await connectionManager.getHub();

    const showArchived = this.settings.value?.showArchived ?? false;
    hub
      .request('liveQuery.subscribe', {
        queryName: 'sessions.list',
        params: [showArchived ? 1 : 0],
        subscriptionId: SESSIONS_SUBSCRIPTION_ID,
      })
      .catch(() => {});

    const snapshot = await hub.request<{
      system: SystemState;
      settings: SettingsState;
    }>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

    if (snapshot) {
      this.systemState.value = snapshot.system || null;
      this.settings.value = snapshot.settings?.settings || null;
    }
  }

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
      } catch {}
    }
    this.cleanupFunctions = [];
    this.initialized = false;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.value.find((s) => s.id === sessionId);
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    this.sessions.value = this.sessions.value.map((s) =>
      s.id === sessionId ? { ...s, ...updates } : s
    );
  }

  removeSession(sessionId: string): void {
    this.sessions.value = this.sessions.value.filter((s) => s.id !== sessionId);
  }

  addSession(session: Session): void {
    this.sessions.value = [...this.sessions.value, session];
  }
}

export const globalStore = new GlobalStore();
