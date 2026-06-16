/**
 * Application State Management
 *
 * Architecture:
 * - Global state: Managed by globalStore (sessions, system, settings)
 * - Session state: Managed by SessionStateChannels (per-session data)
 * - Connection state: Managed by connectionState signal
 */

import { signal, computed, type Signal } from '@preact/signals';
import type { MessageHub } from '@neokai/shared';
import type { Session, AuthStatus, HealthStatus, ContextInfo } from '@neokai/shared';
import type {
  SystemState,
  SessionState,
  SDKMessagesState,
  AgentProcessingState,
  SDKMessagesUpdate,
  ChatMessage,
  CredentialStoreStatus,
} from '@neokai/shared';
import { STATE_CHANNELS } from '@neokai/shared';
import { StateChannel } from './state-channel';
import { globalStore } from './global-store';

/**
 * Merge SDK messages with deduplication by UUID
 *
 * Prevents duplicate messages during reconnection race conditions:
 * 1. Client reconnects, subscriptions re-established
 * 2. Snapshot fetch completes with messages [A, B, C, D]
 * 3. Delta event arrives with message D (already in snapshot)
 * 4. Without dedup: [A, B, C, D, D] - DUPLICATE!
 * 5. With dedup: [A, B, C, D] - correct
 *
 * @internal Exported for testing
 */
export function mergeSdkMessagesWithDedup(
  existing: ChatMessage[],
  added: ChatMessage[] | undefined
): ChatMessage[] {
  if (!added || added.length === 0) {
    return existing;
  }

  // Use Map for O(1) lookup by UUID
  const map = new Map<string, ChatMessage>();

  // Add existing messages first
  for (const msg of existing) {
    const msgWithUuid = msg as ChatMessage & { uuid?: string };
    if (msgWithUuid.uuid) {
      map.set(msgWithUuid.uuid, msg);
    }
  }

  // Add new messages (overwrites if UUID already exists — also handles
  // neokai_action messages being updated when the user resolves the prompt)
  for (const msg of added) {
    const msgWithUuid = msg as ChatMessage & { uuid?: string };
    if (msgWithUuid.uuid) {
      map.set(msgWithUuid.uuid, msg);
    }
  }

  // Convert back to array, preserving order by timestamp
  return Array.from(map.values()).sort((a, b) => {
    const timeA = (a as ChatMessage & { timestamp?: number }).timestamp || 0;
    const timeB = (b as ChatMessage & { timestamp?: number }).timestamp || 0;
    return timeA - timeB;
  });
}

/**
 * Merge function for SDK messages delta updates.
 * Handles delta updates by merging new messages with deduplication.
 *
 * @internal Exported for testing
 */
export function mergeSDKMessagesDelta(current: SDKMessagesState, delta: unknown): SDKMessagesState {
  const typedDelta = delta as SDKMessagesUpdate;
  return {
    ...current,
    // FIX: Deduplicate by UUID to prevent duplicates on reconnection
    // Race condition: delta events may arrive after snapshot fetch completes,
    // containing messages already in the snapshot
    sdkMessages: mergeSdkMessagesWithDedup(current.sdkMessages, typedDelta.added),
    timestamp: typedDelta.timestamp,
  };
}

/**
 * Session-Specific State Channels
 */
class SessionStateChannels {
  // Unified session state (metadata + agent + commands + context)
  session: StateChannel<SessionState>;

  // SDK Messages
  sdkMessages: StateChannel<SDKMessagesState>;

  constructor(
    private hub: MessageHub,
    private sessionId: string
  ) {
    // Unified session state channel
    this.session = new StateChannel<SessionState>(hub, STATE_CHANNELS.SESSION, {
      sessionId,
      enableDeltas: false,
      debug: false,
    });

    // SDK Messages channel
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

  /**
   * Start all session channels
   */
  async start(): Promise<void> {
    await Promise.all([this.session.start(), this.sdkMessages.start()]);
  }

  /**
   * Refresh all session channels (force fetch latest state from server)
   * Used after reconnection to ensure state is in sync
   */
  async refresh(): Promise<void> {
    await Promise.all([this.session.refresh(), this.sdkMessages.refresh()]);
  }

  /**
   * Stop all session channels
   *
   * IMPORTANT: Async to await all unsubscribe operations.
   * This ensures clean session switches without subscription accumulation.
   */
  async stop(): Promise<void> {
    await Promise.all([this.session.stop(), this.sdkMessages.stop()]);
  }
}

/**
 * Application State Manager
 *
 * Manages per-session state channels. Global state is handled by globalStore.
 */
class ApplicationState {
  private hub: MessageHub | null = null;
  private initialized = signal(false);

  // Active session channels - only ONE session can have channels at a time
  // This is the session whose chat container is currently displayed
  private activeSessionId: string | null = null;
  private activeSessionChannels: SessionStateChannels | null = null;

  // Current session ID (from existing signal)
  private currentSessionIdSignal = signal<string | null>(null);

  // Track subscriptions to prevent memory leaks
  private subscriptions: Array<() => void> = [];

  /**
   * Initialize state management with MessageHub
   *
   * Global state is handled by globalStore. This only sets up session channels.
   */
  async initialize(hub: MessageHub, currentSessionId: Signal<string | null>): Promise<void> {
    if (this.initialized.value) {
      return;
    }

    this.hub = hub;
    this.currentSessionIdSignal = currentSessionId;

    // Setup current session auto-loading
    this.setupCurrentSessionAutoLoad();

    this.initialized.value = true;
  }

  /**
   * Get or create session channels
   *
   * INVARIANT: Only ONE session can have active channels at any time.
   * This is the "current active session" whose chat container is displayed.
   *
   * Session data shown in lists (sidebar, recent sessions) should come from
   * globalStore.sessions, NOT per-session subscriptions.
   *
   * CRITICAL: Returns channels synchronously but initiates async cleanup/start.
   * The cleanup waits for all unsubscribe ACKs before starting new subscriptions,
   * preventing the subscription accumulation that caused rate limit errors.
   */
  getSessionChannels(sessionId: string): SessionStateChannels {
    if (!this.hub) {
      throw new Error('State not initialized');
    }

    // If requesting the same session, return existing channels
    if (this.activeSessionId === sessionId && this.activeSessionChannels) {
      return this.activeSessionChannels;
    }

    // Cleanup previous session's channels before creating new ones
    // CRITICAL: Must await stop() to ensure unsubscribes complete before new subscribes
    const previousChannels = this.activeSessionChannels;

    // Create new channels for the requested session (but don't start yet)
    const channels = new SessionStateChannels(this.hub, sessionId);
    this.activeSessionId = sessionId;
    this.activeSessionChannels = channels;

    // Async cleanup + start sequence (awaits unsubscribes before subscribes)
    (async () => {
      if (previousChannels) {
        await previousChannels.stop(); // AWAIT unsubscribes
      }

      // Now start new session's channels
      await channels.start();
    })().catch(() => {
      /* ignore errors during channel switch */
    });

    return channels;
  }

  /**
   * Cleanup session channels (when navigating away from a session)
   *
   * IMPORTANT: Async to await all unsubscribe operations.
   */
  async cleanupSessionChannels(sessionId: string): Promise<void> {
    if (this.activeSessionId === sessionId && this.activeSessionChannels) {
      await this.activeSessionChannels.stop();
      this.activeSessionId = null;
      this.activeSessionChannels = null;
    }
  }

  /**
   * Setup auto-loading of current session channels
   *
   * FIX: Cleanup previous session's channels when switching sessions.
   * This prevents subscription accumulation that caused the "subscription storm"
   * on reconnection. Only the ACTIVE session should have subscriptions.
   */
  private setupCurrentSessionAutoLoad(): void {
    let previousSessionId: string | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 150; // Debounce rapid session switches to prevent rate limit errors

    const unsub = this.currentSessionIdSignal.subscribe((sessionId: string | null) => {
      // Cancel any pending session switch
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      // Debounce the actual channel setup to prevent subscription storm on rapid switching
      debounceTimer = setTimeout(() => {
        (async () => {
          // CLEANUP: Stop previous session's channels before starting new ones
          // This prevents subscription accumulation across session switches
          if (previousSessionId && previousSessionId !== sessionId) {
            await this.cleanupSessionChannels(previousSessionId);
          }

          // START: Load channels for new current session
          if (sessionId) {
            this.getSessionChannels(sessionId);
          }

          previousSessionId = sessionId;
        })().catch(() => {
          /* ignore errors during session switch */
        });

        debounceTimer = null;
      }, DEBOUNCE_MS);
    });
    this.subscriptions.push(unsub);
  }

  /**
   * Refresh all state channels (force fetch latest state from server)
   * Used after reconnection validation to ensure state is in sync
   *
   * This is critical for the Safari background tab issue where the connection
   * may appear healthy but subscriptions are stale.
   */
  async refreshAll(): Promise<void> {
    if (!this.initialized.value) {
      return;
    }

    // Refresh current session channels
    if (this.activeSessionChannels) {
      await this.activeSessionChannels.refresh();
    }
  }

  /**
   * Cleanup all state
   *
   * NOTE: Fire-and-forget for stop() calls since this is final cleanup.
   * During session switching, proper await is done in getSessionChannels().
   */
  cleanup(): void {
    // Cleanup all signal subscriptions to prevent memory leaks
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];

    // Stop active session channels (fire-and-forget, we're shutting down)
    if (this.activeSessionChannels) {
      this.activeSessionChannels.stop().catch(() => {
        /* ignore errors during shutdown */
      });
      this.activeSessionId = null;
      this.activeSessionChannels = null;
    }

    this.hub = null;
    this.initialized.value = false;
  }
}

// Singleton instance
export const appState = new ApplicationState();

/**
 * Convenience signals - reactive accessors for UI components
 *
 * Global state is backed by globalStore. Session state uses SessionStateChannels.
 */

// Global state signals - delegating to globalStore
/** @public - Preact signal accessed via .value in components */
export const sessions = computed<Session[]>(() => {
  return globalStore.sessions.value;
});

/** @public - Preact signal accessed via .value in components */
export const hasArchivedSessions = computed<boolean>(() => {
  return globalStore.hasArchivedSessions.value;
});

// System state - delegating to globalStore
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
export const apiConnectionStatus = computed<import('@neokai/shared').ApiConnectionState | null>(
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
export const globalSettings = computed<import('@neokai/shared').GlobalSettings | null>(() => {
  return globalStore.settings.value;
});

// Current session signals (derived from currentSessionId)
// Internal-only: used by other computed signals below
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

/**
 * Derived/computed state
 */
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
  return sessions.value
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 5);
});

/**
 * Global WebSocket connection state
 * Single source of truth for the entire app
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting'
  | 'failed';
export const connectionState = signal<ConnectionState>('connecting');

/**
 * Tracks how many reconnect attempts have been made in the current cycle.
 * Reset to 0 on successful connection. Used by UI to show progressive
 * messaging ("Reconnecting…" vs "Connection lost. Retrying…").
 */
export const reconnectAttemptCount = signal<number>(0);

/**
 * Initialize application state
 */
export async function initializeApplicationState(
  hub: MessageHub,
  currentSessionId: Signal<string | null>
): Promise<void> {
  await appState.initialize(hub, currentSessionId);
}
