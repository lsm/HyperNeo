import { signal, computed, type Signal } from '@preact/signals';
import type { MessageHub } from '@hyperneo/shared';
import type { Session, AuthStatus, HealthStatus, ContextInfo } from '@hyperneo/shared';
import type {
  SystemState,
  SessionState,
  SDKMessagesState,
  AgentProcessingState,
  SDKMessagesUpdate,
  ChatMessage,
  CredentialStoreStatus,
} from '@hyperneo/shared';
import { STATE_CHANNELS } from '@hyperneo/shared';
import { StateChannel } from './state-channel';
import { globalStore } from './global-store';

export function mergeSdkMessagesWithDedup(
  existing: ChatMessage[],
  added: ChatMessage[] | undefined
): ChatMessage[] {
  if (!added || added.length === 0) {
    return existing;
  }

  const map = new Map<string, ChatMessage>();

  for (const msg of existing) {
    const msgWithUuid = msg as ChatMessage & { uuid?: string };
    if (msgWithUuid.uuid) {
      map.set(msgWithUuid.uuid, msg);
    }
  }

  for (const msg of added) {
    const msgWithUuid = msg as ChatMessage & { uuid?: string };
    if (msgWithUuid.uuid) {
      map.set(msgWithUuid.uuid, msg);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const timeA = (a as ChatMessage & { timestamp?: number }).timestamp || 0;
    const timeB = (b as ChatMessage & { timestamp?: number }).timestamp || 0;
    return timeA - timeB;
  });
}

export function mergeSDKMessagesDelta(current: SDKMessagesState, delta: unknown): SDKMessagesState {
  const typedDelta = delta as SDKMessagesUpdate;
  return {
    ...current,
    sdkMessages: mergeSdkMessagesWithDedup(current.sdkMessages, typedDelta.added),
    timestamp: typedDelta.timestamp,
  };
}

class SessionStateChannels {
  session: StateChannel<SessionState>;

  sdkMessages: StateChannel<SDKMessagesState>;

  constructor(
    private hub: MessageHub,
    private sessionId: string
  ) {
    this.session = new StateChannel<SessionState>(hub, STATE_CHANNELS.SESSION, {
      sessionId,
      enableDeltas: false,
      debug: false,
    });

    this.sdkMessages = new StateChannel<SDKMessagesState>(
      hub,
      STATE_CHANNELS.SESSION_SDK_MESSAGES,
      {
        sessionId,
        enableDeltas: true,
        mergeDelta: mergeSDKMessagesDelta,
        debug: false,
      }
    );
  }

  async start(): Promise<void> {
    await Promise.all([this.session.start(), this.sdkMessages.start()]);
  }

  async refresh(): Promise<void> {
    await Promise.all([this.session.refresh(), this.sdkMessages.refresh()]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.session.stop(), this.sdkMessages.stop()]);
  }
}

class ApplicationState {
  private hub: MessageHub | null = null;
  private initialized = signal(false);

  private activeSessionId: string | null = null;
  private activeSessionChannels: SessionStateChannels | null = null;

  private currentSessionIdSignal = signal<string | null>(null);

  private subscriptions: Array<() => void> = [];

  async initialize(hub: MessageHub, currentSessionId: Signal<string | null>): Promise<void> {
    if (this.initialized.value) {
      return;
    }

    this.hub = hub;
    this.currentSessionIdSignal = currentSessionId;

    this.setupCurrentSessionAutoLoad();

    this.initialized.value = true;
  }

  getSessionChannels(sessionId: string): SessionStateChannels {
    if (!this.hub) {
      throw new Error('State not initialized');
    }

    if (this.activeSessionId === sessionId && this.activeSessionChannels) {
      return this.activeSessionChannels;
    }

    const previousChannels = this.activeSessionChannels;

    const channels = new SessionStateChannels(this.hub, sessionId);
    this.activeSessionId = sessionId;
    this.activeSessionChannels = channels;

    (async () => {
      if (previousChannels) {
        await previousChannels.stop();
      }

      await channels.start();
    })().catch(() => {});

    return channels;
  }

  async cleanupSessionChannels(sessionId: string): Promise<void> {
    if (this.activeSessionId === sessionId && this.activeSessionChannels) {
      await this.activeSessionChannels.stop();
      this.activeSessionId = null;
      this.activeSessionChannels = null;
    }
  }

  private setupCurrentSessionAutoLoad(): void {
    let previousSessionId: string | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 150;

    const unsub = this.currentSessionIdSignal.subscribe((sessionId: string | null) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        (async () => {
          if (previousSessionId && previousSessionId !== sessionId) {
            await this.cleanupSessionChannels(previousSessionId);
          }

          if (sessionId) {
            this.getSessionChannels(sessionId);
          }

          previousSessionId = sessionId;
        })().catch(() => {});

        debounceTimer = null;
      }, DEBOUNCE_MS);
    });
    this.subscriptions.push(unsub);
  }

  async refreshAll(): Promise<void> {
    if (!this.initialized.value) {
      return;
    }

    if (this.activeSessionChannels) {
      await this.activeSessionChannels.refresh();
    }
  }

  cleanup(): void {
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];

    if (this.activeSessionChannels) {
      this.activeSessionChannels.stop().catch(() => {});
      this.activeSessionId = null;
      this.activeSessionChannels = null;
    }

    this.hub = null;
    this.initialized.value = false;
  }
}

export const appState = new ApplicationState();

/** @public - Preact signal accessed via .value in components */
export const sessions = computed<Session[]>(() => {
  return globalStore.sessions.value;
});

/** @public - Preact signal accessed via .value in components */
export const hasArchivedSessions = computed<boolean>(() => {
  return globalStore.hasArchivedSessions.value;
});

/** @public - Preact signal accessed via .value in components */
export const systemState = computed<SystemState | null>(() => {
  return globalStore.systemState.value;
});

/** @public - Preact signal accessed via .value in components */
export const authStatus = computed<AuthStatus | null>(() => {
  const system = systemState.value;
  return system?.auth || null;
});

/** @public - Preact signal accessed via .value in components */
export const healthStatus = computed<HealthStatus | null>(() => {
  const system = systemState.value;
  return system?.health || null;
});

/** @public - Preact signal accessed via .value in components */
export const apiConnectionStatus = computed<import('@hyperneo/shared').ApiConnectionState | null>(
  () => {
    const system = systemState.value;
    return system?.apiConnection || null;
  }
);

/** @public - Preact signal accessed via .value in components */
export const credentialStoreStatus = computed<CredentialStoreStatus | null>(() => {
  return globalStore.credentialStoreStatus.value;
});

/** @public - Preact signal accessed via .value in components */
export const globalSettings = computed<import('@hyperneo/shared').GlobalSettings | null>(() => {
  return globalStore.settings.value;
});

const currentSessionState = computed<SessionState | null>(() => {
  const sessionId = appState['currentSessionIdSignal'].value;
  if (!sessionId) return null;

  const channels = appState.getSessionChannels(sessionId);
  return channels.session.$.value || null;
});

/** @public - Preact signal accessed via .value in components */
export const currentSession = computed<Session | null>(() => {
  return currentSessionState.value?.sessionInfo || null;
});

/** @public - Preact signal accessed via .value in components */
export const currentAgentState = computed<AgentProcessingState>(() => {
  return currentSessionState.value?.agentState || { status: 'idle' };
});

/** @public - Preact signal accessed via .value in components */
export const currentContextInfo = computed<ContextInfo | null>(() => {
  return currentSessionState.value?.sessionInfo?.metadata?.lastContextInfo || null;
});

/** @public - Preact signal accessed via .value in components */
export const isAgentWorking = computed<boolean>(() => {
  const state = currentAgentState.value;
  return state.status === 'processing' || state.status === 'queued';
});

/** @public - Preact signal accessed via .value in components */
export const activeSessions = computed<number>(() => {
  return sessions.value.filter((s) => s.status === 'active').length;
});

/** @public - Preact signal accessed via .value in components */
export const recentSessions = computed<Session[]>(() => {
  return [...sessions.value]
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 5);
});

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting'
  | 'failed';
export const connectionState = signal<ConnectionState>('connecting');

export const reconnectAttemptCount = signal<number>(0);

export async function initializeApplicationState(
  hub: MessageHub,
  currentSessionId: Signal<string | null>
): Promise<void> {
  await appState.initialize(hub, currentSessionId);
}
