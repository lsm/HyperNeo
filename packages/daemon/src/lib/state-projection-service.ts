/**
 * StateProjectionService - Server-side state projection and read-model service
 *
 * Maintains authoritative state caches from internal events and serves
 * state snapshots via RPC handlers. All client delivery, side effects,
 * and event forwarding are handled by separate subscribers on the
 * InternalEventBus or by ClientEventBridge.
 *
 * ARCHITECTURE: Event-sourced state projection
 * - StateProjectionService maintains its own state from InternalEventBus events
 * - Publishers include their data in events (no fetching from sources)
 * - This ensures full decoupling between components via the event bus
 * - Broadcasts are triggered by separate subscribers, not by this service
 *
 * MIGRATION NOTE: This class was formerly `StateManager`. In M5 it was
 * split into a pure projection service (this file) plus bridge/gateway
 * services. See docs/plans/internal-event-command-query-architecture.md.
 */

import type { MessageHub, AgentProcessingState, IClientEventGateway } from '@hyperneo/shared';
import type { SessionManager } from './session-manager';
import type { AuthManager } from './auth-manager';
import type { SettingsManager } from './settings-manager';
import type { ProviderCredentialManager } from './credentials/provider-credential-manager';
import type { Config } from '../config';
import type { Database } from '../storage/database';
import type { ReactiveDatabase } from '../storage/reactive-database';
import { Logger } from './logger';
import type {
  SessionsState,
  SystemState,
  SettingsState,
  GlobalStateSnapshot,
  SessionStateSnapshot,
  SessionState,
  SDKMessagesState,
  SDKMessagesUpdate,
} from '@hyperneo/shared';
import type { Session } from '@hyperneo/shared';
import { ClientEventGateway, STATE_CHANNELS } from '@hyperneo/shared';
import { SDKMessageRepository } from '../storage/repositories/sdk-message-repository';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus';
import { sanitizeGlobalSettings } from './rpc-handlers/settings-handlers';

const VERSION = '0.1.1';
const CLAUDE_SDK_VERSION = '0.1.37';
const startTime = Date.now();

export class StateProjectionService {
  // FIX: Per-channel versioning instead of global version
  private channelVersions = new Map<string, number>();
  /**
   * Per-session capture-order revision counter, incremented inside
   * getSessionState BEFORE its `await getSlashCommands()` gap. Both the
   * state.session RPC and the state.session broadcast flow through
   * getSessionState, so each captured snapshot gets a unique increasing
   * revision reflecting data-freshness (capture order) — NOT trigger or send
   * order. The client compares these to order updates correctly when network
   * arrival order diverges from capture order (an older broadcast captured
   * before the await can send after a newer RPC). Distinct from
   * channelVersions (trigger-time, broadcasts only) to avoid disturbing
   * existing snapshot/meta versioning.
   */
  private sessionRevisions = new Map<string, number>();
  /**
   * Per-boot epoch identifying this daemon instance. The capture-order
   * `sessionRevisions` counter is in-memory and resets to 1 on a daemon
   * restart, so the client must recognize a new daemon instance and reset its
   * revision gate — otherwise it discards every post-restart snapshot (low
   * revision <= its stale high watermark) and freezes. Generated once per
   * instance (constructor) so it changes on every boot. Carried on every
   * state.session emission alongside `revision`.
   */
  private readonly bootEpoch: string;
  private logger = new Logger('StateProjectionService');

  /**
   * Client-facing event gateway.
   *
   * Wraps `messageHub.event(...)` so daemon code can publish via a typed
   * `EventChannel` instead of inline `{ channel: 'global' }` literals. Only a
   * minimal slice of forwarding currently flows through the gateway —
   * `session.created`, `session.deleted`, and `context.updated` — as a
   * proof-of-pattern. Versioned state broadcasts continue to call
   * `messageHub.event(...)` directly until per-channel versioning moves
   * onto the gateway in a follow-up PR.
   *
   * See `docs/plans/internal-event-command-query-architecture.md`.
   */
  private clientEvents: IClientEventGateway;

  // Track API connection state (updated via broadcasts from ErrorManager)
  private apiConnectionState: import('@hyperneo/shared').ApiConnectionState = {
    status: 'connected',
    timestamp: Date.now(),
  };

  // Event-sourced state caches (updated from InternalEventBus events)
  // This enables full decoupling - StateProjectionService doesn't fetch from AgentSession
  private sessionCache = new Map<string, Session>();
  private processingStateCache = new Map<string, AgentProcessingState>();
  private commandsCache = new Map<string, string[]>();
  private errorCache = new Map<
    string,
    { message: string; details?: unknown; occurredAt: number } | null
  >();

  constructor(
    private messageHub: MessageHub,
    private sessionManager: SessionManager,
    private authManager: AuthManager,
    private settingsManager: SettingsManager,
    private config: Config,
    private db?: Database,
    private internalEventBus?: InternalEventBus<DaemonInternalEventMap>,
    clientEvents?: IClientEventGateway,
    private credentialManager?: ProviderCredentialManager,
    private reactiveDb?: ReactiveDatabase
  ) {
    this.clientEvents = clientEvents ?? new ClientEventGateway({ hub: messageHub });
    // Per-boot instance id: changes on every daemon (re)start so clients can
    // reset their in-memory revision gate when the daemon's counter restarts.
    this.bootEpoch = crypto.randomUUID();
    this.setupHandlers();
    this.setupEventBusSubscriptions();
  }

  /**
   * Expose the client event gateway so ClientEventBridge can share it.
   *
   * This is a temporary seam while forwarding migrates out of
   * StateProjectionService. Once all forwarding lives in the bridge, the
   * gateway can be constructed in DaemonApp and injected into both
   * StateProjectionService and ClientEventBridge.
   */
  getClientEventGateway(): IClientEventGateway {
    return this.clientEvents;
  }

  /**
   * Subscribe to InternalEventBus for state-cache updates.
   *
   * ARCHITECTURE: Event-sourced state projection
   * - Publishers include their data in events
   * - StateProjectionService caches this data (no fetching from sources)
   * - Broadcasts are triggered by separate subscribers, not this service
   *
   * All InternalEventBus<DaemonInternalEventMap> listeners for state-cache concerns have been migrated to
   * InternalEventBus subscriptions. Client delivery is fully handled by
   * ClientEventBridge.
   */
  private setupEventBusSubscriptions(): void {
    if (!this.internalEventBus) {
      this.logger.warn(
        'No InternalEventBus provided; state projection will not receive cache updates'
      );
      return;
    }

    // API connection state updates from ErrorManager
    this.internalEventBus.subscribe(
      'api.connection',
      (data) => {
        this.apiConnectionState = data as import('@hyperneo/shared').ApiConnectionState;
      },
      { subscriberName: 'StateProjectionService.apiConnection' }
    );

    // Session created - cache only
    this.internalEventBus.subscribe(
      'session.created',
      (data) => {
        const { session } = data as unknown as { session: Session };
        this.sessionCache.set(session.id, session);
        this.processingStateCache.set(session.id, { status: 'idle' });
      },
      { subscriberName: 'StateProjectionService.sessionCreated' }
    );

    // Session updated - update cache from event data
    this.internalEventBus.subscribe(
      'session.updated',
      async (data) => {
        const { sessionId, session, processingState } = data as unknown as {
          sessionId: string;
          session?: Partial<Session>;
          processingState?: AgentProcessingState;
        };

        // Update caches from event data (decoupled - no fetching)
        // FIX: Only merge into existing cache entries, don't create new entries from partial data
        // This prevents sidebar cost display from resetting to $0.00 when clicking sessions.
        // Initial full session data comes from getSessionsState() which reads from DB.
        if (session) {
          const existing = this.sessionCache.get(sessionId);
          if (existing) {
            this.sessionCache.set(sessionId, { ...existing, ...session });
          }
          // Skip storing partial session data if no existing entry - broadcastSessionUpdateFromCache
          // will handle this case by skipping the broadcast
        }
        if (processingState) {
          this.processingStateCache.set(sessionId, processingState);
        }

        // Trigger broadcast via separate subscriber path
        await this.broadcastSessionUpdateFromCache(sessionId);
      },
      { subscriberName: 'StateProjectionService.sessionUpdated' }
    );

    // Session deleted - clear caches and channelVersions
    this.internalEventBus.subscribe(
      'session.deleted',
      (data) => {
        const { sessionId } = data as unknown as { sessionId: string };

        // Clear caches
        this.sessionCache.delete(sessionId);
        this.processingStateCache.delete(sessionId);
        this.commandsCache.delete(sessionId);
        this.errorCache.delete(sessionId);

        // FIX: Clean up channelVersions for deleted session
        this.channelVersions.delete(`${STATE_CHANNELS.SESSION}:${sessionId}`);
        this.channelVersions.delete(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${sessionId}`);
        this.channelVersions.delete(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${sessionId}`);
        this.sessionRevisions.delete(sessionId);
      },
      { subscriberName: 'StateProjectionService.sessionDeleted' }
    );

    // Settings events
    this.internalEventBus.subscribe(
      'settings.updated',
      async () => {
        await this.broadcastSettingsChange();
      },
      { subscriberName: 'StateProjectionService.settingsUpdated' }
    );

    // Commands updated - cache only
    this.internalEventBus.subscribe(
      'commands.updated',
      (data) => {
        const { sessionId, commands } = data as unknown as {
          sessionId: string;
          commands: string[];
        };
        this.commandsCache.set(sessionId, commands);
      },
      { subscriberName: 'StateProjectionService.commandsUpdated' }
    );

    // Session error events - cache only
    this.internalEventBus.subscribe(
      'session.error',
      (data) => {
        const { sessionId, error, details } = data as unknown as {
          sessionId: string;
          error: string;
          details?: unknown;
        };
        this.errorCache.set(sessionId, {
          message: error,
          details,
          occurredAt: Date.now(),
        });
        // Persist a small snapshot to the session row so DB-backed read models
        // (the Space task thread's activity LiveQuery) can surface actionable
        // errors — e.g. a re-authenticate affordance for PROVIDER_AUTH_ERROR —
        // without a separate per-session subscription. Mirrors the in-memory
        // cache lifecycle (cleared on `session.errorClear`).
        this.persistSessionError(sessionId, details);
      },
      { subscriberName: 'StateProjectionService.sessionError' }
    );

    // Clear error when session becomes idle or processing continues successfully
    this.internalEventBus.subscribe(
      'session.errorClear',
      (data) => {
        const { sessionId } = data as unknown as { sessionId: string };
        this.errorCache.set(sessionId, null);
        this.persistSessionError(sessionId, null);
      },
      { subscriberName: 'StateProjectionService.sessionErrorClear' }
    );
  }

  /**
   * Persist (or clear) the active session error snapshot on the session row.
   *
   * Writes a small JSON snapshot `{ category, message, providerId? }` derived
   * from the structured error so DB-backed read models (the Space task thread
   * activity LiveQuery) can surface actionable errors reactively. Passing
   * `null` clears the column (mirrors `session.errorClear`).
   *
   * Best-effort: a DB write failure must never break the in-memory cache
   * update or the subsequent state broadcast — every path is guarded and
   * logs at most a warning.
   */
  private persistSessionError(sessionId: string, details: unknown): void {
    if (!this.db) return;
    try {
      const db = this.db.getDatabase();
      if (!details) {
        db.prepare('UPDATE sessions SET last_error = NULL WHERE id = ?').run(sessionId);
        // The write bypasses the ReactiveDatabase proxy, so notify explicitly
        // — otherwise the activity LiveQuery wouldn't re-evaluate on a clear
        // that isn't accompanied by a state-machine transition.
        this.reactiveDb?.notifyChange('sessions');
        return;
      }
      const err = details as {
        category?: unknown;
        userMessage?: unknown;
        message?: unknown;
        metadata?: Record<string, unknown> | undefined;
      };
      const category = typeof err.category === 'string' ? err.category : null;
      if (!category) return;
      const message =
        (typeof err.userMessage === 'string' && err.userMessage) ||
        (typeof err.message === 'string' && err.message) ||
        '';
      const providerIdRaw = err.metadata?.providerId;
      const snapshot: Record<string, unknown> = { category, message };
      if (typeof providerIdRaw === 'string') snapshot.providerId = providerIdRaw;
      db.prepare('UPDATE sessions SET last_error = ? WHERE id = ?').run(
        JSON.stringify(snapshot),
        sessionId
      );
      // See above: bypasses the proxy, so notify the LiveQuery engine directly.
      this.reactiveDb?.notifyChange('sessions');
    } catch (err) {
      this.logger.warn(`Failed to persist session error for ${sessionId}:`, err);
    }
  }

  /**
   * Broadcast session update from cached state (event-sourced)
   *
   * ARCHITECTURE: No debouncing, no fetching from AgentSession
   * - Uses cached state from InternalEventBus events
   * - Broadcasts immediately (LLM processing is slow enough)
   * - Full decoupling via InternalEventBus
   */
  private async broadcastSessionUpdateFromCache(sessionId: string): Promise<void> {
    try {
      // CRITICAL: Always broadcast session state change, even if session is not cached
      // This ensures agent state (stop/send button) is always in sync with server
      // broadcastSessionStateChange has a fallback mechanism using cached processing state
      await this.broadcastSessionStateChange(sessionId);

      // Note: Global sessions list updates are now handled by LiveQuery (sessions.list)
      // which automatically detects DB changes via SQLite triggers.
    } catch (error) {
      // Session may have been deleted during update
      this.logger.warn(`Failed to broadcast session update for ${sessionId}:`, error);
    }
  }

  /**
   * FIX: Get and increment version for a specific channel
   */
  private incrementVersion(channel: string): number {
    const current = this.channelVersions.get(channel) || 0;
    const next = current + 1;
    this.channelVersions.set(channel, next);
    return next;
  }

  /**
   * Read-and-increment the per-session capture-order revision. Called inside
   * getSessionState before its async gap so every captured snapshot (RPC or
   * broadcast) gets a unique revision reflecting data-freshness. See
   * sessionRevisions docs.
   */
  private nextSessionRevision(sessionId: string): number {
    const current = this.sessionRevisions.get(sessionId) || 0;
    const next = current + 1;
    this.sessionRevisions.set(sessionId, next);
    return next;
  }

  /**
   * Setup RPC handlers for state snapshots
   */
  private setupHandlers(): void {
    // Global state snapshot
    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
      return await this.getGlobalSnapshot();
    });

    // Session state snapshot
    this.messageHub.onRequest(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSessionSnapshot(sessionId);
    });

    // Unified system state handler
    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SYSTEM, async () => {
      return await this.getSystemState();
    });

    // Individual channel requests (for on-demand refresh)
    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
      return await this.getSessionsState();
    });

    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SETTINGS, async () => {
      return await this.getSettingsState();
    });

    // Session-specific channel requests
    this.messageHub.onRequest(STATE_CHANNELS.SESSION, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSessionState(sessionId);
    });

    this.messageHub.onRequest(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
      const { sessionId, since } = data as {
        sessionId: string;
        since?: number;
      };
      return await this.getSDKMessagesState(sessionId, since);
    });
  }

  // ========================================
  // Global State Getters
  // ========================================

  /**
   * Get full global state snapshot
   */
  async getGlobalSnapshot(): Promise<GlobalStateSnapshot> {
    const [sessions, system, settings] = await Promise.all([
      this.getSessionsState(),
      this.getSystemState(),
      this.getSettingsState(),
    ]);

    return {
      sessions,
      system,
      settings,
      meta: {
        channel: 'global',
        sessionId: 'global',
        lastUpdate: Date.now(),
        version: this.channelVersions.get('global') || 0,
      },
    };
  }

  /**
   * Get unified system state (auth + config + health + API connection)
   * NEW: Replaces individual getAuthState/getConfigState/getHealthState
   */
  private async getSystemState(): Promise<SystemState> {
    const authStatus = await this.authManager.getAuthStatus();

    return {
      // Version & build info
      version: VERSION,
      claudeSDKVersion: CLAUDE_SDK_VERSION,

      // Configuration
      defaultModel: this.config.defaultModel,
      maxSessions: this.config.maxSessions,
      storageLocation: this.config.dbPath,
      workspaceRoot: this.config.workspaceRoot,

      // Authentication
      auth: authStatus,

      // System health
      health: {
        status: 'ok' as const,
        version: VERSION,
        uptime: Date.now() - startTime,
        sessions: {
          active: this.sessionManager.getActiveSessions(),
          total: this.sessionManager.getTotalSessions(),
        },
      },

      // API connectivity (daemon <-> Claude API)
      apiConnection: this.apiConnectionState,

      // Credential store health (surfaces Keychain-unavailable warning to UI)
      credentialStore: this.credentialManager?.getCredentialStoreStatus() ?? {
        backend: 'database',
        keychainAvailable: false,
      },

      timestamp: Date.now(),
    };
  }

  /**
   * Get global settings state
   */
  private async getSettingsState(): Promise<SettingsState> {
    // Sanitize so a legacy inline voice API key is never projected to clients
    // (keys are stored out-of-band in the credential manager).
    const settings = sanitizeGlobalSettings(
      this.settingsManager.getGlobalSettings(),
      this.credentialManager
    );
    return {
      settings,
      timestamp: Date.now(),
    };
  }

  private async getSessionsState(): Promise<SessionsState> {
    const settings = this.settingsManager.getGlobalSettings();

    // Check if there are any archived sessions in the database
    const allSessions = this.sessionManager.listSessions({ includeArchived: true });
    const hasArchivedSessions = allSessions.some((s) => s.status === 'archived');

    // Server-side filtering: only include archived when setting is enabled
    const sessions = settings.showArchived ? allSessions : this.sessionManager.listSessions();

    return {
      sessions,
      hasArchivedSessions,
      timestamp: Date.now(),
    };
  }

  // ========================================
  // Session State Getters
  // ========================================

  /**
   * Get full session state snapshot
   */
  async getSessionSnapshot(sessionId: string): Promise<SessionStateSnapshot> {
    const [session, sdkMessages] = await Promise.all([
      this.getSessionState(sessionId),
      this.getSDKMessagesState(sessionId),
    ]);

    return {
      session,
      sdkMessages,
      meta: {
        channel: 'session',
        sessionId,
        lastUpdate: Date.now(),
        version: this.channelVersions.get(`session:${sessionId}`) || 0,
      },
    };
  }

  /**
   * Get unified session state (metadata + agent + commands + context)
   * NEW: Replaces getSessionMetaState/getAgentState/getCommandsState/getContextState
   *
   * Context info is now populated with real-time token usage data from streaming.
   * During streaming, input_tokens from message_start represents total context consumption.
   */
  private async getSessionState(sessionId: string): Promise<SessionState> {
    const agentSession = await this.sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      // Special handling for DB-only sessions (no AgentSession):
      // - Room sessions (ID format: "room:{roomId}") — created when room agent starts
      // - Conversation sessions (ID format: "conv:{roomId}:...") — task group timelines
      if (sessionId.startsWith('room:') || sessionId.startsWith('conv:')) {
        return {
          sessionInfo: null,
          agentState: { status: 'idle' },
          commandsData: { availableCommands: [] },
          error: null,
          timestamp: Date.now(),
          revision: this.nextSessionRevision(sessionId),
          daemonEpoch: this.bootEpoch,
        };
      }
      throw new Error('Session not found');
    }

    // Stamp the capture-order revision BEFORE the data reads and the
    // `await getSlashCommands()` gap below, so this snapshot's revision reflects
    // when its data was captured (freshness), not when it is sent. See
    // sessionRevisions docs.
    const revision = this.nextSessionRevision(sessionId);

    // Get all session state in one place
    const sessionData = agentSession.getSessionData();
    // Prefer event-sourced processingStateCache over the session's in-memory state.
    // Task agent sessions are managed by SpaceRuntimeService but may be
    // loaded separately into SessionCache (as "ghosts") when state.session is fetched.
    // The ghost's in-memory processingState becomes stale once the live session changes
    // state. processingStateCache is always up-to-date via session.updated events.
    const agentState =
      this.processingStateCache.get(sessionId) ?? agentSession.getProcessingState();
    const commands = await agentSession.getSlashCommands();

    // Get error from cache (null if no error or error has been cleared)
    const error = this.errorCache.get(sessionId) || null;

    // Context info lives in sessionData.metadata.lastContextInfo
    // (persisted by ContextTracker, restored on session load)
    // No separate top-level field needed.

    return {
      sessionInfo: sessionData,
      agentState: agentState,
      commandsData: {
        availableCommands: commands,
      },
      error: error,
      timestamp: Date.now(),
      revision,
      daemonEpoch: this.bootEpoch,
    };
  }

  private async getSDKMessagesState(sessionId: string, since?: number): Promise<SDKMessagesState> {
    const agentSession = await this.sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      // DB-only sessions: read directly from sdk_messages table
      // - Room sessions (room:*) may have no messages yet
      // - Conversation sessions (conv:*) have mirrored messages
      if ((sessionId.startsWith('room:') || sessionId.startsWith('conv:')) && this.db) {
        const sdkMessageRepo = new SDKMessageRepository(this.db.getDatabase());
        const { messages: sdkMessages, hasMore } = sdkMessageRepo.getSDKMessages(
          sessionId,
          100,
          undefined,
          since
        );
        return { sdkMessages, hasMore, timestamp: Date.now() };
      }
      throw new Error('Session not found');
    }

    // Use 'since' for incremental sync on reconnection
    const { messages: sdkMessages, hasMore } = agentSession.getSDKMessages(100, undefined, since);

    return {
      sdkMessages,
      hasMore,
      timestamp: Date.now(),
    };
  }

  // ========================================
  // State Change Broadcasters
  // ========================================

  /**
   * Broadcast unified system state change (auth + config + health)
   * FIX: Uses per-channel versioning
   */
  async broadcastSystemChange(): Promise<void> {
    const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SYSTEM);
    const state = { ...(await this.getSystemState()), version };

    this.messageHub.event(STATE_CHANNELS.GLOBAL_SYSTEM, state, {
      channel: 'global',
    });
  }

  /**
   * Broadcast global settings change
   */
  async broadcastSettingsChange(): Promise<void> {
    const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SETTINGS);
    const state = { ...(await this.getSettingsState()), version };

    this.messageHub.event(STATE_CHANNELS.GLOBAL_SETTINGS, state, {
      channel: 'global',
    });
  }

  /**
   * Broadcast unified session state change (metadata + agent + commands + context)
   * NEW: Replaces broadcastSessionMetaChange/broadcastAgentStateChange/broadcastCommandsChange/broadcastContextChange
   * FIX: Uses per-channel versioning
   */
  async broadcastSessionStateChange(sessionId: string): Promise<void> {
    // Guard: an empty sessionId indicates an upstream event emitted without a
    // valid session (e.g. a provider error surfacing before session binding).
    // Broadcasting to `session:` with no ID is meaningless and throws inside
    // getSessionState() producing noisy "Session not found" warnings.
    if (!sessionId) {
      return;
    }

    const version = this.incrementVersion(`${STATE_CHANNELS.SESSION}:${sessionId}`);

    try {
      const state = { ...(await this.getSessionState(sessionId)), version };

      this.messageHub.event(STATE_CHANNELS.SESSION, state, {
        channel: `session:${sessionId}`,
      });
    } catch (error) {
      // Session may have been deleted or database may be closed during cleanup
      // This is expected behavior, don't throw
      // ALWAYS log to help diagnose state sync issues (e.g., button not updating after interrupt)
      this.logger.warn(
        `[StateProjectionService] Failed to broadcast session state for ${sessionId}:`,
        error instanceof Error ? error.message : error
      );

      // If we have cached processing state, try to broadcast a minimal state update
      // This ensures UI state (like stop/send button) stays in sync even if full state fetch fails
      const cachedProcessingState = this.processingStateCache.get(sessionId);
      const cachedSession = this.sessionCache.get(sessionId);
      if (cachedProcessingState && cachedSession) {
        try {
          const fallbackState = {
            sessionInfo: cachedSession,
            agentState: cachedProcessingState,
            commandsData: { availableCommands: this.commandsCache.get(sessionId) || [] },
            error: this.errorCache.get(sessionId) ?? null,
            timestamp: Date.now(),
            version,
            // Stamp the same ordering fields as the primary emission so the
            // client's revision/epoch gating covers this path too — otherwise
            // an undefined revision lets a concurrent stale RPC revert this
            // fresher fallback state.
            revision: this.nextSessionRevision(sessionId),
            daemonEpoch: this.bootEpoch,
          };
          this.messageHub.event(STATE_CHANNELS.SESSION, fallbackState, {
            channel: `session:${sessionId}`,
          });
        } catch (fallbackError) {
          this.logger.error(
            `[StateProjectionService] Fallback broadcast also failed for ${sessionId}:`,
            fallbackError instanceof Error ? fallbackError.message : fallbackError
          );
        }
      }
    }
  }

  /**
   * Broadcast SDK messages change
   * FIX: Uses per-channel versioning
   */
  async broadcastSDKMessagesChange(sessionId: string): Promise<void> {
    const version = this.incrementVersion(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${sessionId}`);
    const state = { ...(await this.getSDKMessagesState(sessionId)), version };

    this.messageHub.event(STATE_CHANNELS.SESSION_SDK_MESSAGES, state, {
      channel: `session:${sessionId}`,
    });
  }

  /**
   * Broadcast SDK messages delta (single new message)
   * Only sends delta - clients not subscribed to deltas should subscribe to full channel
   * FIX: Uses per-channel versioning
   */
  async broadcastSDKMessagesDelta(sessionId: string, update: SDKMessagesUpdate): Promise<void> {
    const version = this.incrementVersion(
      `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${sessionId}`
    );
    this.messageHub.event(
      `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
      { ...update, version },
      { channel: `session:${sessionId}` }
    );
  }
}
